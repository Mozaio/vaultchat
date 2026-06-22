import assert from "node:assert/strict";
import test from "node:test";
import {
  createPairingSession,
  decodePairingOffer,
  encodePairingOffer,
  openProvisioningPayload,
  pairingSafetyNumber,
  sealProvisioningPayload,
} from "./deviceProvisioning";
import type { LocalIdentity } from "./localIdentity";

globalThis.btoa ??= (v: string) => Buffer.from(v, "binary").toString("base64");
globalThis.atob ??= (v: string) => Buffer.from(v, "base64").toString("binary");

const identity: LocalIdentity = {
  userId: "11111111-2222-3333-4444-555555555555",
  username: "alice",
  publicKey: Buffer.alloc(32, 7).toString("base64"),
  wrapped: {
    salt: Buffer.alloc(16, 3).toString("base64"),
    nonce: Buffer.alloc(24, 5).toString("base64"),
    cipher: Buffer.alloc(48, 9).toString("base64"),
  },
};

test("full pairing round-trip transfers the identity sealed", async () => {
  // Secondary creates a session and shows its offer (QR).
  const session = await createPairingSession();
  const qr = encodePairingOffer(session.offer);
  // Primary parses the QR and seals the identity to the secondary's ephemeral pk.
  const offer = decodePairingOffer(qr);
  const sealed = await sealProvisioningPayload(offer, identity);
  // Secondary opens it.
  const restored = await openProvisioningPayload(session, sealed);
  assert.deepEqual(restored, identity);
});

test("QR encode/decode round-trips the offer fields", async () => {
  const session = await createPairingSession();
  const decoded = decodePairingOffer(encodePairingOffer(session.offer));
  assert.equal(decoded.ephemeralPublicKey, session.offer.ephemeralPublicKey);
  assert.equal(decoded.pairNonce, session.offer.pairNonce);
});

test("decodePairingOffer rejects malformed input", () => {
  assert.throws(() => decodePairingOffer("garbage"), /pairing_offer_malformed/);
  assert.throws(
    () => decodePairingOffer("WRONG:aaa:bbb"),
    /pairing_offer_malformed/
  );
  assert.throws(
    () => decodePairingOffer("UMBRA-PAIR1:onlyonepart"),
    /pairing_offer_malformed/
  );
  // Right prefix + shape, but the pubkey isn't 32 bytes of base64.
  assert.throws(
    () => decodePairingOffer("UMBRA-PAIR1:AAAA:BBBB"),
    /pairing_offer_/
  );
});

test("a different (wrong) secondary device cannot open the sealed payload", async () => {
  const intended = await createPairingSession();
  const attacker = await createPairingSession();
  const sealed = await sealProvisioningPayload(intended.offer, identity);
  // The attacker's ephemeral secret key cannot open a box sealed to the
  // intended ephemeral public key.
  await assert.rejects(
    openProvisioningPayload(attacker, sealed),
    /provisioning_open_failed/
  );
});

test("tampered sealed bytes reject", async () => {
  const session = await createPairingSession();
  const sealed = await sealProvisioningPayload(session.offer, identity);
  const raw = Buffer.from(sealed, "base64");
  raw[Math.floor(raw.length / 2)] ^= 0x01;
  await assert.rejects(
    openProvisioningPayload(session, raw.toString("base64")),
    /provisioning_open_failed/
  );
});

test("a payload sealed for the right pk but carrying a foreign pairNonce is rejected", async () => {
  // Simulate a replay: the primary seals to the secondary's ephemeral pk, but
  // with a pairNonce from a DIFFERENT pairing session. crypto_box_seal_open
  // succeeds (right recipient), but the nonce-binding check must fail.
  const realSession = await createPairingSession();
  const otherSession = await createPairingSession();
  // Build an offer with the real ephemeral pk but the OTHER session's nonce.
  const spoofedOffer = {
    ephemeralPublicKey: realSession.offer.ephemeralPublicKey,
    pairNonce: otherSession.offer.pairNonce,
  };
  const sealed = await sealProvisioningPayload(spoofedOffer, identity);
  await assert.rejects(
    openProvisioningPayload(realSession, sealed),
    /provisioning_nonce_mismatch/
  );
});

test("openProvisioningPayload rejects a wrong-shape but correctly-sealed payload", async () => {
  // Hand-seal arbitrary JSON to the secondary's pk to prove the shape guard.
  const { getSodium, sodiumReady } = await import("./sodium");
  const { publicKeyFromBase64 } = await import("./crypto");
  const { base64FromUint8 } = await import("./b64");
  await sodiumReady();
  const sodium = getSodium();
  const session = await createPairingSession();
  const pk = publicKeyFromBase64(session.offer.ephemeralPublicKey);
  const junk = new TextEncoder().encode(JSON.stringify({ not: "a payload" }));
  const sealed = base64FromUint8(sodium.crypto_box_seal(junk, pk));
  await assert.rejects(
    openProvisioningPayload(session, sealed),
    /provisioning_unexpected_shape/
  );
});

test("pairingSafetyNumber is deterministic and differs per session", async () => {
  const a = await createPairingSession();
  const b = await createPairingSession();
  const sn1 = await pairingSafetyNumber(a.offer);
  const sn2 = await pairingSafetyNumber(a.offer);
  const sn3 = await pairingSafetyNumber(b.offer);
  assert.equal(sn1, sn2, "same offer -> same safety number");
  assert.notEqual(sn1, sn3, "different sessions -> different safety numbers");
  // 6 groups of 5 digits, space separated.
  assert.match(sn1, /^\d{5}( \d{5}){5}$/);
});
