/**
 * High-Level Group-Crypto-Layer auf Megolm-Basis.
 *
 * Analog zu groupCrypto.ts v2 (eigene Implementation), aber:
 *  - Megolm ist auditiert (NCC Group 2016/2020, Quarkslab 2024).
 *  - Member-Removal-PFS funktioniert ECHT: Outbound-Session rotieren,
 *    neuen Key NUR an verbleibende Mitglieder über 1:1-Olm verteilen,
 *    alte Inbound-Sessions verfallen sobald keine alten Messages mehr
 *    referenziert sind.
 *
 * Wire-Format `VCG6` (Vault Crypto Group v6 — ein Hochzählen von der
 * bestehenden GC2-Magic, damit Receiver am Magic erkennt was sie haben):
 *
 *     MAGIC(4)="VCG6" || sessionIdLen(1) || sessionId(N) || senderUuid(16)
 *     || ciphertext-bytes (raw, Megolm own base64-encoded body als UTF-8)
 *
 * Die `sessionId` ist die Megolm-Session-ID des SENDERS (b64 ~ 43 Zeichen).
 * Receiver schaut anhand (groupId, senderId, sessionId) die richtige
 * InboundGroupSession nach.
 *
 * Status: Phase 3 Foundation. Wird noch nicht von ChatShell.send/receive
 * group benutzt. Coexistence mit dem bestehenden GC2-Magic ist in
 * decryptGroupPayload zu ergänzen (späterer Schritt).
 */
import { base64FromUint8, uint8FromBase64 } from "./b64";
import {
  ensureOutbound,
  importInbound,
  loadInbound,
  rotateOutbound,
  saveInbound,
  saveOutbound,
  exportOutboundForRecipient,
} from "./megolmSessionStore";
import { megolmEncrypt, megolmDecrypt } from "./megolmAdapter";

const VCG6_MAGIC = new Uint8Array([0x56, 0x43, 0x47, 0x36]); // "VCG6"

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

/**
 * Probe: erkennt VCG6-Frames am Magic-Prefix. Pendant zu isDrCiphertext /
 * isOlmCiphertext, für routing in decryptGroupPayload.
 */
export function isMegolmGroupCiphertext(b64: string): boolean {
  try {
    const buf = uint8FromBase64(b64);
    if (buf.length < VCG6_MAGIC.length) return false;
    for (let i = 0; i < VCG6_MAGIC.length; i++) {
      if (buf[i] !== VCG6_MAGIC[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Verschlüsselt einen Klartext-Frame über die Megolm-Outbound-Session
 * des Senders. Outbound-Session wird beim ersten Call automatisch
 * angelegt; danach incrementiert der Ratchet bei jedem encrypt.
 *
 * Caller muss die Output-Bytes über sealed-sender broadcast'en wie
 * gewohnt — Server sieht nur den opaken Cipher.
 */
export async function megolmEncryptGroup(
  groupId: string,
  senderUuid: string,
  plainJson: string
): Promise<string> {
  const out = await ensureOutbound(groupId);
  try {
    const cipherBody = megolmEncrypt(out, plainJson);
    await saveOutbound(groupId, out); // ratchet weiterspeichern
    const sessionId = out.session_id();
    const sessionIdBytes = new TextEncoder().encode(sessionId);
    if (sessionIdBytes.length > 255) throw new Error("session_id_too_long");
    const cipherBytes = new TextEncoder().encode(cipherBody);
    const senderBytes = uuidToBytes(senderUuid);
    const wire = new Uint8Array(
      VCG6_MAGIC.length + 1 + sessionIdBytes.length + 16 + cipherBytes.length
    );
    let p = 0;
    wire.set(VCG6_MAGIC, p);
    p += VCG6_MAGIC.length;
    wire[p++] = sessionIdBytes.length;
    wire.set(sessionIdBytes, p);
    p += sessionIdBytes.length;
    wire.set(senderBytes, p);
    p += 16;
    wire.set(cipherBytes, p);
    return base64FromUint8(wire);
  } finally {
    out.free();
  }
}

export async function megolmDecryptGroup(
  groupId: string,
  cipherB64: string
): Promise<{ plaintext: string; senderUuid: string }> {
  const wire = uint8FromBase64(cipherB64);
  for (let i = 0; i < VCG6_MAGIC.length; i++) {
    if (wire[i] !== VCG6_MAGIC[i]) throw new Error("vcg6_bad_magic");
  }
  let p = VCG6_MAGIC.length;
  const sessionIdLen = wire[p++];
  if (sessionIdLen === undefined || p + sessionIdLen + 16 > wire.length) {
    throw new Error("vcg6_short");
  }
  const sessionId = new TextDecoder().decode(
    wire.subarray(p, p + sessionIdLen)
  );
  p += sessionIdLen;
  const senderUuid = bytesToUuid(wire.subarray(p, p + 16));
  p += 16;
  const cipherBody = new TextDecoder().decode(wire.subarray(p));

  const inbound = await loadInbound(groupId, senderUuid, sessionId);
  if (!inbound) {
    throw new Error("no_inbound_session");
  }
  try {
    const r = megolmDecrypt(inbound, cipherBody);
    await saveInbound(groupId, senderUuid, sessionId, inbound);
    return { plaintext: r.plaintext, senderUuid };
  } finally {
    inbound.free();
  }
}

/**
 * Komfort für Group-Setup: produziert die Session-Key-Distribution
 * für einen neuen Member. Caller verschlüsselt das ergebnis dann via
 * Olm-1:1 (auditierter Channel) und schickt es an jedes Mitglied.
 */
export async function buildSessionKeyDistribution(
  groupId: string
): Promise<{ sessionId: string; sessionKey: string; messageIndex: number }> {
  return exportOutboundForRecipient(groupId);
}

/**
 * Wenn ein Distribution-Frame eines Senders ankommt:
 *   { groupId, senderUuid, sessionKey }
 * → wir bauen eine InboundGroupSession und speichern sie. Künftige
 * Megolm-Frames mit derselben sessionId können dann decryptet werden.
 */
export async function ingestSessionKey(
  groupId: string,
  senderUuid: string,
  sessionKey: string
): Promise<{ sessionId: string }> {
  return importInbound(groupId, senderUuid, sessionKey);
}

/**
 * Member-Removal: alte Outbound-Session wegwerfen, neue erzeugen,
 * Session-Key des neuen Outbound an verbleibende Mitglieder zurückgeben.
 *
 * Inbound-Sessions der ALTEN Generation behalten wir — sonst können
 * wir alte Nachrichten der Gruppe nicht mehr im Verlauf lesen. Nur
 * neue Frames werden ab jetzt mit der frischen Session verschlüsselt.
 */
export async function rotateForMemberRemoval(
  groupId: string
): Promise<{ sessionId: string; sessionKey: string; messageIndex: number }> {
  const fresh = await rotateOutbound(groupId);
  try {
    return {
      sessionId: fresh.session_id(),
      sessionKey: fresh.session_key(),
      messageIndex: fresh.message_index(),
    };
  } finally {
    fresh.free();
  }
}
