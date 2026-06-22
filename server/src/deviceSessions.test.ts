import assert from "node:assert/strict";
import test from "node:test";
import {
  _resetDeviceSessionsForTest,
  clearRevokedDevices,
  isDeviceRevoked,
  revokeDevice,
} from "./deviceSessions.js";

test("a device is not revoked by default", () => {
  _resetDeviceSessionsForTest();
  assert.equal(isDeviceRevoked("user-a", "dev-1"), false);
});

test("revokeDevice marks exactly that (user, device) pair", () => {
  _resetDeviceSessionsForTest();
  revokeDevice("user-a", "dev-1");
  assert.equal(isDeviceRevoked("user-a", "dev-1"), true);
  // A different device of the same user stays valid.
  assert.equal(isDeviceRevoked("user-a", "dev-2"), false);
  // The same device id under a different user stays valid (isolation).
  assert.equal(isDeviceRevoked("user-b", "dev-1"), false);
});

test("revokeDevice is idempotent", () => {
  _resetDeviceSessionsForTest();
  revokeDevice("user-a", "dev-1");
  revokeDevice("user-a", "dev-1");
  assert.equal(isDeviceRevoked("user-a", "dev-1"), true);
});

test("clearRevokedDevices wipes a user's whole revoked set", () => {
  _resetDeviceSessionsForTest();
  revokeDevice("user-a", "dev-1");
  revokeDevice("user-a", "dev-2");
  clearRevokedDevices("user-a");
  assert.equal(isDeviceRevoked("user-a", "dev-1"), false);
  assert.equal(isDeviceRevoked("user-a", "dev-2"), false);
});

test("empty/missing inputs never count as revoked", () => {
  _resetDeviceSessionsForTest();
  revokeDevice("", "dev-1"); // no-op
  revokeDevice("user-a", ""); // no-op
  assert.equal(isDeviceRevoked("", "dev-1"), false);
  assert.equal(isDeviceRevoked("user-a", ""), false);
});

test("the revoked set is capped (no unbounded growth)", () => {
  _resetDeviceSessionsForTest();
  // Push well past the internal cap (512). The most recent must survive; the
  // oldest are evicted. We don't assert the exact eviction point, only that
  // recent entries stick and the structure doesn't blow up.
  for (let i = 0; i < 600; i++) revokeDevice("user-a", `dev-${i}`);
  assert.equal(isDeviceRevoked("user-a", "dev-599"), true);
  assert.equal(isDeviceRevoked("user-a", "dev-598"), true);
  // A very old one should have been evicted.
  assert.equal(isDeviceRevoked("user-a", "dev-0"), false);
});
