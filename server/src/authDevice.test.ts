import assert from "node:assert/strict";
import test from "node:test";
import {
  setDeviceRevokedResolver,
  signToken,
  verifyToken,
} from "./auth.js";

// auth.ts falls back to a dev JWT secret when VAULTCHAT_JWT_SECRET is unset
// (non-production), so sign/verify works in the test runner.

test("signToken embeds the deviceId and verifyToken returns it", () => {
  setDeviceRevokedResolver(() => false);
  const token = signToken({
    userId: "u1",
    username: "alice",
    deviceId: "device-abc",
  });
  const decoded = verifyToken(token);
  assert.ok(decoded);
  assert.equal(decoded?.userId, "u1");
  assert.equal(decoded?.deviceId, "device-abc");
});

test("a token without a deviceId verifies and reports no deviceId", () => {
  setDeviceRevokedResolver(() => false);
  const token = signToken({ userId: "u2", username: "bob" });
  const decoded = verifyToken(token);
  assert.ok(decoded);
  assert.equal(decoded?.deviceId, undefined);
});

test("device-revoked resolver invalidates exactly the revoked token", () => {
  // Revoke only device "bad" of user "u3".
  setDeviceRevokedResolver(
    (userId, deviceId) => userId === "u3" && deviceId === "bad"
  );
  const revoked = signToken({
    userId: "u3",
    username: "carol",
    deviceId: "bad",
  });
  const good = signToken({
    userId: "u3",
    username: "carol",
    deviceId: "good",
  });
  assert.equal(verifyToken(revoked), null, "revoked device token must reject");
  assert.ok(verifyToken(good), "other device of same user stays valid");
});

test("a resolver that throws does not lock everyone out (fail-open)", () => {
  setDeviceRevokedResolver(() => {
    throw new Error("resolver boom");
  });
  const token = signToken({
    userId: "u4",
    username: "dave",
    deviceId: "device-x",
  });
  // Availability beats an edge-case revoke: a throwing resolver must not
  // invalidate the token.
  assert.ok(verifyToken(token));
  // Reset so we don't leak a throwing resolver into other test files.
  setDeviceRevokedResolver(() => false);
});

test("tokens without a deviceId skip the device-revocation check", () => {
  setDeviceRevokedResolver(() => {
    throw new Error("should not be called for tokens without dv");
  });
  const token = signToken({ userId: "u5", username: "erin" });
  assert.ok(verifyToken(token));
  setDeviceRevokedResolver(() => false);
});
