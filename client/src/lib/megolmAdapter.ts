/**
 * Megolm Adapter — typsafer Wrapper um @matrix-org/olm's Megolm-Klassen.
 *
 * Hintergrund: Megolm ist Matrix.orgs Group-Ratchet, optimiert für
 * efficient broadcasting an N Empfänger. Ein Sender hat eine
 * OutboundGroupSession; jeder Empfänger leitet daraus eine
 * InboundGroupSession ab (initialisiert mit dem Session-Key vom Sender).
 *
 * Vorteile gegenüber unserem groupCrypto.ts v2:
 *  - Auditiert (NCC Group 2016/2020, Quarkslab 2024).
 *  - Member-Removal kann via Rotation gelöst werden — Sender erzeugt eine
 *    NEUE OutboundGroupSession, teilt deren Key NUR mit verbleibenden
 *    Members. Alte Sessions sind dann tot.
 *  - Ratchet ist per-Message → echte Forward-Secrecy innerhalb der Session.
 *
 * Status: FOUNDATION. Wird heute noch nicht von ChatShell aufgerufen.
 * Migration ist Phase 3, siehe SECURITY_AUDIT_STATUS.md.
 */

import { olmInit } from "./olmAdapter";

type OlmModule = typeof import("@matrix-org/olm");
type OutboundGroupSession = InstanceType<OlmModule["OutboundGroupSession"]>;
type InboundGroupSession = InstanceType<OlmModule["InboundGroupSession"]>;

/**
 * Erzeugt eine neue OutboundGroupSession (für den Sender).
 * Pickle die Session in Persistenz, damit weitere Nachrichten den Ratchet
 * fortsetzen.
 */
export async function createOutboundGroupSession(): Promise<OutboundGroupSession> {
  const olm = await olmInit();
  const s = new olm.OutboundGroupSession();
  s.create();
  return s;
}

/**
 * Exportiert den initialen Session-Key der OutboundGroupSession, damit
 * Empfänger eine InboundGroupSession initialisieren können. Der Key
 * MUSS pro Empfänger über einen authentifizierten 1:1-Olm-Channel
 * geteilt werden — sonst kann jeder mitlesen.
 */
export function exportGroupSessionKey(
  session: OutboundGroupSession
): { sessionId: string; sessionKey: string; messageIndex: number } {
  return {
    sessionId: session.session_id(),
    sessionKey: session.session_key(),
    messageIndex: session.message_index(),
  };
}

/**
 * Verschlüsselt eine Gruppen-Nachricht. Output ist ein Base64-Ciphertext.
 * Caller broadcastet das Ergebnis an alle Gruppen-Mitglieder.
 */
export function megolmEncrypt(
  session: OutboundGroupSession,
  plaintext: string
): string {
  return session.encrypt(plaintext);
}

/**
 * Erzeugt eine InboundGroupSession aus dem Session-Key des Senders.
 * Empfänger ruft das einmal pro Sender × Group auf.
 */
export async function createInboundGroupSession(
  sessionKey: string
): Promise<InboundGroupSession> {
  const olm = await olmInit();
  const s = new olm.InboundGroupSession();
  s.create(sessionKey);
  return s;
}

export function megolmDecrypt(
  session: InboundGroupSession,
  ciphertext: string
): { plaintext: string; messageIndex: number } {
  const r = session.decrypt(ciphertext);
  return { plaintext: r.plaintext, messageIndex: r.message_index };
}

export function pickleOutbound(
  session: OutboundGroupSession,
  pickleKey: string
): string {
  return session.pickle(pickleKey);
}

export function pickleInbound(
  session: InboundGroupSession,
  pickleKey: string
): string {
  return session.pickle(pickleKey);
}

export async function unpickleOutbound(
  pickled: string,
  pickleKey: string
): Promise<OutboundGroupSession> {
  const olm = await olmInit();
  const s = new olm.OutboundGroupSession();
  s.unpickle(pickleKey, pickled);
  return s;
}

export async function unpickleInbound(
  pickled: string,
  pickleKey: string
): Promise<InboundGroupSession> {
  const olm = await olmInit();
  const s = new olm.InboundGroupSession();
  s.unpickle(pickleKey, pickled);
  return s;
}
