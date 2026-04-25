import assert from "node:assert/strict";
import test from "node:test";
import { base64FromUint8 } from "./b64";
import { generateBoxKeypair, publicKeyBase64 } from "./crypto";
import { drDecrypt, drEncrypt, drInit } from "./doubleRatchet";
import { getSodium, sodiumReady } from "./sodium";
import { x3dhReceiver, x3dhSender } from "./x3dh";

globalThis.btoa ??= (value: string) => Buffer.from(value, "binary").toString("base64");
globalThis.atob ??= (value: string) => Buffer.from(value, "base64").toString("binary");

test("double ratchet decrypts the first bootstrap message", async () => {
  const alice = await generateBoxKeypair();
  const bob = await generateBoxKeypair();
  const aliceState = await drInit(alice.secretKey, publicKeyBase64(bob.publicKey), "bob");
  const bobState = await drInit(bob.secretKey, publicKeyBase64(alice.publicKey), "alice");

  const plaintext = new TextEncoder().encode("vaultchat-dr-test-vector");
  const encrypted = await drEncrypt(aliceState, plaintext);
  const decrypted = await drDecrypt(bobState, bob.secretKey, encrypted.wire);

  assert.equal(new TextDecoder().decode(decrypted.plaintext), "vaultchat-dr-test-vector");
});

test("x3dh sender and receiver derive the same shared secret", async () => {
  await sodiumReady();
  const sodium = getSodium();
  const alice = await generateBoxKeypair();
  const bob = await generateBoxKeypair();
  const bobSignedPreKey = sodium.crypto_box_keypair();
  const bobOneTimePreKey = sodium.crypto_box_keypair();

  const sender = await x3dhSender(
    alice.secretKey,
    publicKeyBase64(bob.publicKey),
    base64FromUint8(bobSignedPreKey.publicKey),
    base64FromUint8(bobOneTimePreKey.publicKey)
  );
  const receiver = await x3dhReceiver(
    bob.secretKey,
    publicKeyBase64(alice.publicKey),
    base64FromUint8(bobSignedPreKey.privateKey),
    base64FromUint8(bobOneTimePreKey.privateKey),
    sender.ephemeralPublicKey
  );

  assert.deepEqual(Array.from(receiver), Array.from(sender.sharedSecret));
});
