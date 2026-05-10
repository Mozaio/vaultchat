import type { ApiUser } from "./api";
import { type PlainPayload } from "./crypto";
import { isOlmCiphertext, olmDecryptJson } from "./olmSession";
import { openSealedEnvelope } from "./sealedSender";
import { isMessageDuplicate } from "./replayProtection";
import { logSilentCryptoFailure } from "./errors";
import type { Session } from "./sessionHelpers";

export type DecryptedDm = {
  senderUserId: string;
  plain: PlainPayload;
};

/**
 * Entschlüsselt eine eingehende Sealed-Sender-DM.
 *
 * Phase 5: nur noch auditiertes Olm (`VCO5`-Wire) als gültiges Inner-Format.
 * Die alten Pfade (DR v4, X3DH-PreKey-Bundle, DmBundle) sind entfernt.
 * Wer noch alte Wires sendet, bekommt einen `silent crypto failure`-Log
 * und der Frame wird verworfen — ehrlicher Bruch statt schleichender
 * Fallback-Drift.
 *
 * 1. Öffnet den Sealed-Envelope → extrahiert senderUserId und inneren Ciphertext
 * 2. Sucht den Peer-Record (für dessen Identity-Public-Key) in der aktuellen Liste
 * 3. Decoded den inneren VCO5-Wire via Olm-Session
 */
export async function decryptIncomingSealedDm(
  envelopeB64: string,
  session: Session,
  resolvePeer: (userId: string) => Promise<ApiUser | null>,
  // _options ist für künftige receivedAt-Logik reserviert; aktuell nicht
  // benutzt, weil Olm den Ratchet selbst verwaltet.
  _options: { receivedAt?: number } = {}
): Promise<DecryptedDm | null> {
  let senderUserId: string;
  let innerB64: string;
  try {
    const opened = await openSealedEnvelope(
      envelopeB64,
      session.user.publicKey,
      session.secretKey
    );
    senderUserId = opened.senderUserId;
    innerB64 = opened.innerB64;
  } catch (e) {
    logSilentCryptoFailure(e, "openSealedEnvelope");
    return null;
  }
  const peer = await resolvePeer(senderUserId);
  if (!peer) return null;

  let plain: PlainPayload;
  try {
    if (!isOlmCiphertext(innerB64)) {
      // Phase 5: nicht-Olm-Inner ist legacy und nicht mehr unterstützt.
      throw new Error("non_olm_inner_dropped");
    }
    const json = await olmDecryptJson(peer.id, innerB64);
    plain = JSON.parse(json) as PlainPayload;
  } catch (e) {
    logSilentCryptoFailure(e, "decryptIncomingSealedDm.inner");
    return null;
  }
  return { senderUserId: peer.id, plain };
}

/**
 * Wrapper mit integriertem Replay-Schutz.
 * Prüft ob die Message-ID bereits verarbeitet wurde, bevor sie akzeptiert wird.
 */
export async function decryptIncomingSealedDmWithReplayCheck(
  envelopeB64: string,
  session: Session,
  resolvePeer: (userId: string) => Promise<ApiUser | null>
): Promise<DecryptedDm | null> {
  const result = await decryptIncomingSealedDm(envelopeB64, session, resolvePeer);
  if (!result) return null;

  const cid = result.plain.cid;
  if (typeof cid === "string" && cid.length > 0 && isMessageDuplicate(cid)) {
    return null;
  }

  return result;
}
