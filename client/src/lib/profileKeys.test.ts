import assert from "node:assert/strict";
import test, { mock } from "node:test";

globalThis.btoa ??= (v: string) => Buffer.from(v, "binary").toString("base64");
globalThis.atob ??= (v: string) => Buffer.from(v, "base64").toString("binary");

// In-memory stand-in for the encrypted-at-rest IDB meta store, so the key
// persistence/rotation logic can be exercised without IndexedDB.
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
  getOwnProfileKey,
  ensureOwnProfileKey,
  rotateOwnProfileKey,
  getContactProfileKey,
  adoptContactProfileKey,
  deleteContactProfileKey,
} = await import("./profileKeys.ts");

test("ensureOwnProfileKey creates a 32-byte key at epoch 1 and is idempotent", async () => {
  store.clear();
  assert.equal(await getOwnProfileKey(), null);
  const a = await ensureOwnProfileKey();
  assert.equal(a.epoch, 1);
  assert.equal(Buffer.from(a.keyB64, "base64").length, 32);
  const b = await ensureOwnProfileKey();
  assert.deepEqual(b, a, "second call returns the same persisted key");
});

test("rotateOwnProfileKey bumps the epoch and changes the key", async () => {
  store.clear();
  const first = await ensureOwnProfileKey();
  const rotated = await rotateOwnProfileKey();
  assert.equal(rotated.epoch, first.epoch + 1);
  assert.notEqual(rotated.keyB64, first.keyB64);
  // The persisted key is now the rotated one.
  assert.deepEqual(await getOwnProfileKey(), rotated);
});

test("adoptContactProfileKey stores a contact's key and keeps the highest epoch", async () => {
  store.clear();
  assert.equal(await getContactProfileKey("u1"), null);

  // First adoption wins.
  assert.equal(await adoptContactProfileKey("u1", "KEY_E1", 1), true);
  assert.deepEqual(await getContactProfileKey("u1"), {
    keyB64: "KEY_E1",
    epoch: 1,
  });

  // A higher epoch replaces it.
  assert.equal(await adoptContactProfileKey("u1", "KEY_E2", 2), true);
  assert.deepEqual(await getContactProfileKey("u1"), {
    keyB64: "KEY_E2",
    epoch: 2,
  });

  // A stale (lower or equal) epoch is ignored — no downgrade on late re-share.
  assert.equal(await adoptContactProfileKey("u1", "KEY_OLD", 1), false);
  assert.equal(await adoptContactProfileKey("u1", "KEY_SAME", 2), false);
  assert.deepEqual(await getContactProfileKey("u1"), {
    keyB64: "KEY_E2",
    epoch: 2,
  });
});

test("contacts' keys are isolated by userId", async () => {
  store.clear();
  await adoptContactProfileKey("a", "KA", 5);
  await adoptContactProfileKey("b", "KB", 1);
  assert.equal((await getContactProfileKey("a"))?.keyB64, "KA");
  assert.equal((await getContactProfileKey("b"))?.keyB64, "KB");
});

test("deleteContactProfileKey clears a contact's key", async () => {
  store.clear();
  await adoptContactProfileKey("z", "KZ", 3);
  assert.ok(await getContactProfileKey("z"));
  await deleteContactProfileKey("z");
  assert.equal(await getContactProfileKey("z"), null);
});

test("adoptContactProfileKey ignores empty inputs", async () => {
  store.clear();
  assert.equal(await adoptContactProfileKey("", "K", 1), false);
  assert.equal(await adoptContactProfileKey("u", "", 1), false);
});
