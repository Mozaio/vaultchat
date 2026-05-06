import { base64FromUint8, uint8FromBase64 } from "./b64";
import type { LocalIdentity } from "./localIdentity";
import { getSodium, sodiumReady } from "./sodium";

const enc = new TextEncoder();
const dec = new TextDecoder();

export type EncryptedIdentityBackup = {
  type: "vaultchat.identity.backup";
  version: 2;
  kdf: "argon2id";
  salt: string;
  nonce: string;
  cipher: string;
  createdAt: string;
};

function pwhashAlg(sodium: {
  crypto_pwhash_ALG_ARGON2ID?: number;
  crypto_pwhash_ALG_ARGON2ID13?: number;
  crypto_pwhash_ALG_DEFAULT?: number;
}): number {
  const alg =
    sodium.crypto_pwhash_ALG_ARGON2ID ??
    sodium.crypto_pwhash_ALG_ARGON2ID13 ??
    sodium.crypto_pwhash_ALG_DEFAULT;
  if (typeof alg !== "number") throw new Error("argon2_algorithm_unavailable");
  return alg;
}

function isEncryptedIdentityBackup(value: unknown): value is EncryptedIdentityBackup {
  const candidate = value as Partial<EncryptedIdentityBackup>;
  return (
    candidate?.type === "vaultchat.identity.backup" &&
    candidate.version === 2 &&
    candidate.kdf === "argon2id" &&
    typeof candidate.salt === "string" &&
    typeof candidate.nonce === "string" &&
    typeof candidate.cipher === "string"
  );
}

async function deriveBackupKey(passphrase: string, salt: Uint8Array) {
  await sodiumReady();
  const sodium = getSodium();
  return sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    passphrase,
    salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    pwhashAlg(sodium)
  );
}

export async function encryptIdentityBackup(
  identity: LocalIdentity,
  passphrase: string
): Promise<EncryptedIdentityBackup> {
  await sodiumReady();
  const sodium = getSodium();
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const key = await deriveBackupKey(passphrase, salt);
  try {
    const plain = enc.encode(JSON.stringify(identity));
    const cipher = sodium.crypto_secretbox_easy(plain, nonce, key);
    return {
      type: "vaultchat.identity.backup",
      version: 2,
      kdf: "argon2id",
      salt: base64FromUint8(salt),
      nonce: base64FromUint8(nonce),
      cipher: base64FromUint8(cipher),
      createdAt: new Date().toISOString(),
    };
  } finally {
    sodium.memzero(key);
  }
}

export async function parseIdentityBackup(
  raw: string,
  passphraseProvider: () => string | null
): Promise<LocalIdentity> {
  const parsed = JSON.parse(raw) as unknown;
  if (!isEncryptedIdentityBackup(parsed)) {
    throw new Error("backup_must_be_encrypted_v2");
  }

  const passphrase = passphraseProvider();
  if (!passphrase) throw new Error("backup_passphrase_required");
  await sodiumReady();
  const sodium = getSodium();
  const salt = uint8FromBase64(parsed.salt);
  const nonce = uint8FromBase64(parsed.nonce);
  const cipher = uint8FromBase64(parsed.cipher);
  const key = await deriveBackupKey(passphrase, salt);
  try {
    const plain = sodium.crypto_secretbox_open_easy(cipher, nonce, key);
    return JSON.parse(dec.decode(plain)) as LocalIdentity;
  } finally {
    sodium.memzero(key);
  }
}
