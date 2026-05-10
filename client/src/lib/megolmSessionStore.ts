/**
 * Megolm-Session-Persistenz in IDB.
 *
 * Schema:
 *   megolmOut:{groupId}                Pickle der eigenen OutboundGroupSession.
 *                                      Wird vom User (Sender) gehalten und pro
 *                                      Message advanced.
 *   megolmIn:{groupId}:{senderId}:{sessionId}
 *                                      Pickle einer empfangenen
 *                                      InboundGroupSession. Sessions sind
 *                                      eindeutig pro Sender × Group ×
 *                                      Megolm-Session-ID — bei Rotation
 *                                      kommt neue ID dazu, alte bleibt für
 *                                      Decryption alter Nachrichten.
 */
import { metaGet, metaSet } from "./idb";
import { hasLocalKey, deriveSubKey } from "./localKey";
import {
  pickleOutbound,
  pickleInbound,
  unpickleOutbound,
  unpickleInbound,
  createOutboundGroupSession,
  createInboundGroupSession,
  exportGroupSessionKey,
} from "./megolmAdapter";

type OlmModule = typeof import("@matrix-org/olm");
type OutboundGroupSession = InstanceType<OlmModule["OutboundGroupSession"]>;
type InboundGroupSession = InstanceType<OlmModule["InboundGroupSession"]>;

let _pickleKey: string | null = null;
async function pickleKey(): Promise<string> {
  if (!hasLocalKey()) throw new Error("local_key_missing");
  if (_pickleKey) return _pickleKey;
  _pickleKey = await deriveSubKey("vaultchat-megolm-pickle-v1");
  return _pickleKey;
}
export function clearMegolmPickleCache(): void {
  _pickleKey = null;
}

function outKey(groupId: string): string {
  return `megolmOut:${groupId}`;
}
function inKey(groupId: string, senderId: string, sessionId: string): string {
  return `megolmIn:${groupId}:${senderId}:${sessionId}`;
}

/**
 * Lädt oder erzeugt die eigene OutboundGroupSession für eine Gruppe.
 * Bei Member-Removal sollte der Caller diese explizit über
 * `rotateOutbound(groupId)` ersetzen — die alte Session wird verworfen.
 *
 * Caller MUSS `session.free()` aufrufen.
 */
export async function ensureOutbound(groupId: string): Promise<OutboundGroupSession> {
  const raw = await metaGet(outKey(groupId));
  if (raw) {
    try {
      return await unpickleOutbound(raw, await pickleKey());
    } catch {
      /* Stale pickle (anderer localKey) — neu erzeugen unten. */
    }
  }
  const fresh = await createOutboundGroupSession();
  await saveOutbound(groupId, fresh);
  return fresh;
}

export async function saveOutbound(
  groupId: string,
  session: OutboundGroupSession
): Promise<void> {
  await metaSet(outKey(groupId), pickleOutbound(session, await pickleKey()));
}

/**
 * Rotiert die OutboundGroupSession — wird vom Caller nach
 * Member-Removal (oder Compromise-Verdacht) aufgerufen. Returns die
 * NEUE Session; der Caller muss deren `exportGroupSessionKey` an die
 * verbleibenden Members verteilen.
 */
export async function rotateOutbound(groupId: string): Promise<OutboundGroupSession> {
  const fresh = await createOutboundGroupSession();
  await saveOutbound(groupId, fresh);
  return fresh;
}

/**
 * Empfänger-Seite: Importiert eine InboundGroupSession (aus dem
 * `session_key` des Senders, der via 1:1-Olm-Channel ankam) und
 * speichert sie pro {groupId, senderId, sessionId}.
 *
 * Returns die ID dieser Session, damit Caller sie später wieder
 * laden kann.
 */
export async function importInbound(
  groupId: string,
  senderId: string,
  sessionKey: string
): Promise<{ sessionId: string }> {
  const inbound = await createInboundGroupSession(sessionKey);
  const sessionId = inbound.session_id();
  try {
    await metaSet(
      inKey(groupId, senderId, sessionId),
      pickleInbound(inbound, await pickleKey())
    );
    return { sessionId };
  } finally {
    inbound.free();
  }
}

export async function loadInbound(
  groupId: string,
  senderId: string,
  sessionId: string
): Promise<InboundGroupSession | null> {
  const raw = await metaGet(inKey(groupId, senderId, sessionId));
  if (!raw) return null;
  try {
    return await unpickleInbound(raw, await pickleKey());
  } catch {
    return null;
  }
}

export async function saveInbound(
  groupId: string,
  senderId: string,
  sessionId: string,
  session: InboundGroupSession
): Promise<void> {
  await metaSet(
    inKey(groupId, senderId, sessionId),
    pickleInbound(session, await pickleKey())
  );
}

/**
 * Komfort: exportiert die outbound-Session zum Versand an einen neuen
 * Empfänger. Wird typischerweise nach `ensureOutbound` direkt aufgerufen
 * und dann über den 1:1-Olm-Channel an jeden Group-Member geschickt.
 */
export async function exportOutboundForRecipient(
  groupId: string
): Promise<{ sessionId: string; sessionKey: string; messageIndex: number }> {
  const out = await ensureOutbound(groupId);
  try {
    return exportGroupSessionKey(out);
  } finally {
    out.free();
  }
}
