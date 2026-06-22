/**
 * Verschlüsseltes Backup & Restore der LOKALEN Nachrichten-Historie
 * (GOAL Phase 2). Spiegelt exakt das Identity-Backup (`backup.ts`):
 * Argon2id (libsodium `crypto_pwhash`, INTERACTIVE-Limits, versionierte
 * KDF-Parameter #22) → `crypto_secretbox_easy` (XSalsa20-Poly1305) über das
 * serialisierte History-Bündel. KEINE eigene Krypto — nur die vorhandenen,
 * auditierten libsodium-Primitive.
 *
 * Zero-Knowledge: Das Ergebnis ist reiner Ciphertext. Selbst wenn der Blob
 * über den Server transportiert oder dort abgelegt würde, sähe der Server
 * NICHTS Lesbares — weder Inhalt noch Peer-IDs/Zeitstempel. Die Passphrase
 * verlässt das Gerät nie; ohne sie ist das Backup wertlos (per Design, wie
 * beim Identity-Backup — siehe RECOVERY.md).
 *
 * Der Blob enthält die client-ENTSCHLÜSSELTEN Nachrichten (PlainPayload-JSON
 * pro Eintrag), wie sie aus IDB via `idbListAllDm`/`idbListAllGroupMsgs`
 * kommen. Beim Import werden sie via `idbPutDm`/`idbPutGroupMsg` wieder unter
 * dem Local Data Key des Zielgeräts at-rest verschlüsselt abgelegt.
 */
import { base64FromUint8, uint8FromBase64 } from "./b64";
import { clampKdfParams } from "./crypto";
import type { StoredDmMessage, StoredGroupMessage } from "./idb";
import { getSodium, sodiumReady } from "./sodium";

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Das KLARTEXT-Bündel, das vor der Verschlüsselung serialisiert wird. Enthält
 * die volle lokale Historie (DM + Gruppe). `expiresAt` (verschwindende
 * Nachrichten) wird bewusst NICHT mitgesichert: ein abgelaufenes/ablaufendes
 * Geheimnis soll auch im Backup ablaufen, nicht durch ein Restore wieder
 * auferstehen. `idbListAllDm`/`idbListAllGroupMsgs` filtern bereits abgelaufene
 * Einträge heraus, bevor sie hierher kommen.
 */
export type HistoryBundle = {
  dm: Array<{
    id: string;
    peerId: string;
    fromMe: boolean;
    plainJson: string;
    at: number;
  }>;
  group: Array<{
    id: string;
    groupId: string;
    fromUserId: string;
    plainJson: string;
    at: number;
  }>;
};

export type EncryptedHistoryBackup = {
  type: "vaultchat.history.backup";
  version: 1;
  kdf: "argon2id";
  salt: string;
  nonce: string;
  cipher: string;
  createdAt: string;
  /** Anzahl der Einträge (nur Anzeige/Info — NICHT vertrauenswürdig, da
   *  außerhalb des MAC; der echte Count ergibt sich erst nach Entschlüsseln). */
  count?: number;
  /** KDF-Versionierung (#22): Argon2-Parameter. Reader bevorzugt sie vor den
   *  Konstanten; alte Backups ohne diese Felder bleiben lesbar (INTERACTIVE). */
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

function isEncryptedHistoryBackup(
  value: unknown
): value is EncryptedHistoryBackup {
  const candidate = value as Partial<EncryptedHistoryBackup>;
  return (
    candidate?.type === "vaultchat.history.backup" &&
    candidate.version === 1 &&
    candidate.kdf === "argon2id" &&
    typeof candidate.salt === "string" &&
    typeof candidate.nonce === "string" &&
    typeof candidate.cipher === "string"
  );
}

/**
 * Validiert das DEKODIERTE Bündel-Shape. `crypto_secretbox_open`
 * authentifiziert die Bytes bereits (Poly1305), aber ein Backup mit RICHTIGER
 * Passphrase und inkompatibler Struktur (anderer Branch / gezielt manipuliert)
 * würde den Import-Code mit `undefined`-Feldern treffen. Mit dem Check gibt es
 * einen vorhersehbaren Fehler statt einem späten NPE beim Re-Insert in IDB.
 */
function isHistoryBundleShape(value: unknown): value is HistoryBundle {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.dm) || !Array.isArray(v.group)) return false;
  for (const e of v.dm) {
    if (!e || typeof e !== "object") return false;
    const m = e as Record<string, unknown>;
    if (
      typeof m.id !== "string" ||
      typeof m.peerId !== "string" ||
      typeof m.fromMe !== "boolean" ||
      typeof m.plainJson !== "string" ||
      typeof m.at !== "number"
    ) {
      return false;
    }
  }
  for (const e of v.group) {
    if (!e || typeof e !== "object") return false;
    const m = e as Record<string, unknown>;
    if (
      typeof m.id !== "string" ||
      typeof m.groupId !== "string" ||
      typeof m.fromUserId !== "string" ||
      typeof m.plainJson !== "string" ||
      typeof m.at !== "number"
    ) {
      return false;
    }
  }
  return true;
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

/**
 * Baut aus den IDB-Listen ein serialisierbares Bündel (ohne `expiresAt`,
 * s.o.). Reine Datenumformung — keine Krypto.
 */
export function buildHistoryBundle(
  dm: StoredDmMessage[],
  group: StoredGroupMessage[]
): HistoryBundle {
  return {
    dm: dm.map((m) => ({
      id: m.id,
      peerId: m.peerId,
      fromMe: m.fromMe,
      plainJson: m.plainJson,
      at: m.at,
    })),
    group: group.map((m) => ({
      id: m.id,
      groupId: m.groupId,
      fromUserId: m.fromUserId,
      plainJson: m.plainJson,
      at: m.at,
    })),
  };
}

export async function encryptHistoryBackup(
  bundle: HistoryBundle,
  passphrase: string
): Promise<EncryptedHistoryBackup> {
  await sodiumReady();
  const sodium = getSodium();
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ops = sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE;
  const mem = sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE;
  const key = await deriveBackupKey(passphrase, salt, { ops, mem });
  try {
    const plain = enc.encode(JSON.stringify(bundle));
    const cipher = sodium.crypto_secretbox_easy(plain, nonce, key);
    return {
      type: "vaultchat.history.backup",
      version: 1,
      kdf: "argon2id",
      salt: base64FromUint8(salt),
      nonce: base64FromUint8(nonce),
      cipher: base64FromUint8(cipher),
      createdAt: new Date().toISOString(),
      count: bundle.dm.length + bundle.group.length,
      ops,
      mem,
    };
  } finally {
    sodium.memzero(key);
  }
}

export async function parseHistoryBackup(
  raw: string,
  passphraseProvider: () => string | null
): Promise<HistoryBundle> {
  const parsed = JSON.parse(raw) as unknown;
  if (!isEncryptedHistoryBackup(parsed)) {
    throw new Error("history_backup_must_be_encrypted_v1");
  }

  const passphrase = passphraseProvider();
  if (!passphrase) throw new Error("history_backup_passphrase_required");
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
      // MAC-Mismatch — "falsche Passphrase ODER manipulierte Bytes",
      // ununterscheidbar (per Design, wie beim Identity-Backup).
      throw new Error("history_backup_passphrase_wrong_or_tampered");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(dec.decode(plain));
    } catch {
      throw new Error("history_backup_corrupt_json");
    }
    if (!isHistoryBundleShape(decoded)) {
      throw new Error("history_backup_unexpected_shape");
    }
    return decoded;
  } finally {
    sodium.memzero(key);
  }
}
