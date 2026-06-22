import assert from "node:assert/strict";
import test from "node:test";
import {
  levelFor,
  setLevel,
  shouldNotify,
  type NotifyState,
} from "./notifyPrefs";

function empty(): NotifyState {
  return { muted: new Set(), mentionsOnly: new Set() };
}

test("default level is 'all'", () => {
  assert.equal(levelFor(empty(), "g1"), "all");
});

test("muted set => 'none'; mentionsOnly set => 'mentions'", () => {
  const s: NotifyState = {
    muted: new Set(["a"]),
    mentionsOnly: new Set(["b"]),
  };
  assert.equal(levelFor(s, "a"), "none");
  assert.equal(levelFor(s, "b"), "mentions");
  assert.equal(levelFor(s, "c"), "all");
});

test("shouldNotify: all => always", () => {
  assert.equal(shouldNotify("all", false), true);
  assert.equal(shouldNotify("all", true), true);
});

test("shouldNotify: mentions => only when mentioned", () => {
  assert.equal(shouldNotify("mentions", false), false);
  assert.equal(shouldNotify("mentions", true), true);
});

test("shouldNotify: none => still lets a direct @ping through (Discord)", () => {
  assert.equal(shouldNotify("none", false), false);
  assert.equal(shouldNotify("none", true), true);
});

test("setLevel keeps an id in at most one set", () => {
  let s = empty();
  s = setLevel(s, "g1", "mentions");
  assert.equal(levelFor(s, "g1"), "mentions");
  assert.ok(s.mentionsOnly.has("g1"));
  assert.ok(!s.muted.has("g1"));

  s = setLevel(s, "g1", "none");
  assert.equal(levelFor(s, "g1"), "none");
  assert.ok(s.muted.has("g1"));
  assert.ok(!s.mentionsOnly.has("g1"));

  s = setLevel(s, "g1", "all");
  assert.equal(levelFor(s, "g1"), "all");
  assert.ok(!s.muted.has("g1"));
  assert.ok(!s.mentionsOnly.has("g1"));
});

test("setLevel does not mutate the input state", () => {
  const s = empty();
  const next = setLevel(s, "x", "none");
  assert.equal(s.muted.size, 0, "input unchanged");
  assert.equal(next.muted.size, 1);
});
