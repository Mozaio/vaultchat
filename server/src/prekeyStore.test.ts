import assert from "node:assert/strict";
import test from "node:test";
import {
  getPreKeyBundle,
  getRemainingPreKeyCount,
  initPreKeyBundle,
  uploadOneTimePreKeys,
} from "./prekeyStore.js";

test("one-time prekeys are consumed once, last one kept as last-resort (#15)", () => {
  // OTK-exhaustion DoS mitigation (#15): getPreKeyBundle consumes (deletes)
  // a one-time prekey on each fetch EXCEPT the final one, which is retained
  // and re-served as a reusable last-resort key. This prevents an attacker
  // from draining the pool via repeated /api/keys fetches and blocking new
  // sessions. The test below pins that deliberate behavior — it previously
  // asserted the pre-#15 "consume to zero" semantics and was stale.
  const userId = "user-prekey-consume";
  initPreKeyBundle(userId, "identity", "signed-public", "signed-signature");
  uploadOneTimePreKeys(userId, [
    { keyId: 1, publicKey: "otp-1" },
    { keyId: 2, publicKey: "otp-2" },
  ]);

  const first = getPreKeyBundle(userId);
  const second = getPreKeyBundle(userId);
  const third = getPreKeyBundle(userId);

  // First fetch consumes otp-1, leaving exactly one (otp-2) in the pool.
  assert.equal(first?.oneTimePreKey?.publicKey, "otp-1");
  assert.equal(first?.remainingPreKeys, 1);
  // Second fetch hands out the last key but does NOT delete it (last-resort).
  assert.equal(second?.oneTimePreKey?.publicKey, "otp-2");
  assert.equal(second?.remainingPreKeys, 1);
  // Third fetch keeps re-serving the retained last-resort key.
  assert.equal(third?.oneTimePreKey?.publicKey, "otp-2");
  assert.equal(third?.remainingPreKeys, 1);
  assert.equal(getRemainingPreKeyCount(userId), 1);
});

test("a fresh upload makes the previously last-resort key consumable again", () => {
  // Once the client replenishes the pool, the formerly retained last-resort
  // key is no longer the last one and becomes consumable on the next fetch.
  const userId = "user-prekey-replenish";
  initPreKeyBundle(userId, "identity", "signed-public", "signed-signature");
  uploadOneTimePreKeys(userId, [{ keyId: 1, publicKey: "otp-1" }]);

  // Only one key uploaded → it is the last-resort key and is retained.
  assert.equal(getPreKeyBundle(userId)?.oneTimePreKey?.publicKey, "otp-1");
  assert.equal(getRemainingPreKeyCount(userId), 1);

  // Client replenishes the pool.
  uploadOneTimePreKeys(userId, [{ keyId: 2, publicKey: "otp-2" }]);
  assert.equal(getRemainingPreKeyCount(userId), 2);

  // Next fetch consumes one (insertion order → otp-1), leaving one retained.
  const after = getPreKeyBundle(userId);
  assert.equal(after?.oneTimePreKey?.publicKey, "otp-1");
  assert.equal(after?.remainingPreKeys, 1);
});

test("signed prekey remains available when one-time prekeys are exhausted", () => {
  const userId = "user-prekey-signed-only";
  initPreKeyBundle(
    userId,
    "identity-2",
    "signed-public-2",
    "signed-signature-2",
    undefined,
    42
  );

  const bundle = getPreKeyBundle(userId);

  assert.deepEqual(bundle, {
    identityKey: "identity-2",
    signedPreKey: {
      keyId: 42,
      publicKey: "signed-public-2",
      signature: "signed-signature-2",
    },
    remainingPreKeys: 0,
    oneTimePreKey: null,
  });
});

test("prekey bundle can advertise an optional post-quantum kem key", () => {
  const userId = "user-prekey-pq";
  initPreKeyBundle(
    userId,
    "identity-pq",
    "signed-public-pq",
    "signed-signature-pq",
    undefined,
    7,
    { alg: "ML-KEM-1024", publicKey: "pq-public" }
  );

  const bundle = getPreKeyBundle(userId);

  assert.equal(bundle?.pqKem?.alg, "ML-KEM-1024");
  assert.equal(bundle?.pqKem?.publicKey, "pq-public");
});
