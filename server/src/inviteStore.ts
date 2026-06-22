import { randomBytes } from "node:crypto";
import {
  loadPersistedGroupInvites,
  persistGroupInvites,
  type PersistedGroupInvite,
} from "./serverState.js";
import { addGroupMemberByInvite, getGroup } from "./memoryStore.js";
import { canManageInvites } from "./groupRoles.js";

/** Group invite tokens. Stored alongside accounts/groups in the same JSON state file. */

const invites = new Map<string, PersistedGroupInvite>(
  loadPersistedGroupInvites().map((inv) => [inv.token, inv])
);

function persist(): void {
  persistGroupInvites([...invites.values()]);
}

/** 24 random bytes -> 32 url-safe base64 characters. ~190 bits of entropy. */
function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export type InviteSummary = {
  token: string;
  groupId: string;
  createdByUserId: string;
  createdAt: number;
  expiresAt: number;
  maxUses: number;
  usedCount: number;
};

function shape(inv: PersistedGroupInvite): InviteSummary {
  return {
    token: inv.token,
    groupId: inv.groupId,
    createdByUserId: inv.createdByUserId,
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    maxUses: inv.maxUses,
    usedCount: inv.usedCount,
  };
}

/**
 * Creates a new invite. Only group admins (incl. the creator) may issue
 * invites — enforced via the shared role policy (`groupRoles`).
 */
export function createInvite(
  groupId: string,
  actorId: string,
  opts: { ttlMs?: number; maxUses?: number } = {}
): InviteSummary | { error: "unknown_group" | "forbidden" } {
  const g = getGroup(groupId);
  if (!g) return { error: "unknown_group" };
  if (!canManageInvites(g, actorId)) return { error: "forbidden" };

  const now = Date.now();
  const ttlMs = Math.max(0, Math.floor(opts.ttlMs ?? 7 * 24 * 60 * 60 * 1000));
  const maxUses = Math.max(0, Math.floor(opts.maxUses ?? 0));
  const inv: PersistedGroupInvite = {
    token: newToken(),
    groupId,
    createdByUserId: actorId,
    createdAt: now,
    expiresAt: ttlMs > 0 ? now + ttlMs : 0,
    maxUses,
    usedCount: 0,
  };
  invites.set(inv.token, inv);
  persist();
  return shape(inv);
}

export function listInvites(
  groupId: string,
  actorId: string
): InviteSummary[] | { error: "unknown_group" | "forbidden" } {
  const g = getGroup(groupId);
  if (!g) return { error: "unknown_group" };
  if (!canManageInvites(g, actorId)) return { error: "forbidden" };
  return [...invites.values()]
    .filter((inv) => inv.groupId === groupId)
    .map(shape);
}

export function revokeInvite(
  token: string,
  actorId: string
): { ok: true } | { error: "unknown_token" | "forbidden" } {
  const inv = invites.get(token);
  if (!inv) return { error: "unknown_token" };
  const g = getGroup(inv.groupId);
  if (!g || !canManageInvites(g, actorId)) return { error: "forbidden" };
  invites.delete(token);
  persist();
  return { ok: true };
}

/**
 * Validates the token, runs addGroupMember on the caller's behalf, and
 * bumps usedCount. Caller is the user joining; we treat the group's
 * creator as the actor so the membership add bypasses the normal
 * "must already be a member" check via a dedicated path.
 */
export function redeemInvite(
  token: string,
  userId: string
):
  | { ok: true; groupId: string; usedCount: number; maxUses: number }
  | { error: "unknown_token" | "expired" | "exhausted" | "already_member" | "join_failed" } {
  const inv = invites.get(token);
  if (!inv) return { error: "unknown_token" };
  if (inv.expiresAt > 0 && Date.now() > inv.expiresAt) {
    return { error: "expired" };
  }
  if (inv.maxUses > 0 && inv.usedCount >= inv.maxUses) {
    return { error: "exhausted" };
  }
  const g = getGroup(inv.groupId);
  if (!g) return { error: "unknown_token" };
  if (g.memberIds.includes(userId)) return { error: "already_member" };
  // The token itself is the authorization (it was minted by an admin and is
  // validated above for expiry/usage), so we add via the token-authorized path
  // rather than impersonating a live admin — this still works even if the
  // original inviter has since left or been demoted.
  const updated = addGroupMemberByInvite(inv.groupId, userId);
  if (!updated) return { error: "join_failed" };
  inv.usedCount += 1;
  invites.set(inv.token, inv);
  persist();
  return {
    ok: true,
    groupId: inv.groupId,
    usedCount: inv.usedCount,
    maxUses: inv.maxUses,
  };
}
