import assert from "node:assert/strict";
import test from "node:test";
import {
  getPreKeyBundle,
  getRemainingPreKeyCount,
  initPreKeyBundle,
  uploadOneTimePreKeys,
} from "./prekeyStore.js";

test("one-time prekeys are consumed exactly once", () => {
  const userId = "user-prekey-consume";
  initPreKeyBundle(userId, "identity", "signed-public", "signed-signature");
  uploadOneTimePreKeys(userId, [
    { keyId: 1, publicKey: "otp-1" },
    { keyId: 2, publicKey: "otp-2" },
  ]);

  const first = getPreKeyBundle(userId);
  const second = getPreKeyBundle(userId);
  const third = getPreKeyBundle(userId);

  assert.equal(first?.oneTimePreKey?.publicKey, "otp-1");
  assert.equal(first?.remainingPreKeys, 1);
  assert.equal(second?.oneTimePreKey?.publicKey, "otp-2");
  assert.equal(second?.remainingPreKeys, 0);
  assert.equal(third?.oneTimePreKey, null);
  assert.equal(third?.remainingPreKeys, 0);
  assert.equal(getRemainingPreKeyCount(userId), 0);
});

test("signed prekey remains available when one-time prekeys are exhausted", () => {
  const userId = "user-prekey-signed-only";
  initPreKeyBundle(userId, "identity-2", "signed-public-2", "signed-signature-2");

  const bundle = getPreKeyBundle(userId);

  assert.deepEqual(bundle, {
    identityKey: "identity-2",
    signedPreKey: {
      keyId: 1,
      publicKey: "signed-public-2",
      signature: "signed-signature-2",
    },
    remainingPreKeys: 0,
    oneTimePreKey: null,
  });
});
