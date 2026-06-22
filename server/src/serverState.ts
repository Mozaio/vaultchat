import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./logger.js";

export type PersistedUser = {
  id: string;
  username: string;
  passwordHash: string;
  publicKey: string;
  recoveryEmailHash?: string;
  plan?: "personal" | "pro" | "team";
  requestedPlan?: "personal" | "pro" | "team";
  createdAt: number;
  /** Token-Revocation-Zähler ("auf allen Geräten abmelden"). Persistiert,
   *  damit eine Entwertung einen Restart im persistenten Modus überlebt. */
  tokenEpoch?: number;
  /** E2E-verschlüsseltes Profil (Anzeigename+Avatar) als `PROFILE1:`-Ciphertext,
   *  vom Server NUR opak gespeichert/ausgeliefert (analog zu Gruppen-#25). Der
   *  Server sieht nie Klartext-Profil; der Profile-Key wird per Olm geteilt. */
  profileCipher?: string;
};

export type PersistedGroup = {
  id: string;
  name: string;
  memberIds: string[];
  createdAt: number;
  /** Neuere Clients schreiben das Feld; alte State-Dateien können es weglassen. */
  createdByUserId?: string;
  /** Phase 3: explizite Admin-Liste (Untermenge von memberIds). Der Ersteller
   *  ist immer Admin, auch wenn das Feld fehlt (Legacy-Gruppen). Reine
   *  Server-Autorisierungs-Metadaten — verändert das Schlüsselmodell nicht. */
  adminIds?: string[];
  /** #25: bei aktuellen Clients `GMETA1:`-Ciphertext (E2EE, server-opak); nur
   *  Legacy/Fallback ist Klartext. */
  description?: string;
  /** #25: `GMETA1:`-Ciphertext bei aktuellen Clients (server-opak); sonst
   *  data:image/...;base64,... Klartext (Legacy/Fallback). Max ~80 KB. */
  avatar?: string;
  /** Letzte Änderung an Profil (Name/Beschreibung/Avatar). */
  updatedAt?: number;
};

export type PersistedGroupInvite = {
  /** Url-safe random token, 24 raw bytes -> 32 base64url chars. */
  token: string;
  groupId: string;
  /** UserId of the creator (must be the group's creator at issue time). */
  createdByUserId: string;
  /** ms-since-epoch the token was minted. */
  createdAt: number;
  /** ms-since-epoch the token expires. 0 = never expires. */
  expiresAt: number;
  /** Maximum total redemptions. 0 = unlimited. */
  maxUses: number;
  /** Number of successful redemptions so far. */
  usedCount: number;
};

export type PersistedPreKeyBundle = {
  userId: string;
  identityKey: string;
  signedPreKey: {
    keyId: number;
    publicKey: string;
    signature: string;
    signingPublicKey?: string;
  };
  oneTimePreKeys: { keyId: number; publicKey: string }[];
  pqKem?: {
    alg: "ML-KEM-1024";
    publicKey: string;
  };
  /**
   * Olm-Identity + One-Time-Keys für den auditierten Krypto-Pfad
   * (`@matrix-org/olm`). Optional — alte Bundles ohne dieses Feld
   * funktionieren weiter, Sender wählt dann den DR-v4-Pfad.
   */
  olm?: {
    identityCurve25519: string;
    identityEd25519: string;
    oneTimeKeys: { keyId: string; publicKey: string }[];
  };
  nextKeyId: number;
};

type ServerState = {
  version: 1;
  users: PersistedUser[];
  groups: PersistedGroup[];
  preKeyBundles: PersistedPreKeyBundle[];
  redeemedInviteCodeHashes: string[];
  groupInvites?: PersistedGroupInvite[];
};

const emptyState = (): ServerState => ({
  version: 1,
  users: [],
  groups: [],
  preKeyBundles: [],
  redeemedInviteCodeHashes: [],
  groupInvites: [],
});

function stateFile(): string | null {
  const value = process.env.VAULTCHAT_STATE_FILE?.trim();
  return value || null;
}

export function getStateStatus(): {
  mode: "persistent" | "ephemeral";
  file: string | null;
  writable: boolean;
  error?: string;
} {
  const file = stateFile();
  if (!file) return { mode: "ephemeral", file: null, writable: true };
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.ready`;
    writeFileSync(tmp, "ok\n", { mode: 0o600 });
    unlinkSync(tmp);
    return { mode: "persistent", file, writable: true };
  } catch (err) {
    return {
      mode: "persistent",
      file,
      writable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// At-rest encryption of the persisted directory (GOAL 0.1b).
//
// When VAULTCHAT_STATE_KEY is set (32 bytes as hex OR base64) the whole state
// blob is written to disk encrypted with AES-256-GCM (node:crypto, an
// established AEAD - no homegrown crypto). Without a key it stays plaintext
// JSON (backwards compatible; a legacy plaintext file is upgraded to
// encrypted on the next write). With a key, the persisted file / any backup
// contains no plaintext usernames, keys or group metadata. The running
// server still holds the key - true server blindness against identities is
// GOAL 0.1d (OPRF/PSI).
// ---------------------------------------------------------------------------

const STATE_ENC_ALG = "aes-256-gcm";
const STATE_ENC_AAD = Buffer.from("vaultchat-state-v2");

type EncryptedState = {
  v: 2;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
};

let plaintextWarned = false;
let upgradeWarned = false;

/**
 * At-rest key from VAULTCHAT_STATE_KEY (32 bytes, hex or base64). Not set ->
 * null (legacy plaintext). Set but wrong length -> throw (fail fast instead of
 * silently writing plaintext).
 */
function loadStateKey(): Buffer | null {
  const raw = process.env.VAULTCHAT_STATE_KEY?.trim();
  if (!raw) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      "VAULTCHAT_STATE_KEY must be 32 bytes (64 hex chars or base64 of 32 bytes)"
    );
  }
  return key;
}

function encryptState(plaintext: string, key: Buffer): EncryptedState {
  const iv = randomBytes(12);
  const cipher = createCipheriv(STATE_ENC_ALG, key, iv, { authTagLength: 16 });
  cipher.setAAD(STATE_ENC_AAD);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    v: 2,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decryptState(envelope: EncryptedState, key: Buffer): string {
  const decipher = createDecipheriv(
    STATE_ENC_ALG,
    key,
    Buffer.from(envelope.iv, "base64"),
    { authTagLength: 16 }
  );
  decipher.setAAD(STATE_ENC_AAD);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function isEncryptedEnvelope(parsed: unknown): parsed is EncryptedState {
  if (typeof parsed !== "object" || parsed === null) return false;
  const p = parsed as { v?: unknown; alg?: unknown };
  return p.v === 2 && p.alg === "aes-256-gcm";
}

function normalizeState(parsed: Partial<ServerState>): ServerState {
  return {
    version: 1,
    users: Array.isArray(parsed.users) ? parsed.users : [],
    groups: Array.isArray(parsed.groups) ? parsed.groups : [],
    preKeyBundles: Array.isArray(parsed.preKeyBundles) ? parsed.preKeyBundles : [],
    redeemedInviteCodeHashes: Array.isArray(parsed.redeemedInviteCodeHashes)
      ? parsed.redeemedInviteCodeHashes
      : [],
    groupInvites: Array.isArray(parsed.groupInvites) ? parsed.groupInvites : [],
  };
}

function readState(): ServerState {
  const file = stateFile();
  if (!file) return emptyState();

  const key = loadStateKey();
  if (!key && !plaintextWarned) {
    log.warn("state_plaintext", {
      msg: "VAULTCHAT_STATE_FILE persists in plaintext; set VAULTCHAT_STATE_KEY (32 bytes) to encrypt the directory at rest.",
    });
    plaintextWarned = true;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // File missing yet or not valid JSON -> empty start.
    return emptyState();
  }

  if (isEncryptedEnvelope(parsed)) {
    if (!key) {
      // Encrypted file but no key: do NOT continue with empty state, otherwise
      // the next write would overwrite the whole directory. Fail closed.
      throw new Error(
        "VAULTCHAT_STATE_FILE is encrypted but VAULTCHAT_STATE_KEY is not set"
      );
    }
    try {
      return normalizeState(
        JSON.parse(decryptState(parsed, key)) as Partial<ServerState>
      );
    } catch {
      throw new Error(
        "VAULTCHAT_STATE_FILE could not be decrypted (wrong VAULTCHAT_STATE_KEY or corrupt file)"
      );
    }
  }

  // Legacy plaintext.
  const legacy = parsed as Partial<ServerState>;
  if (legacy.version !== 1) return emptyState();
  if (key && !upgradeWarned) {
    log.warn("state_plaintext_upgrade", {
      msg: "Legacy plaintext state file detected; re-writing it encrypted on the next change.",
    });
    upgradeWarned = true;
  }
  return normalizeState(legacy);
}

function writeState(next: ServerState): void {
  const file = stateFile();
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  const key = loadStateKey();
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  const payload = key
    ? `${JSON.stringify(encryptState(serialized, key))}\n`
    : serialized;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, payload, { mode: 0o600 });
  renameSync(tmp, file);
}

export function loadPersistedUsers(): PersistedUser[] {
  return readState().users;
}

export function loadPersistedGroups(): PersistedGroup[] {
  return readState().groups;
}

export function loadPersistedPreKeyBundles(): PersistedPreKeyBundle[] {
  return readState().preKeyBundles;
}

export function persistUsersAndGroups(
  users: PersistedUser[],
  groups: PersistedGroup[]
): void {
  const current = readState();
  writeState({
    ...current,
    users,
    groups,
  });
}

export function persistPreKeyBundles(preKeyBundles: PersistedPreKeyBundle[]): void {
  const current = readState();
  writeState({
    ...current,
    preKeyBundles,
  });
}

export function loadRedeemedInviteCodeHashes(): string[] {
  return readState().redeemedInviteCodeHashes;
}

export function persistRedeemedInviteCodeHashes(redeemedInviteCodeHashes: string[]): void {
  const current = readState();
  writeState({
    ...current,
    redeemedInviteCodeHashes,
  });
}

export function loadPersistedGroupInvites(): PersistedGroupInvite[] {
  return readState().groupInvites ?? [];
}

export function persistGroupInvites(groupInvites: PersistedGroupInvite[]): void {
  const current = readState();
  writeState({
    ...current,
    groupInvites,
  });
}
