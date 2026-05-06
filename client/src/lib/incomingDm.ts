import type { ApiUser } from "./api";
import { openPayload, type PlainPayload } from "./crypto";
import {
  drDecryptDmBundleJson,
  drDecryptJson,
  drDecryptX3dhPreKeyJson,
  isDrCiphertext,
  isDmBundleFrame,
  isX3dhPreKeyFrame,
} from "./drSession";
import { openSealedEnvelope } from "./sealedSender";
import { isMessageDuplicate } from "./replayProtection";
import type { Session } from "./sessionHelpers";

export type DecryptedDm = {
  senderUserId: string;
  plain: PlainPayload;
};

/**
 * Entschlüsselt eine eingehende Sealed-Sender-DM.
 *
 * 1. Öffnet den Sealed-Envelope → extrahiert senderUserId und inneren Ciphertext
 * 2. Sucht den Peer-Record (für dessen Identity-Public-Key) in der aktuellen Liste
 * 3. Entschlüsselt den inneren Ciphertext via Double Ratchet (oder sealed-box
 *    bei Group-Key-Distribution, wenn der innere Frame kein DR-Wire ist)
 *
 * Wenn der Sender unbekannt ist (noch nicht in `knownUsers`), wird eine
 * Peer-Lookup-Routine vom Aufrufer bereitgestellt.
 */
export async function decryptIncomingSealedDm(
  envelopeB64: string,
  session: Session,
  resolvePeer: (userId: string) => Promise<ApiUser | null>,
  options: { receivedAt?: number } = {}
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
  } catch {
    return null;
  }
  const peer = await resolvePeer(senderUserId);
  if (!peer) return null;

  let plain: PlainPayload;
  try {
    if (isDmBundleFrame(innerB64)) {
      const json = await drDecryptDmBundleJson(
        session.secretKey,
        peer.id,
        peer.publicKey,
        innerB64,
        options.receivedAt
      );
      plain = JSON.parse(json) as PlainPayload;
    } else if (isDrCiphertext(innerB64)) {
      const json = await drDecryptJson(
        session.secretKey,
        peer.id,
        peer.publicKey,
        innerB64
      );
      plain = JSON.parse(json) as PlainPayload;
    } else if (isX3dhPreKeyFrame(innerB64)) {
      const json = await drDecryptX3dhPreKeyJson(
        session.secretKey,
        peer.id,
        peer.publicKey,
        innerB64,
        options.receivedAt
      );
      plain = JSON.parse(json) as PlainPayload;
    } else {
      plain = await openPayload(
        innerB64,
        session.user.publicKey,
        session.secretKey
      );
    }
  } catch {
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
  // Erst entschlüsseln
  const result = await decryptIncomingSealedDm(envelopeB64, session, resolvePeer);
  if (!result) return null;
  
  // Replay-Schutz: Prüfe Message-ID
  if (isMessageDuplicate(result.plain.cid)) {
    // Duplikat - verwerfen
    return null;
  }
  
  return result;
}
