import { randomUUID } from "node:crypto";
import {
  loadPersistedGroups,
  loadPersistedUsers,
  persistUsersAndGroups,
  type PersistedGroup,
} from "./serverState.js";

/** User/group directory. RAM-only unless VAULTCHAT_STATE_FILE is configured. */

export type StoredUser = {
  id: string;
  username: string;
  passwordHash: string;
  publicKey: string;
  recoveryEmailHash?: string;
  plan: "personal" | "pro" | "team";
  requestedPlan?: "personal" | "pro" | "team";
  createdAt: number;
};

export type StoredGroup = {
  id: string;
  name: string;
  memberIds: string[];
  /** User, der die Gruppe angelegt hat (für Rollen/UI). */
  createdByUserId: string;
  createdAt: number;
  /** Optional, klartext beim Server. Soll lediglich UX, nicht Sicherheit, leisten. */
  description?: string;
  /** data:image/...;base64,... Avatar. Klartext beim Server. */
  avatar?: string;
  /** Wann zuletzt Name/Beschreibung/Avatar geändert (für UI-Cache). */
  updatedAt?: number;
  /**
   * zkgroup (experimentell, A3-2e): base64-serialisierte GroupPublicParams,
   * von einem Mitglied aus dem GMK abgeleitet hochgeladen. ÖFFENTLICHER Wert
   * (leakt den GMK nicht). Nur in-memory, nicht persistiert — Clients laden
   * sie bei Bedarf neu. Dient heute NUR der gruppen-gebundenen
   * Presentation-Verifikation (Diagnose), nicht dem Nachrichtenpfad.
   */
  zkgPublicParams?: string;
};

const users = new Map<string, StoredUser>(
  loadPersistedUsers().map((user) => [
    user.id,
    {
      ...user,
      plan: user.plan ?? "personal",
      ...(user.requestedPlan ? { requestedPlan: user.requestedPlan } : {}),
    },
  ])
);
const usersByName = new Map<string, string>(
  [...users.values()].map((user) => [user.username.toLowerCase(), user.id])
);
function persistedGroupToStored(group: PersistedGroup): StoredGroup {
  return {
    id: group.id,
    name: group.name,
    memberIds: [...group.memberIds],
    createdAt: group.createdAt,
    createdByUserId: group.createdByUserId ?? group.memberIds[0] ?? "",
    ...(group.description ? { description: group.description } : {}),
    ...(group.avatar ? { avatar: group.avatar } : {}),
    ...(group.updatedAt ? { updatedAt: group.updatedAt } : {}),
  };
}

const groups = new Map<string, StoredGroup>(
  loadPersistedGroups().map((group) => [group.id, persistedGroupToStored(group)])
);

function persistDirectory() {
  persistUsersAndGroups([...users.values()], [...groups.values()]);
}

export function findUserByUsername(username: string) {
  const id = usersByName.get(username.toLowerCase());
  return id ? users.get(id) : undefined;
}

export function findUserById(id: string) {
  return users.get(id);
}

export function createUser(input: {
  username: string;
  passwordHash: string;
  publicKey: string;
  recoveryEmailHash?: string;
  plan?: "personal" | "pro" | "team";
  requestedPlan?: "personal" | "pro" | "team";
}): StoredUser | null {
  if (usersByName.has(input.username.toLowerCase())) return null;
  const user: StoredUser = {
    id: randomUUID(),
    username: input.username,
    passwordHash: input.passwordHash,
    publicKey: input.publicKey,
    ...(input.recoveryEmailHash ? { recoveryEmailHash: input.recoveryEmailHash } : {}),
    plan: input.plan ?? "personal",
    ...(input.requestedPlan ? { requestedPlan: input.requestedPlan } : {}),
    createdAt: Date.now(),
  };
  users.set(user.id, user);
  usersByName.set(user.username.toLowerCase(), user.id);
  persistDirectory();
  return user;
}

export function listUsersSafe() {
  return [...users.values()].map((u) => ({
    id: u.id,
    username: u.username,
    publicKey: u.publicKey,
    createdAt: u.createdAt,
  }));
}

/**
 * Komplette Account-Löschung: User + alle Gruppen-Mitgliedschaften + Gruppen,
 * bei denen der User der EINZIGE Member war. Gruppen mit anderen Mitgliedern
 * bleiben bestehen, der User wird nur entfernt.
 * Returns true wenn der User existierte und gelöscht wurde.
 */
export function deleteUserCompletely(userId: string): boolean {
  const user = users.get(userId);
  if (!user) return false;

  // Aus allen Gruppen entfernen; leere Gruppen droppen.
  for (const g of [...groups.values()]) {
    const idx = g.memberIds.indexOf(userId);
    if (idx === -1) continue;
    g.memberIds.splice(idx, 1);
    if (g.memberIds.length === 0) {
      groups.delete(g.id);
    }
  }

  users.delete(userId);
  usersByName.delete(user.username.toLowerCase());
  persistDirectory();
  return true;
}

export function getDirectoryStats() {
  return {
    users: users.size,
    groups: groups.size,
  };
}

export function createGroup(input: {
  name: string;
  memberIds: string[];
  createdByUserId: string;
  description?: string;
  avatar?: string;
}): StoredGroup {
  const now = Date.now();
  const g: StoredGroup = {
    id: randomUUID(),
    name: input.name,
    memberIds: [...new Set(input.memberIds)],
    createdByUserId: input.createdByUserId,
    createdAt: now,
    ...(input.description ? { description: input.description } : {}),
    ...(input.avatar ? { avatar: input.avatar } : {}),
    ...(input.description || input.avatar ? { updatedAt: now } : {}),
  };
  groups.set(g.id, g);
  persistDirectory();
  return g;
}

/**
 * Aktualisiert Name, Beschreibung oder Avatar. Nur der creator darf das aktuell;
 * spätere Erweiterungen (admin role list) bleiben kompatibel.
 *
 * Avatar = "" entfernt das Avatar; Avatar = undefined lässt es unverändert.
 */
export function updateGroupProfile(
  groupId: string,
  actorId: string,
  updates: { name?: string; description?: string; avatar?: string }
): StoredGroup | null {
  const g = groups.get(groupId);
  if (!g) return null;
  if (g.createdByUserId !== actorId) return null;
  if (typeof updates.name === "string") {
    const trimmed = updates.name.trim();
    if (trimmed) g.name = trimmed;
  }
  if (typeof updates.description === "string") {
    const trimmed = updates.description.trim();
    if (trimmed) g.description = trimmed;
    else delete g.description;
  }
  if (typeof updates.avatar === "string") {
    if (updates.avatar) g.avatar = updates.avatar;
    else delete g.avatar;
  }
  g.updatedAt = Date.now();
  persistDirectory();
  return g;
}

export function getGroup(id: string) {
  return groups.get(id);
}

/**
 * Setzt die zkgroup-GroupPublicParams einer Gruppe (nur ein Mitglied darf
 * das). Additiv und in-memory — verändert keinen anderen Gruppen-Zustand.
 */
export function setGroupZkgParams(
  groupId: string,
  actorId: string,
  zkgPublicParams: string
): boolean {
  const g = groups.get(groupId);
  if (!g) return false;
  if (!g.memberIds.includes(actorId)) return false;
  g.zkgPublicParams = zkgPublicParams;
  return true;
}

export function listGroupsForUser(userId: string) {
  return [...groups.values()].filter((g) => g.memberIds.includes(userId));
}

export function addGroupMember(groupId: string, actorId: string, memberId: string) {
  const g = groups.get(groupId);
  if (!g) return null;
  if (!g.memberIds.includes(actorId)) return null;
  if (!users.get(memberId)) return null;
  if (!g.memberIds.includes(memberId)) g.memberIds.push(memberId);
  persistDirectory();
  return g;
}

export function removeGroupMember(
  groupId: string,
  actorId: string,
  memberId: string
) {
  const g = groups.get(groupId);
  if (!g) return null;
  if (!g.memberIds.includes(actorId)) return null;
  g.memberIds = g.memberIds.filter((id) => id !== memberId);
  if (g.memberIds.length === 0) {
    groups.delete(groupId);
    persistDirectory();
    return {
      id: groupId,
      name: g.name,
      memberIds: [],
      createdByUserId: g.createdByUserId,
      createdAt: g.createdAt,
    };
  }
  persistDirectory();
  return g;
}

export function leaveGroup(groupId: string, userId: string) {
  return removeGroupMember(groupId, userId, userId);
}
