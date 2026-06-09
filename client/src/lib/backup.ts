import { base64FromUint8, uint8FromBase64 } from "./b64";
import { clampKdfParams } from "./crypto";
import type { LocalIdentity } from "./localIdentity";
import { getSodium, sodiumReady } from "./sodium";

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Validiert das DEKODIERTE Backup-JSON gegen das LocalIdentity-Shape.
 * crypto_secretbox_open authentifiziert die Bytes (Poly1305-MAC), aber wenn
 * jemand uns einen verschlüsselten Backup mit der RICHTIGEN Passphrase aber
 * inkompatibler Datenstruktur unterschiebt (z.B. v1 von einem anderen
 * Branch oder gezielt manipuliert), würde der App-Code später unerwartete
 * undefined-Felder treffen. Mit Schema-Check bekommen wir einen
 * vorhersehbaren Error statt einen späten NPE.
 */
function isLocalIdentityShape(value: unknown): value is LocalIdentity {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.userId !== "string" || v.userId.length === 0) return false;
  if (typeof v.username !== "string" || v.username.length === 0) return false;
  if (typeof v.publicKey !== "string" || v.publicKey.length === 0) return false;
  if (!v.wrapped || typeof v.wrapped !== "object") return false;
  const w = v.wrapped as Record<string, unknown>;
  return (
    typeof w.salt === "string" &&
    typeof w.nonce === "string" &&
    typeof w.cipher === "string" &&
    w.salt.length > 0 &&
    w.nonce.length > 0 &&
    w.cipher.length > 0
  );
}

export type EncryptedIdentityBackup = {
  type: "vaultchat.identity.backup";
  version: 2;
  kdf: "argon2id";
  salt: string;
  nonce: string;
  cipher: string;
  createdAt: string;
  /** KDF-Versionierung (#22): optionale Argon2-Parameter. Neue Backups
   *  schreiben sie; der Reader bevorzugt sie vor den Konstanten. Alte
   *  Backups ohne diese Felder bleiben lesbar (INTERACTIVE-Fallback),
   *  alte Clients ignorieren die Zusatzfelder. */
  ops?: number;
  mem?: number;
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

async function deriveBackupKey(
  passphrase: string,
  salt: Uint8Array,
  params?: { ops?: number; mem?: number }
) {
  await sodiumReady();
  const sodium = getSodium();
  const { ops, mem } = clampKdfParams(params?.ops, params?.mem, {
    ops: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    mem: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
  });
  return sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    passphrase,
    salt,
    ops,
    mem,
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
  const ops = sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE;
  const mem = sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE;
  const key = await deriveBackupKey(passphrase, salt, { ops, mem });
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
      ops,
      mem,
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
  const key = await deriveBackupKey(passphrase, salt, {
    ops: parsed.ops,
    mem: parsed.mem,
  });
  try {
    let plain: Uint8Array;
    try {
      plain = sodium.crypto_secretbox_open_easy(cipher, nonce, key);
    } catch {
      // crypto_secretbox_open wirft bei MAC-Mismatch — gleichbedeutend mit
      // "falsche Passphrase ODER manipulierte Bytes". Wir können nicht
      // unterscheiden, also sage es generisch.
      throw new Error("backup_passphrase_wrong_or_tampered");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(dec.decode(plain));
    } catch {
      throw new Error("backup_corrupt_json");
    }
    if (!isLocalIdentityShape(decoded)) {
      throw new Error("backup_unexpected_shape");
    }
    return decoded;
  } finally {
    sodium.memzero(key);
  }
}
