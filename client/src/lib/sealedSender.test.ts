import assert from "node:assert/strict";
import test from "node:test";
import { generateBoxKeypair, publicKeyBase64 } from "./crypto";
import { openSealedEnvelope, sealSender } from "./sealedSender";

globalThis.btoa ??= (v: string) => Buffer.from(v, "binary").toString("base64");
globalThis.atob ??= (v: string) => Buffer.from(v, "base64").toString("binary");

const SENDER_UUID = "11111111-2222-3333-4444-555555555555";
const RECIPIENT_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// "Inner" bytes sind in Phase 5 immer Olm-Wire (VCO5). Für den
// sealedSender-Test ist nur entscheidend, dass `crypto_box_seal` den
// Inner-Blob byte-genau ein- und auspackt. Beliebige Bytes reichen.
const sampleInner = Buffer.from("dummy-inner-payload").toString("base64");

test("sealed sender: roundtrip preserves senderUserId and innerB64", async () => {
  const recipient = await generateBoxKeypair();
  const envelopeB64 = await sealSender(
    SENDER_UUID,
    sampleInner,
    publicKeyBase64(recipient.publicKey)
  );
  const opened = await openSealedEnvelope(
    envelopeB64,
    publicKeyBase64(recipient.publicKey),
    recipient.secretKey
  );
  assert.equal(opened.senderUserId, SENDER_UUID);
  assert.equal(opened.innerB64, sampleInner);
});

test("sealed sender: wrong recipient cannot open the envelope", async () => {
  const intended = await generateBoxKeypair();
  const eve = await generateBoxKeypair();
  const env = await sealSender(
    SENDER_UUID,
    sampleInner,
    publicKeyBase64(intended.publicKey)
  );
  await assert.rejects(
    () => openSealedEnvelope(env, publicKeyBase64(eve.publicKey), eve.secretKey),
    "Eve must not be able to open the envelope"
  );
});

test("sealed sender: tampered envelope bytes reject", async () => {
  const recipient = await generateBoxKeypair();
  const env = await sealSender(
    RECIPIENT_UUID,
    sampleInner,
    publicKeyBase64(recipient.publicKey)
  );
  const raw = Uint8Array.from(atob(env), (c) => c.charCodeAt(0));
  raw[Math.floor(raw.length / 2)] = (raw[Math.floor(raw.length / 2)] ?? 0) ^ 0x01;
  const tampered = btoa(String.fromCharCode(...raw));
  await assert.rejects(
    () =>
      openSealedEnvelope(
        tampered,
        publicKeyBase64(recipient.publicKey),
        recipient.secretKey
      ),
    "tampered envelope must reject"
  );
});
