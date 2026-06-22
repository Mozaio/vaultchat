import assert from "node:assert/strict";
import test from "node:test";
import {
  FOCUSABLE_SELECTOR,
  isFocusableCandidate,
  nextFocusIndex,
} from "./useFocusTrap";

test("FOCUSABLE_SELECTOR excludes disabled controls but includes links/buttons/inputs", () => {
  assert.ok(FOCUSABLE_SELECTOR.includes("button:not([disabled])"));
  assert.ok(FOCUSABLE_SELECTOR.includes("input:not([disabled])"));
  assert.ok(FOCUSABLE_SELECTOR.includes("a[href]"));
  assert.ok(FOCUSABLE_SELECTOR.includes("[tabindex]"));
});

test("isFocusableCandidate: a plain enabled, visible element is focusable", () => {
  assert.equal(isFocusableCandidate({}), true);
  assert.equal(
    isFocusableCandidate({ display: "block", visibility: "visible", tabIndex: 0 }),
    true
  );
});

test("isFocusableCandidate: disabled / hidden / inert / negative-tabindex are not focusable", () => {
  assert.equal(isFocusableCandidate({ disabled: true }), false);
  assert.equal(isFocusableCandidate({ hidden: true }), false);
  assert.equal(isFocusableCandidate({ inInert: true }), false);
  assert.equal(isFocusableCandidate({ tabIndex: -1 }), false);
  assert.equal(isFocusableCandidate({ display: "none" }), false);
  assert.equal(isFocusableCandidate({ visibility: "hidden" }), false);
  assert.equal(isFocusableCandidate({ visibility: "collapse" }), false);
});

test("isFocusableCandidate: tabIndex 0 / positive is focusable", () => {
  assert.equal(isFocusableCandidate({ tabIndex: 0 }), true);
  assert.equal(isFocusableCandidate({ tabIndex: 2 }), true);
});

test("nextFocusIndex: forward wraps from last to first", () => {
  assert.equal(nextFocusIndex(0, 3, false), 1);
  assert.equal(nextFocusIndex(1, 3, false), 2);
  assert.equal(nextFocusIndex(2, 3, false), 0); // wrap
});

test("nextFocusIndex: backward wraps from first to last", () => {
  assert.equal(nextFocusIndex(2, 3, true), 1);
  assert.equal(nextFocusIndex(1, 3, true), 0);
  assert.equal(nextFocusIndex(0, 3, true), 2); // wrap
});

test("nextFocusIndex: focus outside the trap (-1) goes to first on Tab, last on Shift+Tab", () => {
  assert.equal(nextFocusIndex(-1, 4, false), 0);
  assert.equal(nextFocusIndex(-1, 4, true), 3);
});

test("nextFocusIndex: single focusable element always returns that element", () => {
  assert.equal(nextFocusIndex(0, 1, false), 0);
  assert.equal(nextFocusIndex(0, 1, true), 0);
  assert.equal(nextFocusIndex(-1, 1, false), 0);
});

test("nextFocusIndex: empty trap returns -1", () => {
  assert.equal(nextFocusIndex(0, 0, false), -1);
  assert.equal(nextFocusIndex(-1, 0, true), -1);
});
