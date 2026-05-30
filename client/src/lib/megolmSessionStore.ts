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
/** Gecachter Index-0-Session-Key der eigenen Outbound-Session (s.
 *  exportOutboundForRecipient). */
function outKey0(groupId: string): string {
  return `megolmOutKey0:${groupId}`;
}

/**
 * Cacht den Session-Key der Outbound-Session bei Ratchet-Index 0 (also direkt
 * nach Erzeugung/Rotation, BEVOR die erste Nachricht verschlüsselt wurde).
 * Dieser Key erlaubt dem Empfänger, die Session ab der ALLERERSTEN Nachricht
 * zu entschlüsseln — entscheidend, wenn der Key spät ankommt (Glare-Recovery /
 * Key-Request-Selbstheilung), denn session_key() am aktuellen Index würde nur
 * ab dort vorwärts entschlüsseln und frühe Nachrichten verlieren.
 */
async function cacheOutboundIndex0(
  groupId: string,
  session: OutboundGroupSession
): Promise<void> {
  try {
    const k0 = exportGroupSessionKey(session); // direkt nach Erzeugung == Index 0
    await metaSet(
      outKey0(groupId),
      JSON.stringify({ sessionId: k0.sessionId, sessionKey: k0.sessionKey })
    );
  } catch {
    /* best-effort */
  }
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
  await cacheOutboundIndex0(groupId, fresh);
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
  await cacheOutboundIndex0(groupId, fresh);
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
    const liveId = out.session_id();
    // Bevorzugt den gecachten Index-0-Key der AKTUELLEN Session, damit auch
    // spät empfangende Mitglieder ab der ersten Nachricht entschlüsseln können.
    const cached = await metaGet(outKey0(groupId));
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as {
          sessionId?: string;
          sessionKey?: string;
        };
        if (parsed.sessionId === liveId && parsed.sessionKey) {
          return {
            sessionId: parsed.sessionId,
            sessionKey: parsed.sessionKey,
            messageIndex: 0,
          };
        }
      } catch {
        /* defekter Cache → unten neu schreiben */
      }
    }
    // Kein gültiger Index-0-Cache (z.B. Session vor diesem Fix erzeugt):
    // aktuellen Key exportieren und für künftige Verteilungen cachen, damit ab
    // jetzt wenigstens ein konsistenter Schlüssel verteilt wird.
    const k = exportGroupSessionKey(out);
    await metaSet(
      outKey0(groupId),
      JSON.stringify({ sessionId: k.sessionId, sessionKey: k.sessionKey })
    );
    return k;
  } finally {
    out.free();
  }
}
