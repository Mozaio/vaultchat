import assert from "node:assert/strict";
import test from "node:test";
import { base64FromUint8 } from "./b64";
import { generateBoxKeypair, publicKeyBase64 } from "./crypto";
import { x3dhSender, x3dhReceiver } from "./x3dh";
import { ml_kem1024 } from "@noble/post-quantum/ml-kem.js";
import { sodiumReady, getSodium } from "./sodium";

globalThis.btoa ??= (v: string) => Buffer.from(v, "binary").toString("base64");
globalThis.atob ??= (v: string) => Buffer.from(v, "base64").toString("binary");

test("x3dh: signed-prekey only (no one-time prekey, no PQ)", async () => {
  await sodiumReady();
  const sodium = getSodium();
  const alice = await generateBoxKeypair();
  const bob = await generateBoxKeypair();
  const bobSpk = sodium.crypto_box_keypair();

  const s = await x3dhSender(
    alice.secretKey,
    publicKeyBase64(bob.publicKey),
    base64FromUint8(bobSpk.publicKey),
    null
  );
  const r = await x3dhReceiver(
    bob.secretKey,
    publicKeyBase64(alice.publicKey),
    base64FromUint8(bobSpk.privateKey),
    null,
    s.ephemeralPublicKey
  );
  assert.deepEqual(Array.from(r), Array.from(s.sharedSecret));
  assert.equal(s.usedOneTimePreKey, false);
  assert.equal(s.pqKemCiphertext, undefined);
});

test("x3dh: distinct sessions (different ephemerals) yield different secrets", async () => {
  await sodiumReady();
  const sodium = getSodium();
  const alice = await generateBoxKeypair();
  const bob = await generateBoxKeypair();
  const bobSpk = sodium.crypto_box_keypair();

  const s1 = await x3dhSender(
    alice.secretKey,
    publicKeyBase64(bob.publicKey),
    base64FromUint8(bobSpk.publicKey),
    null
  );
  const s2 = await x3dhSender(
    alice.secretKey,
    publicKeyBase64(bob.publicKey),
    base64FromUint8(bobSpk.publicKey),
    null
  );
  assert.notDeepEqual(Array.from(s1.sharedSecret), Array.from(s2.sharedSecret));
  assert.notEqual(s1.ephemeralPublicKey, s2.ephemeralPublicKey);
});

test("x3dh: PQ-hybrid does not regress to bare X3DH secret", async () => {
  await sodiumReady();
  const sodium = getSodium();
  const alice = await generateBoxKeypair();
  const bob = await generateBoxKeypair();
  const bobSpk = sodium.crypto_box_keypair();
  const bobPq = ml_kem1024.keygen();

  const bare = await x3dhSender(
    alice.secretKey,
    publicKeyBase64(bob.publicKey),
    base64FromUint8(bobSpk.publicKey),
    null
  );
  const hybrid = await x3dhSender(
    alice.secretKey,
    publicKeyBase64(bob.publicKey),
    base64FromUint8(bobSpk.publicKey),
    null,
    base64FromUint8(bobPq.publicKey)
  );
  assert.notDeepEqual(
    Array.from(bare.sharedSecret),
    Array.from(hybrid.sharedSecret),
    "hybrid output must differ from bare X3DH"
  );
  assert.ok(hybrid.pqKemCiphertext);
});

test("x3dh: receiver with wrong signed-prekey-secret produces wrong secret", async () => {
  await sodiumReady();
  const sodium = getSodium();
  const alice = await generateBoxKeypair();
  const bob = await generateBoxKeypair();
  const bobSpk = sodium.crypto_box_keypair();
  const otherSpk = sodium.crypto_box_keypair();

  const s = await x3dhSender(
    alice.secretKey,
    publicKeyBase64(bob.publicKey),
    base64FromUint8(bobSpk.publicKey),
    null
  );
  const r = await x3dhReceiver(
    bob.secretKey,
    publicKeyBase64(alice.publicKey),
    base64FromUint8(otherSpk.privateKey), // ← wrong signed-prekey priv
    null,
    s.ephemeralPublicKey
  );
  assert.notDeepEqual(
    Array.from(r),
    Array.from(s.sharedSecret),
    "wrong SPK must give different secret"
  );
});
