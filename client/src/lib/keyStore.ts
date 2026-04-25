/**
 * Signed Pre-Keys & One-Time Pre-Keys, gebunden an die Konto-Identität
 * (dieselbe X25519-Box-Identität wie bei Registrierung, nicht separater Random-Key).
 */
import { base64FromUint8, uint8FromBase64 } from "./b64";
import { metaGet, metaSet } from "./idb";
import { getSodium, sodiumReady } from "./sodium";

const enc = new TextEncoder();

const META_KEY = "keyMaterialV1";

export type LocalKeyMaterial = {
  signedPreKey: {
    keyId: number;
    sk: string;
    pk: string;
    signature: string;
    signingPublicKey: string;
  };
  oneTimePreKeys: Array<{ keyId: number; sk: string; pk: string }>;
};

export async function loadKeyMaterial(): Promise<LocalKeyMaterial | null> {
  const raw = await metaGet(META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LocalKeyMaterial;
  } catch {
    return null;
  }
}

export async function saveKeyMaterial(km: LocalKeyMaterial): Promise<void> {
  await metaSet(META_KEY, JSON.stringify(km));
}

/**
 * Generiert/rotiert Material für `POST /api/keys` — Signatur der Signed-Pre-Key
 * via aus der Identität abgeleitetem Ed25519-Key (wie in eurer Desktop-Version).
 */
export async function generateKeyMaterial(
  identitySk: Uint8Array
): Promise<LocalKeyMaterial> {
  await sodiumReady();
  const sodium = getSodium();
  const signedPreKeyKp = sodium.crypto_box_keypair();
  /** Ed25519-Seed muss exakt 32 Byte sein (nicht 64 — sonst invalid seed length). */
  const signSeed = sodium.crypto_generichash(
    32,
    identitySk,
    enc.encode("vaultchat-sign-seed")
  );
  const signKp = sodium.crypto_sign_seed_keypair(signSeed);
  const signature = sodium.crypto_sign_detached(
    signedPreKeyKp.publicKey,
    signKp.privateKey
  );
  const oneTimePreKeys: LocalKeyMaterial["oneTimePreKeys"] = [];
  for (let i = 1; i <= 100; i += 1) {
    const kp = sodium.crypto_box_keypair();
    oneTimePreKeys.push({
      keyId: i,
      sk: base64FromUint8(kp.privateKey),
      pk: base64FromUint8(kp.publicKey),
    });
  }
  return {
    signedPreKey: {
      keyId: 1,
      sk: base64FromUint8(signedPreKeyKp.privateKey),
      pk: base64FromUint8(signedPreKeyKp.publicKey),
      signature: base64FromUint8(signature),
      signingPublicKey: base64FromUint8(signKp.publicKey),
    },
    oneTimePreKeys,
  };
}

export async function replenishOneTimePreKeys(
  km: LocalKeyMaterial,
  minimum = 50,
  target = 100
): Promise<LocalKeyMaterial> {
  if (km.oneTimePreKeys.length >= minimum) return km;
  await sodiumReady();
  const sodium = getSodium();
  const nextStart =
    km.oneTimePreKeys.reduce((max, key) => Math.max(max, key.keyId), 0) + 1;
  const next = [...km.oneTimePreKeys];
  for (let keyId = nextStart; next.length < target; keyId += 1) {
    const kp = sodium.crypto_box_keypair();
    next.push({
      keyId,
      sk: base64FromUint8(kp.privateKey),
      pk: base64FromUint8(kp.publicKey),
    });
  }
  return { ...km, oneTimePreKeys: next };
}

export function toUploadBody(km: LocalKeyMaterial) {
  return {
    signedPreKey: {
      keyId: km.signedPreKey.keyId,
      publicKey: km.signedPreKey.pk,
      signature: km.signedPreKey.signature,
      signingPublicKey: km.signedPreKey.signingPublicKey,
    },
    oneTimePreKeys: km.oneTimePreKeys.map((k) => ({
      keyId: k.keyId,
      publicKey: k.pk,
    })),
  };
}

export async function getOneTimePreKeySk(
  km: LocalKeyMaterial,
  keyId: number
): Promise<Uint8Array | null> {
  const otp = km.oneTimePreKeys.find((k) => k.keyId === keyId);
  return otp ? uint8FromBase64(otp.sk) : null;
}

export async function consumeOneTimePreKey(
  km: LocalKeyMaterial,
  keyId: number
): Promise<string | null> {
  const index = km.oneTimePreKeys.findIndex((k) => k.keyId === keyId);
  if (index < 0) return null;
  const [otp] = km.oneTimePreKeys.splice(index, 1);
  await saveKeyMaterial(km);
  return otp?.sk ?? null;
}
