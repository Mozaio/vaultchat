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
  const signSeed = sodium.crypto_generichash(
    64,
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
    },
    oneTimePreKeys,
  };
}

export function toUploadBody(km: LocalKeyMaterial) {
  return {
    signedPreKey: {
      keyId: km.signedPreKey.keyId,
      publicKey: km.signedPreKey.pk,
      signature: km.signedPreKey.signature,
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
