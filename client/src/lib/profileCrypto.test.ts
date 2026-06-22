import assert from "node:assert/strict";
import test from "node:test";
import {
  encryptProfile,
  decryptProfile,
  generateProfileKey,
  isEncryptedProfile,
  MAX_PROFILE_AVATAR_CHARS,
  type ProfileData,
} from "./profileCrypto";

globalThis.btoa ??= (v: string) => Buffer.from(v, "binary").toString("base64");
globalThis.atob ??= (v: string) => Buffer.from(v, "base64").toString("binary");

test("generateProfileKey returns a 32-byte base64 key", async () => {
  const k = await generateProfileKey();
  assert.equal(typeof k, "string");
  const bytes = Buffer.from(k, "base64");
  assert.equal(bytes.length, 32);
});

test("encrypt → decrypt round-trips name + avatar", async () => {
  const key = await generateProfileKey();
  const profile: ProfileData = {
    displayName: "Alice 🦊",
    avatar: "data:image/jpeg;base64,SGVsbG8=",
  };
  const wire = await encryptProfile(profile, key);
  assert.ok(isEncryptedProfile(wire), "wire must carry the PROFILE1: prefix");
  assert.ok(wire.startsWith("PROFILE1:"));
  const back = await decryptProfile(wire, key);
  assert.deepEqual(back, profile);
});

test("round-trips a name-only profile (no avatar)", async () => {
  const key = await generateProfileKey();
  const profile: ProfileData = { displayName: "Bob" };
  const back = await decryptProfile(await encryptProfile(profile, key), key);
  assert.deepEqual(back, profile);
});

test("wrong key cannot decrypt (returns null, never throws)", async () => {
  const key = await generateProfileKey();
  const other = await generateProfileKey();
  const wire = await encryptProfile({ displayName: "Secret" }, key);
  const back = await decryptProfile(wire, other);
  assert.equal(back, null);
});

test("tampered ciphertext is rejected (auth tag)", async () => {
  const key = await generateProfileKey();
  const wire = await encryptProfile({ displayName: "Eve" }, key);
  // Flip a character in the base64 body.
  const body = wire.slice("PROFILE1:".length);
  const flipped = (body[10] === "A" ? "B" : "A") + body.slice(1);
  const tampered = `PROFILE1:${flipped}`;
  assert.equal(await decryptProfile(tampered, key), null);
});

test("decryptProfile rejects non-PROFILE1 input", async () => {
  const key = await generateProfileKey();
  assert.equal(await decryptProfile("GMETA1:1:abc", key), null);
  assert.equal(await decryptProfile("", key), null);
  assert.equal(await decryptProfile("plain text", key), null);
});

test("encryptProfile enforces the avatar size cap", async () => {
  const key = await generateProfileKey();
  const tooBig = "x".repeat(MAX_PROFILE_AVATAR_CHARS + 1);
  await assert.rejects(
    encryptProfile({ avatar: tooBig }, key),
    (e: Error) => e.message === "profile_avatar_too_large"
  );
});

test("isEncryptedProfile detects the wire prefix", () => {
  assert.equal(isEncryptedProfile("PROFILE1:abc"), true);
  assert.equal(isEncryptedProfile("PROFILE2:abc"), false);
  assert.equal(isEncryptedProfile(undefined), false);
  assert.equal(isEncryptedProfile(null), false);
});
