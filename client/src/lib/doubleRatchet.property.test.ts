/**
 * Property-based tests für den Double Ratchet.
 *
 * Hand-rolled randomized testing (statt fast-check, weil keine npm-Deps).
 * Wir würfeln deterministische Send-Sequenzen und prüfen, dass jede
 * decrypt(encrypt(m)) === m gilt — auch unter wechselseitigen Bootstrap +
 * Reply-Patterns.
 *
 * Seeds sind hartcoded, damit Failures reproduzierbar sind. Wer einen Bug
 * findet: Seed in den Bug-Report kopieren.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { base64FromUint8 } from "./b64";
import { generateBoxKeypair, publicKeyBase64 } from "./crypto";
import { drDecrypt, drEncrypt, drInit, type DRState } from "./doubleRatchet";

globalThis.btoa ??= (value: string) =>
  Buffer.from(value, "binary").toString("base64");
globalThis.atob ??= (value: string) =>
  Buffer.from(value, "base64").toString("binary");

// Mulberry32 — kleiner deterministischer PRNG für reproduzierbare Tests.
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBytes(rng: () => number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

const SEEDS = [0x1337, 0xcafe, 0xb00b1e5, 0xdeadbeef, 42];

for (const seed of SEEDS) {
  test(`DR roundtrip: 30 message ping-pong (seed=${seed.toString(16)})`, async () => {
    const rng = mulberry32(seed);
    const alice = await generateBoxKeypair();
    const bob = await generateBoxKeypair();
    let aState: DRState = await drInit(
      alice.secretKey,
      publicKeyBase64(bob.publicKey),
      "bob"
    );
    let bState: DRState = await drInit(
      bob.secretKey,
      publicKeyBase64(alice.publicKey),
      "alice"
    );

    for (let i = 0; i < 30; i++) {
      const sender = rng() < 0.5 ? "a" : "b";
      const len = 8 + Math.floor(rng() * 256);
      const plain = randomBytes(rng, len);

      if (sender === "a") {
        const enc = await drEncrypt(aState, plain);
        aState = enc.state;
        const dec = await drDecrypt(bState, bob.secretKey, enc.wire);
        bState = dec.state;
        assert.equal(
          base64FromUint8(dec.plaintext),
          base64FromUint8(plain),
          `iter ${i}: A→B mismatch`
        );
      } else {
        const enc = await drEncrypt(bState, plain);
        bState = enc.state;
        const dec = await drDecrypt(aState, alice.secretKey, enc.wire);
        aState = dec.state;
        assert.equal(
          base64FromUint8(dec.plaintext),
          base64FromUint8(plain),
          `iter ${i}: B→A mismatch`
        );
      }
    }
  });

  test(`DR rejects wire bit-flips (seed=${seed.toString(16)})`, async () => {
    const rng = mulberry32(seed);
    const alice = await generateBoxKeypair();
    const bob = await generateBoxKeypair();
    const aState = await drInit(
      alice.secretKey,
      publicKeyBase64(bob.publicKey),
      "bob"
    );
    const bState = await drInit(
      bob.secretKey,
      publicKeyBase64(alice.publicKey),
      "alice"
    );
    const enc = await drEncrypt(aState, randomBytes(rng, 64));

    // Flip 5 zufällige Bits im wire — jeder Flip muss zu einer Decryption-Fail führen.
    for (let i = 0; i < 5; i++) {
      const bytePos = Math.floor(rng() * enc.wire.length);
      const bitPos = Math.floor(rng() * 8);
      const tampered = new Uint8Array(enc.wire);
      tampered[bytePos] = (tampered[bytePos] ?? 0) ^ (1 << bitPos);
      await assert.rejects(
        () => drDecrypt(bState, bob.secretKey, tampered),
        `bit-flip at byte ${bytePos} bit ${bitPos} should reject`
      );
    }
  });
}

test("DR rejects truncated wire", async () => {
  const alice = await generateBoxKeypair();
  const bob = await generateBoxKeypair();
  const aState = await drInit(
    alice.secretKey,
    publicKeyBase64(bob.publicKey),
    "bob"
  );
  const bState = await drInit(
    bob.secretKey,
    publicKeyBase64(alice.publicKey),
    "alice"
  );
  const enc = await drEncrypt(aState, new TextEncoder().encode("hello"));
  for (const cut of [1, 16, 32, 60]) {
    const truncated = enc.wire.slice(0, enc.wire.length - cut);
    await assert.rejects(
      () => drDecrypt(bState, bob.secretKey, truncated),
      `truncate -${cut} bytes should reject`
    );
  }
});

test("DR refuses to replay the same wire twice", async () => {
  const alice = await generateBoxKeypair();
  const bob = await generateBoxKeypair();
  const aState = await drInit(
    alice.secretKey,
    publicKeyBase64(bob.publicKey),
    "bob"
  );
  let bState: DRState = await drInit(
    bob.secretKey,
    publicKeyBase64(alice.publicKey),
    "alice"
  );
  const enc = await drEncrypt(aState, new TextEncoder().encode("once"));
  const first = await drDecrypt(bState, bob.secretKey, enc.wire);
  bState = first.state;
  // Zweiter Aufruf: counter ist im receiver state schon weiter, alte wire ist replay.
  await assert.rejects(
    () => drDecrypt(bState, bob.secretKey, enc.wire),
    "replay of same wire must reject"
  );
});
