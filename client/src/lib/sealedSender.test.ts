import assert from "node:assert/strict";
import test from "node:test";
import { generateBoxKeypair, publicKeyBase64 } from "./crypto";
import { drDecrypt, drEncrypt, drInit } from "./doubleRatchet";
import { openSealedEnvelope, sealSender } from "./sealedSender";
import { base64FromUint8 } from "./b64";

globalThis.btoa ??= (v: string) => Buffer.from(v, "binary").toString("base64");
globalThis.atob ??= (v: string) => Buffer.from(v, "base64").toString("binary");

const SENDER_UUID = "11111111-2222-3333-4444-555555555555";
const RECIPIENT_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("sealed sender: opening returns the original DR wire and senderUserId", async () => {
  const sender = await generateBoxKeypair();
  const recipient = await generateBoxKeypair();
  const senderState = await drInit(
    sender.secretKey,
    publicKeyBase64(recipient.publicKey),
    "recipient"
  );
  const recipientState = await drInit(
    recipient.secretKey,
    publicKeyBase64(sender.publicKey),
    "sender"
  );

  const enc = await drEncrypt(senderState, new TextEncoder().encode("payload"));
  const wireB64 = base64FromUint8(enc.wire);

  const envelopeB64 = await sealSender(
    SENDER_UUID,
    wireB64,
    publicKeyBase64(recipient.publicKey)
  );

  const opened = await openSealedEnvelope(
    envelopeB64,
    publicKeyBase64(recipient.publicKey),
    recipient.secretKey
  );
  assert.equal(opened.senderUserId, SENDER_UUID);
  assert.equal(opened.innerB64, wireB64);

  // And the inner wire still decrypts.
  const dec = await drDecrypt(
    recipientState,
    recipient.secretKey,
    Uint8Array.from(atob(opened.innerB64), (c) => c.charCodeAt(0))
  );
  assert.equal(new TextDecoder().decode(dec.plaintext), "payload");
});

test("sealed sender: wrong recipient cannot open the envelope", async () => {
  const sender = await generateBoxKeypair();
  const intended = await generateBoxKeypair();
  const eve = await generateBoxKeypair();
  const wire = "QkFE"; // dummy; doesn't matter — we check the seal layer
  const env = await sealSender(SENDER_UUID, wire, publicKeyBase64(intended.publicKey));
  await assert.rejects(
    () => openSealedEnvelope(env, publicKeyBase64(eve.publicKey), eve.secretKey),
    "Eve must not be able to open the envelope"
  );
});

test("sealed sender: tampered envelope bytes reject", async () => {
  const sender = await generateBoxKeypair();
  const recipient = await generateBoxKeypair();
  const env = await sealSender(
    RECIPIENT_UUID,
    "QkFE",
    publicKeyBase64(recipient.publicKey)
  );
  const raw = Uint8Array.from(atob(env), (c) => c.charCodeAt(0));
  // Flip a bit in the middle of the sealed-box ciphertext.
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
  void sender;
});
