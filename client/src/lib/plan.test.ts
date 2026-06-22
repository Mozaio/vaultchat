import assert from "node:assert/strict";
import test from "node:test";
import {
  PLAN_LIMITS,
  PLAN_FEATURE_KEYS,
  getLimits,
  isPro,
  canAddCustomEmoji,
  canRecordVoice,
  canAddFolder,
  isGroupSizeAllowed,
  type PlanId,
} from "./plan";

const PLANS: PlanId[] = ["free", "pro", "team"];

test("getLimits returns the table entry for each plan", () => {
  for (const p of PLANS) {
    assert.deepEqual(getLimits(p), PLAN_LIMITS[p]);
  }
});

test("isPro: free is not pro; pro and team are", () => {
  assert.equal(isPro("free"), false);
  assert.equal(isPro("pro"), true);
  assert.equal(isPro("team"), true);
});

test("limits are monotonically non-decreasing free <= pro <= team", () => {
  const keys = [
    "customEmojiMax",
    "voiceMaxMs",
    "groupMemberMax",
    "folderMax",
  ] as const;
  for (const k of keys) {
    assert.ok(
      PLAN_LIMITS.free[k] <= PLAN_LIMITS.pro[k],
      `free.${k} <= pro.${k}`
    );
    assert.ok(
      PLAN_LIMITS.pro[k] <= PLAN_LIMITS.team[k],
      `pro.${k} <= team.${k}`
    );
  }
});

test("canAddCustomEmoji: strict boundary at the limit (free max 16)", () => {
  assert.equal(canAddCustomEmoji(0, "free"), true);
  assert.equal(canAddCustomEmoji(15, "free"), true); // 16th allowed
  assert.equal(canAddCustomEmoji(16, "free"), false); // at the cap → no more
  assert.equal(canAddCustomEmoji(17, "free"), false);
  // pro has a larger cap
  assert.equal(canAddCustomEmoji(16, "pro"), true);
  assert.equal(canAddCustomEmoji(50, "pro"), false);
});

test("canRecordVoice: must be strictly under the cap (free 60s)", () => {
  assert.equal(canRecordVoice(0, "free"), true);
  assert.equal(canRecordVoice(59_999, "free"), true);
  assert.equal(canRecordVoice(60_000, "free"), false); // at the cap
  assert.equal(canRecordVoice(60_000, "pro"), true); // pro cap is 5min
  assert.equal(canRecordVoice(5 * 60_000, "pro"), false);
});

test("canAddFolder: strict boundary at the limit (free max 3)", () => {
  assert.equal(canAddFolder(0, "free"), true);
  assert.equal(canAddFolder(2, "free"), true); // 3rd allowed
  assert.equal(canAddFolder(3, "free"), false); // at the cap
  assert.equal(canAddFolder(3, "pro"), true);
});

test("isGroupSizeAllowed: total members including creator must be <= cap", () => {
  // free cap is 8 → a group of exactly 8 is allowed, 9 is not
  assert.equal(isGroupSizeAllowed(1, "free"), true);
  assert.equal(isGroupSizeAllowed(8, "free"), true);
  assert.equal(isGroupSizeAllowed(9, "free"), false);
  assert.equal(isGroupSizeAllowed(9, "pro"), true);
  assert.equal(isGroupSizeAllowed(50, "pro"), true);
  assert.equal(isGroupSizeAllowed(51, "pro"), false);
  assert.equal(isGroupSizeAllowed(200, "team"), true);
  assert.equal(isGroupSizeAllowed(201, "team"), false);
});

test("every plan defines a non-empty feature-bullet list", () => {
  for (const p of PLANS) {
    assert.ok(
      Array.isArray(PLAN_FEATURE_KEYS[p]) && PLAN_FEATURE_KEYS[p].length > 0,
      `${p} has feature keys`
    );
  }
});
