import assert from "node:assert/strict";
import test, { mock } from "node:test";

globalThis.btoa ??= (v: string) => Buffer.from(v, "binary").toString("base64");
globalThis.atob ??= (v: string) => Buffer.from(v, "base64").toString("binary");

// In-memory stand-in for the encrypted-at-rest IDB meta store, mirroring the
// profileKeys.test.ts pattern, so the Community-GMK persistence/rotation +
// meta-encryption can be exercised without IndexedDB.
const store = new Map<string, string>();
mock.module("./idb.ts", {
  namedExports: {
    metaGet: async (k: string) => (store.has(k) ? store.get(k)! : null),
    metaSet: async (k: string, v: string) => {
      store.set(k, v);
    },
  },
});

// Import AFTER the mock is registered.
const {
  getCommunitySecret,
  ensureCommunitySecret,
  rotateCommunitySecret,
  adoptCommunitySecret,
  deleteCommunitySecret,
  encryptCommunityMeta,
  decryptCommunityMeta,
  isEncryptedCommunityMeta,
} = await import("./communitySecret.ts");

const CID = "community-1";

test("ensureCommunitySecret creates a 32-byte key at epoch 1 and is idempotent", async () => {
  store.clear();
  assert.equal(await getCommunitySecret(CID), null);
  const a = await ensureCommunitySecret(CID);
  assert.equal(a.epoch, 1);
  assert.equal(Buffer.from(a.keyB64, "base64").length, 32);
  const b = await ensureCommunitySecret(CID);
  assert.deepEqual(b, a, "second call returns the same persisted key");
});

test("rotateCommunitySecret bumps the epoch and changes the key", async () => {
  store.clear();
  const first = await ensureCommunitySecret(CID);
  const rotated = await rotateCommunitySecret(CID);
  assert.equal(rotated.epoch, first.epoch + 1);
  assert.notEqual(rotated.keyB64, first.keyB64);
  const got = await getCommunitySecret(CID);
  assert.deepEqual(got, rotated);
});

test("encrypt → decrypt round-trips community/channel meta", async () => {
  store.clear();
  await ensureCommunitySecret(CID);
  const wire = await encryptCommunityMeta(CID, "Mein Space 🌌 / #allgemein");
  assert.ok(wire, "wire produced");
  assert.ok(isEncryptedCommunityMeta(wire), "carries CMETA1: prefix");
  assert.ok(wire!.startsWith("CMETA1:"));
  const back = await decryptCommunityMeta(CID, wire!);
  assert.equal(back, "Mein Space 🌌 / #allgemein");
});

test("encryptCommunityMeta returns null when no key is present (placeholder fallback)", async () => {
  store.clear();
  const wire = await encryptCommunityMeta("no-key-community", "x");
  assert.equal(wire, null);
});

test("decrypt fails closed on a different/rotated epoch", async () => {
  store.clear();
  await ensureCommunitySecret(CID);
  const wire = await encryptCommunityMeta(CID, "secret name");
  assert.ok(wire);
  // Rotate: the old ciphertext was made under epoch 1, the live key is epoch 2.
  await rotateCommunitySecret(CID);
  const back = await decryptCommunityMeta(CID, wire!);
  assert.equal(back, null, "stale-epoch ciphertext must not decrypt");
});

test("adoptCommunitySecret: higher epoch wins, older ignored", async () => {
  store.clear();
  await adoptCommunitySecret(CID, Buffer.alloc(32, 7).toString("base64"), 5);
  let cur = await getCommunitySecret(CID);
  assert.equal(cur!.epoch, 5);
  // older epoch ignored
  await adoptCommunitySecret(CID, Buffer.alloc(32, 1).toString("base64"), 3);
  cur = await getCommunitySecret(CID);
  assert.equal(cur!.epoch, 5);
  // higher epoch adopted
  await adoptCommunitySecret(CID, Buffer.alloc(32, 9).toString("base64"), 6);
  cur = await getCommunitySecret(CID);
  assert.equal(cur!.epoch, 6);
});

test("isEncryptedCommunityMeta distinguishes ciphertext from plaintext/placeholder", () => {
  assert.equal(isEncryptedCommunityMeta("CMETA1:1:abc"), true);
  assert.equal(isEncryptedCommunityMeta("plain name"), false);
  assert.equal(isEncryptedCommunityMeta("🔒"), false);
  assert.equal(isEncryptedCommunityMeta(undefined), false);
  assert.equal(isEncryptedCommunityMeta(null), false);
});

test("deleteCommunitySecret clears the key (treated as absent)", async () => {
  store.clear();
  await ensureCommunitySecret(CID);
  assert.ok(await getCommunitySecret(CID));
  await deleteCommunitySecret(CID);
  assert.equal(await getCommunitySecret(CID), null);
});
