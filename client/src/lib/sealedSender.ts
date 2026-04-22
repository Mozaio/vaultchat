/**
 * VaultChat Sealed Sender — v1.
 *
 * Ziel: Der Relay-Server sieht NIE den Absender einer DM. Er sieht nur den
 * Empfänger (nötig fürs Routing) und einen undurchsichtigen Envelope-Blob.
 *
 * Konstruktion:
 *   inner       = DR-Wire (oder sealed-box bei Group-Key-Distribution)
 *   plaintext   = HEADER || 16-byte senderUserId(UUID, binär) || len32(inner) || inner
 *   envelope    = crypto_box_seal(recipient_identity_pk, plaintext)
 *
 * Authentizität:
 *   - Der innere DR-Wire ist pro-Peer authentifiziert (Ratchet-State des
 *     Empfängers für senderUserId). Nur wer den privaten Identity-Key von
 *     senderUserId besitzt, kann einen gültigen DR-Wire für diesen Empfänger
 *     erzeugen. Ein Angreifer, der `senderUserId` in einem Sealed Envelope
 *     fälscht, kann daher keinen DR-Wire erzeugen, der beim Empfänger
 *     entschlüsselt.
 *   - `crypto_box_seal` selbst ist anonym-authentisiert nur gegen Empfänger.
 *     Die eigentliche Authentifikation kommt aus DR.
 *
 * Der Server erhält auf der Drahtebene:
 *   { type:"dm", toUserId, envelope }  — kein fromUserId, kein Timestamp (außer
 *   seinem eigenen relay-createdAt).
 */
import { base64FromUint8, uint8FromBase64 } from "./b64";
import { publicKeyFromBase64 } from "./crypto";
import { getSodium, sodiumReady } from "./sodium";

const HEADER = new Uint8Array([0x56, 0x53, 0x53, 0x31]); // "VSS1"

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) throw new Error("bad_uuid");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToUuid(b: Uint8Array): string {
  if (b.length !== 16) throw new Error("bad_uuid_len");
  const h = Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Packt (senderUserId, inner) und versiegelt an recipientPk. */
export async function sealSender(
  senderUserId: string,
  innerB64: string,
  recipientIdentityPkB64: string
): Promise<string> {
  await sodiumReady();
  const sodium = getSodium();
  const inner = uint8FromBase64(innerB64);
  const sid = uuidToBytes(senderUserId);
  const lenBuf = new Uint8Array(4);
  new DataView(lenBuf.buffer).setUint32(0, inner.length, false);
  const plaintext = new Uint8Array(HEADER.length + 16 + 4 + inner.length);
  let p = 0;
  plaintext.set(HEADER, p);
  p += HEADER.length;
  plaintext.set(sid, p);
  p += 16;
  plaintext.set(lenBuf, p);
  p += 4;
  plaintext.set(inner, p);
  const pk = publicKeyFromBase64(recipientIdentityPkB64);
  const sealed = sodium.crypto_box_seal(plaintext, pk);
  return base64FromUint8(sealed);
}

export async function openSealedEnvelope(
  envelopeB64: string,
  recipientPkB64: string,
  recipientSk: Uint8Array
): Promise<{ senderUserId: string; innerB64: string }> {
  await sodiumReady();
  const sodium = getSodium();
  const pk = publicKeyFromBase64(recipientPkB64);
  const sealed = uint8FromBase64(envelopeB64);
  const plaintext = sodium.crypto_box_seal_open(sealed, pk, recipientSk);
  if (plaintext.length < HEADER.length + 16 + 4) throw new Error("short_envelope");
  for (let i = 0; i < HEADER.length; i++) {
    if (plaintext[i] !== HEADER[i]) throw new Error("bad_envelope_header");
  }
  let p = HEADER.length;
  const sid = plaintext.subarray(p, p + 16);
  p += 16;
  const len = new DataView(
    plaintext.buffer,
    plaintext.byteOffset + p,
    4
  ).getUint32(0, false);
  p += 4;
  if (plaintext.length - p !== len) throw new Error("bad_envelope_len");
  const inner = plaintext.subarray(p);
  return {
    senderUserId: bytesToUuid(sid),
    innerB64: base64FromUint8(inner),
  };
}
