import { base64FromUint8, uint8FromBase64 } from "./b64";
import { getSodium, sodiumReady } from "./sodium";
import { ml_kem1024 } from "@noble/post-quantum/ml-kem.js";

const enc = new TextEncoder();

export type X3dhResult = {
  sharedSecret: Uint8Array;
  ephemeralPublicKey: string;
  usedOneTimePreKey: boolean;
  pqKemCiphertext?: string;
};

async function combineHybridSecret(
  x3dhSecret: Uint8Array,
  pqSecret: Uint8Array | null
): Promise<Uint8Array> {
  await sodiumReady();
  if (!pqSecret) return x3dhSecret;
  const sodium = getSodium();
  // Streaming-KDF (multipart BLAKE2b) — vermeidet Konkatenations-Buffer
  // mit beiden Secrets im Klartext.
  const state = sodium.crypto_generichash_init(
    enc.encode("vaultchat-pqxdh-mlkem1024-v1"),
    32
  );
  sodium.crypto_generichash_update(state, x3dhSecret);
  sodium.crypto_generichash_update(state, pqSecret);
  const hybrid = sodium.crypto_generichash_final(state, 32);
  sodium.memzero(x3dhSecret);
  sodium.memzero(pqSecret);
  return hybrid;
}

/**
 * Hash mehrerer DH-Outputs ohne sie in einem temporären Konkat-Buffer zu
 * vereinen. Die DH-Outputs werden anschliessend gezeroed.
 */
async function hashDhsStreaming(
  dhs: Uint8Array[],
  domainLabel: Uint8Array
): Promise<Uint8Array> {
  await sodiumReady();
  const sodium = getSodium();
  const state = sodium.crypto_generichash_init(domainLabel, 32);
  for (const dh of dhs) sodium.crypto_generichash_update(state, dh);
  const out = sodium.crypto_generichash_final(state, 32);
  for (const dh of dhs) sodium.memzero(dh);
  return out;
}

export async function x3dhSender(
  myIdentitySk: Uint8Array,
  peerIdentityPkB64: string,
  peerSignedPreKeyB64: string,
  peerOneTimePreKeyB64: string | null,
  peerPqKemPublicKeyB64?: string | null
): Promise<X3dhResult> {
  await sodiumReady();
  const sodium = getSodium();
  const ephemeralKp = sodium.crypto_box_keypair();
  const peerIdentityPk = uint8FromBase64(peerIdentityPkB64);
  const peerSignedPreKeyPk = uint8FromBase64(peerSignedPreKeyB64);
  const dhs = [
    sodium.crypto_scalarmult(myIdentitySk, peerIdentityPk),
    sodium.crypto_scalarmult(ephemeralKp.privateKey, peerSignedPreKeyPk),
  ];
  if (peerOneTimePreKeyB64) {
    dhs.push(
      sodium.crypto_scalarmult(
        ephemeralKp.privateKey,
        uint8FromBase64(peerOneTimePreKeyB64)
      )
    );
  }
  // Ephemeral DH-Privatkey wird nicht mehr gebraucht — direkt zeroen.
  sodium.memzero(ephemeralKp.privateKey);
  const x3dhSecret = await hashDhsStreaming(
    dhs,
    enc.encode("vaultchat-x3dh-v1")
  );
  let pqKemCiphertext: string | undefined;
  let pqSharedSecret: Uint8Array | null = null;
  if (peerPqKemPublicKeyB64) {
    const { cipherText, sharedSecret } = ml_kem1024.encapsulate(
      uint8FromBase64(peerPqKemPublicKeyB64)
    );
    pqKemCiphertext = base64FromUint8(cipherText);
    pqSharedSecret = sharedSecret;
  }
  return {
    sharedSecret: await combineHybridSecret(x3dhSecret, pqSharedSecret),
    ephemeralPublicKey: base64FromUint8(ephemeralKp.publicKey),
    usedOneTimePreKey: peerOneTimePreKeyB64 !== null,
    ...(pqKemCiphertext ? { pqKemCiphertext } : {}),
  };
}

export async function x3dhReceiver(
  myIdentitySk: Uint8Array,
  senderIdentityPkB64: string,
  mySignedPreKeySkB64: string,
  myOneTimePreKeySkB64: string | null,
  senderEphemeralPkB64: string,
  myPqKemSecretKeyB64?: string | null,
  pqKemCiphertextB64?: string | null
): Promise<Uint8Array> {
  await sodiumReady();
  const sodium = getSodium();
  const senderIdentityPk = uint8FromBase64(senderIdentityPkB64);
  const senderEphemeralPk = uint8FromBase64(senderEphemeralPkB64);
  const mySignedPreKeySk = uint8FromBase64(mySignedPreKeySkB64);
  const dhs = [
    sodium.crypto_scalarmult(myIdentitySk, senderIdentityPk),
    sodium.crypto_scalarmult(mySignedPreKeySk, senderEphemeralPk),
  ];
  if (myOneTimePreKeySkB64) {
    dhs.push(
      sodium.crypto_scalarmult(
        uint8FromBase64(myOneTimePreKeySkB64),
        senderEphemeralPk
      )
    );
  }
  sodium.memzero(mySignedPreKeySk);
  const x3dhSecret = await hashDhsStreaming(
    dhs,
    enc.encode("vaultchat-x3dh-v1")
  );
  const pqSharedSecret =
    myPqKemSecretKeyB64 && pqKemCiphertextB64
      ? ml_kem1024.decapsulate(
          uint8FromBase64(pqKemCiphertextB64),
          uint8FromBase64(myPqKemSecretKeyB64)
        )
      : null;
  return combineHybridSecret(x3dhSecret, pqSharedSecret);
}
