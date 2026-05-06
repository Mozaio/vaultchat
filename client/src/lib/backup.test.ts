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

test("parseIdentityBackup rejects wrong passphrase", async () => {
  const encBackup = await encryptIdentityBackup(sampleIdentity, "right-one");
  await assert.rejects(parseIdentityBackup(JSON.stringify(encBackup), () => "wrong-one"));
});

test("encryptIdentityBackup roundtrips with parseIdentityBackup", async () => {
  const encBackup = await encryptIdentityBackup(sampleIdentity, "my-backup-pw");
  const back = await parseIdentityBackup(JSON.stringify(encBackup), () => "my-backup-pw");
  assert.deepEqual(back, sampleIdentity);
});
