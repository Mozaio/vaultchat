import { base64FromUint8, uint8FromBase64 } from "./b64";
import { getSodium, sodiumReady } from "./sodium";

const enc = new TextEncoder();

export type X3dhResult = {
  sharedSecret: Uint8Array;
  ephemeralPublicKey: string;
  usedOneTimePreKey: boolean;
};

export async function x3dhSender(
  myIdentitySk: Uint8Array,
  peerIdentityPkB64: string,
  peerSignedPreKeyB64: string,
  peerOneTimePreKeyB64: string | null
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
  const input = new Uint8Array(dhs.reduce((sum, dh) => sum + dh.length, 0));
  let offset = 0;
  for (const dh of dhs) {
    input.set(dh, offset);
    offset += dh.length;
  }
  const sharedSecret = sodium.crypto_generichash(
    32,
    input,
    enc.encode("vaultchat-x3dh-v1")
  );
  for (const dh of dhs) sodium.memzero(dh);
  return {
    sharedSecret,
    ephemeralPublicKey: base64FromUint8(ephemeralKp.publicKey),
    usedOneTimePreKey: peerOneTimePreKeyB64 !== null,
  };
}

export async function x3dhReceiver(
  myIdentitySk: Uint8Array,
  senderIdentityPkB64: string,
  mySignedPreKeySkB64: string,
  myOneTimePreKeySkB64: string | null,
  senderEphemeralPkB64: string
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
  const input = new Uint8Array(dhs.reduce((sum, dh) => sum + dh.length, 0));
  let offset = 0;
  for (const dh of dhs) {
    input.set(dh, offset);
    offset += dh.length;
  }
  const sharedSecret = sodium.crypto_generichash(
    32,
    input,
    enc.encode("vaultchat-x3dh-v1")
  );
  for (const dh of dhs) sodium.memzero(dh);
  return sharedSecret;
}
