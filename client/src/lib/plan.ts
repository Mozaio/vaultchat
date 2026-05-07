/**
 * VaultChat subscription plan state + feature-gating helpers.
 *
 * Phase 1 (this commit): pure-client mock — plan stored in localStorage,
 * upgrade flow is a no-op stub. Lets us build + ship the entire UI
 * without backend changes.
 *
 * Phase 2 (future): replace `loadPlan()` with a server JWT claim, add a
 * Stripe Checkout webhook that flips the bit. The UI never needs to know
 * the difference — `isPro()` / `canAddCustomEmoji()` etc. stay stable.
 *
 * Privacy note: the server only ever sees the subscription tier (free /
 * pro / team), never message content. Payment provider (Stripe) handles
 * card + billing email; VaultChat itself never touches them.
 */

export type PlanId = "free" | "pro" | "team";

export type PlanLimits = {
  customEmojiMax: number;
  voiceMaxMs: number;
  groupMemberMax: number;
  folderMax: number;
  hasProBadge: boolean;
  hasAuditLog: boolean;
};

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: {
    customEmojiMax: 16,
    voiceMaxMs: 60_000,
    groupMemberMax: 8,
    folderMax: 3,
    hasProBadge: false,
    hasAuditLog: false,
  },
  pro: {
    customEmojiMax: 50,
    voiceMaxMs: 5 * 60_000,
    groupMemberMax: 50,
    folderMax: 100,
    hasProBadge: true,
    hasAuditLog: false,
  },
  team: {
    customEmojiMax: 200,
    voiceMaxMs: 10 * 60_000,
    groupMemberMax: 200,
    folderMax: 500,
    hasProBadge: true,
    hasAuditLog: true,
  },
};

export const PLAN_LABELS: Record<PlanId, string> = {
  free: "Personal",
  pro: "Pro",
  team: "Team",
};

export const PLAN_PRICES: Record<PlanId, { eurMonthly: number; audience: string }> = {
  free: { eurMonthly: 0, audience: "Privat" },
  pro: { eurMonthly: 5, audience: "Power-User" },
  team: { eurMonthly: 9, audience: "Teams · pro Person" },
};

const STORAGE_KEY = "vaultchat.plan.v1";

export function loadPlan(): PlanId {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "free" || raw === "pro" || raw === "team") return raw;
  } catch {
    /* ignore */
  }
  return "free";
}

/**
 * Phase 1 stub: writes plan to localStorage as if the user upgraded.
 * In Phase 2 this becomes a no-op (server is source of truth).
 */
export function setPlanLocal(plan: PlanId): void {
  try {
    localStorage.setItem(STORAGE_KEY, plan);
  } catch {
    /* ignore */
  }
}

export function getLimits(plan: PlanId = loadPlan()): PlanLimits {
  return PLAN_LIMITS[plan];
}

export function isPro(plan: PlanId = loadPlan()): boolean {
  return plan === "pro" || plan === "team";
}

export function canAddCustomEmoji(currentCount: number, plan: PlanId = loadPlan()): boolean {
  return currentCount < getLimits(plan).customEmojiMax;
}

export function canRecordVoice(elapsedMs: number, plan: PlanId = loadPlan()): boolean {
  return elapsedMs < getLimits(plan).voiceMaxMs;
}

export function canAddFolder(currentCount: number, plan: PlanId = loadPlan()): boolean {
  return currentCount < getLimits(plan).folderMax;
}

export const PLAN_FEATURES: Record<PlanId, string[]> = {
  free: [
    "Ende-zu-Ende-Verschlüsselung",
    "Bis zu 16 eigene Emojis",
    "Sprachnachrichten bis 60 Sekunden",
    "Gruppen bis 8 Mitglieder",
    "3 Chat-Ordner",
  ],
  pro: [
    "Alles aus Personal",
    "Bis zu 50 eigene Emojis",
    "Sprachnachrichten bis 5 Minuten",
    "Gruppen bis 50 Mitglieder",
    "Unbegrenzt viele Ordner",
    "„Pro“-Badge im Profil",
    "Schnellere Server-Priorität",
  ],
  team: [
    "Alles aus Pro",
    "Gruppen bis 200 Mitglieder",
    "Bis zu 200 eigene Emojis",
    "Audit-Logs für Admins",
    "Geteilte Custom-Branding-Optionen",
    "Priorisierter E-Mail-Support",
  ],
};
