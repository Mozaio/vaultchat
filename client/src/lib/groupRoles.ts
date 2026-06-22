/**
 * Client-seitige Spiegelung der Server-Rollenpolitik (`server/src/groupRoles.ts`)
 * — NUR für UI-Gating (welche Buttons zeige ich an). Die echte Durchsetzung
 * passiert ausschließlich server-seitig; diese Helfer dürfen großzügig sein,
 * ohne die Sicherheit zu berühren (ein manipuliertes UI ändert nichts, weil der
 * Server jede Mutation prüft).
 *
 * Wichtig: Der Ersteller gilt IMMER als Admin, auch wenn `adminIds` fehlt
 * (alte Server) — exakt wie `effectiveAdminIds` auf dem Server.
 */
import type { ApiGroup } from "./api";

export function effectiveAdminIds(g: ApiGroup): Set<string> {
  const members = new Set(g.memberIds);
  const admins = new Set<string>();
  for (const id of g.adminIds ?? []) {
    if (members.has(id)) admins.add(id);
  }
  if (g.createdByUserId && members.has(g.createdByUserId)) {
    admins.add(g.createdByUserId);
  }
  // Sehr alte Server ohne createdByUserId UND ohne adminIds: niemand ist
  // sicher Admin → wir gewähren keine Admin-UI (fail-closed in der UI).
  return admins;
}

export function isGroupAdmin(g: ApiGroup, userId: string): boolean {
  return effectiveAdminIds(g).has(userId);
}

export function isGroupCreator(g: ApiGroup, userId: string): boolean {
  return Boolean(g.createdByUserId) && g.createdByUserId === userId;
}

/** Darf der aktuelle User `target` kicken? (UI-Spiegel von canRemoveMember) */
export function canKick(g: ApiGroup, actorId: string, targetId: string): boolean {
  if (actorId === targetId) return false; // "kick" ≠ "leave" in der UI
  if (!isGroupAdmin(g, actorId)) return false;
  if (isGroupCreator(g, targetId)) return false;
  if (isGroupAdmin(g, targetId) && !isGroupCreator(g, actorId)) return false;
  return true;
}

/** Darf der aktuelle User `target` befördern? */
export function canPromote(g: ApiGroup, actorId: string, targetId: string): boolean {
  if (!isGroupAdmin(g, actorId)) return false;
  if (!g.memberIds.includes(targetId)) return false;
  if (isGroupAdmin(g, targetId)) return false; // schon Admin
  return true;
}

/** Darf der aktuelle User `target` degradieren? (nur Ersteller) */
export function canDemote(g: ApiGroup, actorId: string, targetId: string): boolean {
  if (!isGroupCreator(g, actorId)) return false;
  if (isGroupCreator(g, targetId)) return false;
  return isGroupAdmin(g, targetId);
}
