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

/** `audience` holds an i18n key resolved via t() at render time. */
export const PLAN_PRICES: Record<PlanId, { eurMonthly: number; audience: string }> = {
  free: { eurMonthly: 0, audience: "plan.aud.free" },
  pro: { eurMonthly: 5, audience: "plan.aud.pro" },
  team: { eurMonthly: 9, audience: "plan.aud.team" },
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

/**
 * Per-plan feature bullets as i18n keys. Resolve each with t() at render
 * time so the pricing cards follow the chosen language.
 */
export const PLAN_FEATURE_KEYS: Record<PlanId, string[]> = {
  free: [
    "plan.feat.e2ee",
    "plan.feat.emoji16",
    "plan.feat.voice60s",
    "plan.feat.group8",
    "plan.feat.folders3",
  ],
  pro: [
    "plan.feat.allPersonal",
    "plan.feat.emoji50",
    "plan.feat.voice5m",
    "plan.feat.group50",
    "plan.feat.foldersUnlimited",
    "plan.feat.proBadge",
    "plan.feat.priority",
  ],
  team: [
    "plan.feat.allPro",
    "plan.feat.group200",
    "plan.feat.emoji200",
    "plan.feat.auditLogs",
    "plan.feat.branding",
    "plan.feat.emailSupport",
  ],
};
