import { randomUUID } from "node:crypto";
import {
  loadPersistedGroups,
  loadPersistedUsers,
  persistUsersAndGroups,
  type PersistedGroup,
} from "./serverState.js";
import {
  canAddMember,
  canDemote,
  canPromote,
  canRemoveMember,
  canUpdateProfile,
  effectiveAdminIds,
} from "./groupRoles.js";

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
  /** Token-Revocation: in jedes ausgestellte JWT eingebacken (te). Ein Bump
   *  entwertet alle bisherigen Tokens dieses Users. */
  tokenEpoch?: number;
  /** E2E-Profil (Name+Avatar) als `PROFILE1:`-Ciphertext — server-opak, nie
   *  Klartext. Profile-Key wird per Olm an Kontakte geteilt. */
  profileCipher?: string;
};

export type StoredGroup = {
  id: string;
  name: string;
  memberIds: string[];
  /** User, der die Gruppe angelegt hat (für Rollen/UI). */
  createdByUserId: string;
  /** Phase 3: explizite Admin-Liste (Untermenge von memberIds). Der Ersteller
   *  gilt IMMER als Admin (siehe groupRoles.effectiveAdminIds), auch wenn er
   *  hier nicht gelistet ist. Reine Autorisierungs-Metadaten — kein Krypto. */
  adminIds: string[];
  createdAt: number;
  /** #25: bei aktuellen Clients `GMETA1:`-Ciphertext (E2EE, server-opak — der
   *  echte Name/Text wird nie sichtbar); nur Legacy/Krypto-Fallback ist Klartext. */
  description?: string;
  /** #25: bei aktuellen Clients `GMETA1:`-Ciphertext (server-opak); sonst
   *  data:image/...;base64,... Klartext (Legacy/Fallback). */
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
  const memberIds = [...group.memberIds];
  const creator = group.createdByUserId ?? memberIds[0] ?? "";
  // Admin-Liste rekonstruieren: persistierte adminIds (auf aktuelle Mitglieder
  // beschränkt) ∪ Ersteller. Legacy-Gruppen ohne Feld → nur der Ersteller.
  const adminSet = new Set<string>(
    (group.adminIds ?? []).filter((id) => memberIds.includes(id))
  );
  if (memberIds.includes(creator)) adminSet.add(creator);
  return {
    id: group.id,
    name: group.name,
    memberIds,
    adminIds: [...adminSet],
    createdAt: group.createdAt,
    createdByUserId: creator,
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

/** Aktuelle Token-Epoch eines Users (0 wenn unbekannt/nie entwertet). */
export function getTokenEpoch(userId: string): number {
  return users.get(userId)?.tokenEpoch ?? 0;
}

/**
 * Erhöht die Token-Epoch ("auf allen Geräten abmelden") → alle bisher
 * ausgestellten Tokens dieses Users (inkl. des gerade benutzten) werden
 * beim nächsten verifyToken abgelehnt. Gibt den neuen Wert zurück (oder
 * null, wenn der User nicht existiert).
 */
export function bumpTokenEpoch(userId: string): number | null {
  const u = users.get(userId);
  if (!u) return null;
  u.tokenEpoch = (u.tokenEpoch ?? 0) + 1;
  persistDirectory();
  return u.tokenEpoch;
}

export function listUsersSafe() {
  return [...users.values()].map((u) => ({
    id: u.id,
    username: u.username,
    publicKey: u.publicKey,
    createdAt: u.createdAt,
    ...(u.profileCipher ? { profileCipher: u.profileCipher } : {}),
  }));
}

/**
 * Speichert das E2E-verschlüsselte Profil-Blob eines Users (`PROFILE1:`-
 * Ciphertext, server-opak). Gibt false zurück, wenn der User nicht existiert.
 */
export function setProfileCipher(userId: string, profileCipher: string): boolean {
  const u = users.get(userId);
  if (!u) return false;
  u.profileCipher = profileCipher;
  persistDirectory();
  return true;
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
    // Der Ersteller ist der erste (und initial einzige) Admin.
    adminIds: [input.createdByUserId],
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
  if (!canUpdateProfile(g, actorId)) return null;
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
  // Rolle: nur Admins (inkl. Ersteller) dürfen hinzufügen.
  if (!canAddMember(g, actorId)) return null;
  if (!users.get(memberId)) return null;
  if (!g.memberIds.includes(memberId)) g.memberIds.push(memberId);
  persistDirectory();
  return g;
}

/**
 * Fügt ein Mitglied über einen gültigen Einladungs-Token hinzu — der Token IST
 * die Autorisierung (vom Server geprüft in inviteStore), daher KEINE
 * Admin-Rollenprüfung. Verwendet ausschließlich vom Invite-Redeem-Pfad; ein
 * normaler API-Aufruf muss `addGroupMember` (rollen-gated) nehmen.
 */
export function addGroupMemberByInvite(groupId: string, memberId: string) {
  const g = groups.get(groupId);
  if (!g) return null;
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
  // Rolle: Selbst-Verlassen immer ok; sonst nur Admins, und Ersteller/andere
  // Admins sind durch canRemoveMember geschützt.
  if (!canRemoveMember(g, actorId, memberId)) return null;
  g.memberIds = g.memberIds.filter((id) => id !== memberId);
  // Entfernten User auch aus der Admin-Liste streichen (Konsistenz).
  g.adminIds = g.adminIds.filter((id) => id !== memberId);
  if (g.memberIds.length === 0) {
    groups.delete(groupId);
    persistDirectory();
    return {
      id: groupId,
      name: g.name,
      memberIds: [],
      adminIds: [],
      createdByUserId: g.createdByUserId,
      createdAt: g.createdAt,
    };
  }
  persistDirectory();
  return g;
}

/**
 * Befördert ein Mitglied zum Admin. Nur bestehende Admins dürfen das. Gibt die
 * Gruppe zurück (oder null bei fehlender Berechtigung / unbekannter Gruppe).
 */
export function promoteGroupAdmin(
  groupId: string,
  actorId: string,
  targetId: string
) {
  const g = groups.get(groupId);
  if (!g) return null;
  if (!canPromote(g, actorId, targetId)) return null;
  if (!g.adminIds.includes(targetId)) g.adminIds.push(targetId);
  persistDirectory();
  return g;
}

/**
 * Degradiert einen Admin zum Mitglied. Nur der Ersteller darf das; der
 * Ersteller selbst kann nicht degradiert werden.
 */
export function demoteGroupAdmin(
  groupId: string,
  actorId: string,
  targetId: string
) {
  const g = groups.get(groupId);
  if (!g) return null;
  if (!canDemote(g, actorId, targetId)) return null;
  g.adminIds = g.adminIds.filter((id) => id !== targetId);
  persistDirectory();
  return g;
}

/** Effektive Admin-IDs einer Gruppe (für die API-Ausgabe). */
export function getGroupAdminIds(groupId: string): string[] | null {
  const g = groups.get(groupId);
  if (!g) return null;
  return [...effectiveAdminIds(g)];
}

export function leaveGroup(groupId: string, userId: string) {
  return removeGroupMember(groupId, userId, userId);
}
