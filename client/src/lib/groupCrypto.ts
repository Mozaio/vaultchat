import { base64FromUint8, uint8FromBase64 } from "./b64";
import { getSodium, sodiumReady } from "./sodium";
import { metaGet, metaSet } from "./idb";
import type { PlainPayload } from "./crypto";

const MAGIC = new Uint8Array([0x47, 0x43, 0x31, 0x01]);
const enc = new TextEncoder();

export async function setGroupKey(groupId: string, key32: Uint8Array) {
  await metaSet(`gkey:${groupId}`, base64FromUint8(key32));
}

export async function getGroupKey(groupId: string): Promise<Uint8Array | null> {
  const b = await metaGet(`gkey:${groupId}`);
  if (!b) return null;
  return uint8FromBase64(b);
}

export async function randomGroupKey(): Promise<Uint8Array> {
  await sodiumReady();
  return getSodium().randombytes_buf(32);
}

export async function encryptGroupPayload(
  groupId: string,
  payload: PlainPayload
): Promise<string> {
  await sodiumReady();
  const sodium = getSodium();
  const key = await getGroupKey(groupId);
  if (!key) throw new Error("no_group_key");
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const cipher = sodium.crypto_secretbox_easy(
    enc.encode(JSON.stringify(payload)),
    nonce,
    key
  );
  const out = new Uint8Array(MAGIC.length + nonce.length + cipher.length);
  out.set(MAGIC, 0);
  out.set(nonce, MAGIC.length);
  out.set(cipher, MAGIC.length + nonce.length);
  return base64FromUint8(out);
}

export async function decryptGroupPayload(
  groupId: string,
  b64: string
): Promise<PlainPayload> {
  await sodiumReady();
  const sodium = getSodium();
  const buf = uint8FromBase64(b64);
  if (buf.length < MAGIC.length) throw new Error("bad_group_cipher");
  for (let i = 0; i < MAGIC.length; i++) {
    if (buf[i] !== MAGIC[i]) throw new Error("bad_group_magic");
  }
  const key = await getGroupKey(groupId);
  if (!key) throw new Error("no_group_key");
  const n = sodium.crypto_secretbox_NONCEBYTES;
  const nonce = buf.subarray(MAGIC.length, MAGIC.length + n);
  const cipher = buf.subarray(MAGIC.length + n);
  const plain = sodium.crypto_secretbox_open_easy(cipher, nonce, key);
  return JSON.parse(new TextDecoder().decode(plain)) as PlainPayload;
}
