import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHistoryBundle,
  encryptHistoryBackup,
  parseHistoryBackup,
  type HistoryBundle,
} from "./historyBackup";
import type { StoredDmMessage, StoredGroupMessage } from "./idb";

globalThis.btoa ??= (value: string) =>
  Buffer.from(value, "binary").toString("base64");
globalThis.atob ??= (value: string) =>
  Buffer.from(value, "base64").toString("binary");

const sampleDm: StoredDmMessage[] = [
  {
    id: "dm-1",
    peerId: "peer-a",
    fromMe: true,
    plainJson: JSON.stringify({ v: 2, cid: "c1", kind: "text", body: "hallo" }),
    at: 1000,
  },
  {
    id: "dm-2",
    peerId: "peer-b",
    fromMe: false,
    plainJson: JSON.stringify({ v: 2, cid: "c2", kind: "text", body: "hi 🦊" }),
    at: 2000,
    // expiresAt soll bewusst NICHT mitgesichert werden.
    expiresAt: 9_999_999_999_999,
  },
];

const sampleGroup: StoredGroupMessage[] = [
  {
    id: "g-1",
    groupId: "grp-x",
    fromUserId: "user-z",
    plainJson: JSON.stringify({ v: 2, cid: "g1", kind: "text", body: "gruppe" }),
    at: 1500,
  },
];

test("buildHistoryBundle strips expiresAt and keeps the core fields", () => {
  const bundle = buildHistoryBundle(sampleDm, sampleGroup);
  assert.equal(bundle.dm.length, 2);
  assert.equal(bundle.group.length, 1);
  // expiresAt must not leak into the bundle.
  assert.ok(!("expiresAt" in bundle.dm[1]!));
  assert.equal(bundle.dm[0]!.peerId, "peer-a");
  assert.equal(bundle.group[0]!.groupId, "grp-x");
});

test("encryptHistoryBackup output has all required fields", async () => {
  const bundle = buildHistoryBundle(sampleDm, sampleGroup);
  const enc = await encryptHistoryBackup(bundle, "x");
  assert.equal(enc.type, "vaultchat.history.backup");
  assert.equal(enc.version, 1);
  assert.equal(enc.kdf, "argon2id");
  assert.ok(enc.salt.length > 0);
  assert.ok(enc.nonce.length > 0);
  assert.ok(enc.cipher.length > 0);
  assert.ok(enc.createdAt);
  assert.ok(Number.isFinite(Date.parse(enc.createdAt)));
  assert.equal(enc.count, 3);
});

test("encryptHistoryBackup uses a fresh salt+nonce on every call", async () => {
  const bundle = buildHistoryBundle(sampleDm, sampleGroup);
  const a = await encryptHistoryBackup(bundle, "same-pw");
  const b = await encryptHistoryBackup(bundle, "same-pw");
  assert.notEqual(a.salt, b.salt, "salt must be random per call");
  assert.notEqual(a.nonce, b.nonce, "nonce must be random per call");
  assert.notEqual(a.cipher, b.cipher, "cipher must differ — distinct salt+nonce");
});

test("encryptHistoryBackup roundtrips with parseHistoryBackup", async () => {
  const bundle = buildHistoryBundle(sampleDm, sampleGroup);
  const enc = await encryptHistoryBackup(bundle, "my-history-pw");
  const back = await parseHistoryBackup(JSON.stringify(enc), () => "my-history-pw");
  assert.deepEqual(back, bundle);
  // Spot-check the message content survives the round-trip intact.
  assert.equal(
    JSON.parse(back.dm[1]!.plainJson).body,
    "hi 🦊",
    "unicode body must survive"
  );
});

test("parseHistoryBackup rejects invalid JSON", async () => {
  await assert.rejects(
    parseHistoryBackup("not-json{", () => "pw"),
    (e: unknown) => e instanceof SyntaxError
  );
});

test("parseHistoryBackup rejects a non-history backup blob", async () => {
  await assert.rejects(
    parseHistoryBackup(
      JSON.stringify({ type: "vaultchat.identity.backup", version: 2 }),
      () => "x"
    ),
    (e: Error) => e.message === "history_backup_must_be_encrypted_v1"
  );
  await assert.rejects(
    parseHistoryBackup(JSON.stringify({}), () => "x"),
    (e: Error) => e.message === "history_backup_must_be_encrypted_v1"
  );
});

test("parseHistoryBackup requires a passphrase", async () => {
  const enc = await encryptHistoryBackup(
    buildHistoryBundle(sampleDm, sampleGroup),
    "secret"
  );
  await assert.rejects(
    parseHistoryBackup(JSON.stringify(enc), () => null),
    (e: Error) => e.message === "history_backup_passphrase_required"
  );
});

test("parseHistoryBackup rejects a wrong passphrase", async () => {
  const enc = await encryptHistoryBackup(
    buildHistoryBundle(sampleDm, sampleGroup),
    "right-one"
  );
  await assert.rejects(
    parseHistoryBackup(JSON.stringify(enc), () => "wrong-one"),
    (e: Error) => e.message === "history_backup_passphrase_wrong_or_tampered"
  );
});

test("parseHistoryBackup rejects tampered ciphertext with the same code", async () => {
  const enc = await encryptHistoryBackup(
    buildHistoryBundle(sampleDm, sampleGroup),
    "pw-1"
  );
  const cipherBytes = Buffer.from(enc.cipher, "base64");
  cipherBytes[cipherBytes.length - 1] ^= 0x01;
  const tampered = { ...enc, cipher: cipherBytes.toString("base64") };
  await assert.rejects(
    parseHistoryBackup(JSON.stringify(tampered), () => "pw-1"),
    (e: Error) => e.message === "history_backup_passphrase_wrong_or_tampered"
  );
});

test("parseHistoryBackup rejects a wrong-shape (but correctly-encrypted) bundle", async () => {
  // Encrypt a structurally bogus "bundle" with a valid passphrase, then prove
  // the shape guard fires (predictable error, not a late NPE on import).
  const bogus = { dm: [{ id: 5 }], group: [] } as unknown as HistoryBundle;
  const enc = await encryptHistoryBackup(bogus, "pw-shape");
  await assert.rejects(
    parseHistoryBackup(JSON.stringify(enc), () => "pw-shape"),
    (e: Error) => e.message === "history_backup_unexpected_shape"
  );
});

test("encryptHistoryBackup handles an empty history", async () => {
  const bundle = buildHistoryBundle([], []);
  const enc = await encryptHistoryBackup(bundle, "empty-pw");
  assert.equal(enc.count, 0);
  const back = await parseHistoryBackup(JSON.stringify(enc), () => "empty-pw");
  assert.deepEqual(back, { dm: [], group: [] });
});
