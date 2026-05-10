import assert from "node:assert/strict";
import test from "node:test";
import {
  encryptIdentityBackup,
  parseIdentityBackup,
} from "./backup";
import type { LocalIdentity } from "./localIdentity";

globalThis.btoa ??= (value: string) => Buffer.from(value, "binary").toString("base64");
globalThis.atob ??= (value: string) => Buffer.from(value, "base64").toString("binary");

const sampleIdentity: LocalIdentity = {
  userId: "user-test-1",
  username: "alice",
  publicKey: "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3OA==",
  wrapped: {
    salt: "AAAAAAAAAAAAAAAAAAAAAA==",
    nonce: "AAAAAAAAAAAAAAAAAAAAAA==",
    cipher: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  },
};

test("parseIdentityBackup rejects invalid JSON", async () => {
  await assert.rejects(
    parseIdentityBackup("not-json{", () => "pw"),
    (e: unknown) => e instanceof SyntaxError
  );
});

test("parseIdentityBackup rejects non-v2 backup", async () => {
  await assert.rejects(
    parseIdentityBackup(JSON.stringify({ type: "legacy" }), () => "x"),
    (e: Error) => e.message === "backup_must_be_encrypted_v2"
  );
  await assert.rejects(
    parseIdentityBackup(JSON.stringify({}), () => "x"),
    (e: Error) => e.message === "backup_must_be_encrypted_v2"
  );
});

test("parseIdentityBackup requires passphrase", async () => {
  const encBackup = await encryptIdentityBackup(sampleIdentity, "secret-pass");
  await assert.rejects(
    parseIdentityBackup(JSON.stringify(encBackup), () => null),
    (e: Error) => e.message === "backup_passphrase_required"
  );
});

test("parseIdentityBackup rejects wrong passphrase with the right error code", async () => {
  const encBackup = await encryptIdentityBackup(sampleIdentity, "right-one");
  await assert.rejects(
    parseIdentityBackup(JSON.stringify(encBackup), () => "wrong-one"),
    (e: Error) => e.message === "backup_passphrase_wrong_or_tampered"
  );
});

test("parseIdentityBackup rejects tampered ciphertext with the same code", async () => {
  // MAC failure can't be distinguished from wrong-passphrase by design.
  const encBackup = await encryptIdentityBackup(sampleIdentity, "pw-1");
  // Flip a bit in the cipher.
  const cipherBytes = Buffer.from(encBackup.cipher, "base64");
  cipherBytes[cipherBytes.length - 1] ^= 0x01;
  const tampered = { ...encBackup, cipher: cipherBytes.toString("base64") };
  await assert.rejects(
    parseIdentityBackup(JSON.stringify(tampered), () => "pw-1"),
    (e: Error) => e.message === "backup_passphrase_wrong_or_tampered"
  );
});

test("encryptIdentityBackup output has all required fields", async () => {
  const enc = await encryptIdentityBackup(sampleIdentity, "x");
  assert.equal(enc.type, "vaultchat.identity.backup");
  assert.equal(enc.version, 2);
  assert.equal(enc.kdf, "argon2id");
  assert.ok(enc.salt.length > 0);
  assert.ok(enc.nonce.length > 0);
  assert.ok(enc.cipher.length > 0);
  assert.ok(enc.createdAt);
  // createdAt must be a parseable ISO timestamp.
  assert.ok(Number.isFinite(Date.parse(enc.createdAt)));
});

test("encryptIdentityBackup uses a fresh salt+nonce on every call", async () => {
  const a = await encryptIdentityBackup(sampleIdentity, "same-pw");
  const b = await encryptIdentityBackup(sampleIdentity, "same-pw");
  assert.notEqual(a.salt, b.salt, "salt must be random per call");
  assert.notEqual(a.nonce, b.nonce, "nonce must be random per call");
  assert.notEqual(a.cipher, b.cipher, "cipher must differ — distinct salt+nonce");
});

test("encryptIdentityBackup roundtrips with parseIdentityBackup", async () => {
  const encBackup = await encryptIdentityBackup(sampleIdentity, "my-backup-pw");
  const back = await parseIdentityBackup(JSON.stringify(encBackup), () => "my-backup-pw");
  assert.deepEqual(back, sampleIdentity);
});

test("parseIdentityBackup handles realistic LocalIdentity (long fields)", async () => {
  const realistic: LocalIdentity = {
    userId: "11111111-2222-3333-4444-555555555555",
    username: "test_user_42",
    publicKey: Buffer.alloc(32, 7).toString("base64"),
    wrapped: {
      salt: Buffer.alloc(16, 3).toString("base64"),
      nonce: Buffer.alloc(24, 5).toString("base64"),
      cipher: Buffer.alloc(48, 9).toString("base64"),
    },
  };
  const enc = await encryptIdentityBackup(realistic, "pw-realistic-9");
  const back = await parseIdentityBackup(JSON.stringify(enc), () => "pw-realistic-9");
  assert.deepEqual(back, realistic);
});
