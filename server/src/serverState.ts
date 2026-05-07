import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type PersistedUser = {
  id: string;
  username: string;
  passwordHash: string;
  publicKey: string;
  recoveryEmailHash?: string;
  plan?: "personal" | "pro" | "team";
  requestedPlan?: "personal" | "pro" | "team";
  createdAt: number;
};

export type PersistedGroup = {
  id: string;
  name: string;
  memberIds: string[];
  createdAt: number;
  /** Neuere Clients schreiben das Feld; alte State-Dateien können es weglassen. */
  createdByUserId?: string;
  /** Optional, frei vom Creator gesetzt. Server speichert Klartext (nicht E2EE). */
  description?: string;
  /** data:image/...;base64,... Avatar. Server speichert klartext. Max ~80 KB. */
  avatar?: string;
  /** Letzte Änderung an Profil (Name/Beschreibung/Avatar). */
  updatedAt?: number;
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
  nextKeyId: number;
};

type ServerState = {
  version: 1;
  users: PersistedUser[];
  groups: PersistedGroup[];
  preKeyBundles: PersistedPreKeyBundle[];
  redeemedInviteCodeHashes: string[];
};

const emptyState = (): ServerState => ({
  version: 1,
  users: [],
  groups: [],
  preKeyBundles: [],
  redeemedInviteCodeHashes: [],
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

function readState(): ServerState {
  const file = stateFile();
  if (!file) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ServerState>;
    if (parsed.version !== 1) return emptyState();
    return {
      version: 1,
      users: Array.isArray(parsed.users) ? parsed.users : [],
      groups: Array.isArray(parsed.groups) ? parsed.groups : [],
      preKeyBundles: Array.isArray(parsed.preKeyBundles) ? parsed.preKeyBundles : [],
      redeemedInviteCodeHashes: Array.isArray(parsed.redeemedInviteCodeHashes)
        ? parsed.redeemedInviteCodeHashes
        : [],
    };
  } catch {
    return emptyState();
  }
}

function writeState(next: ServerState): void {
  const file = stateFile();
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
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
