/**
 * Server-side Replay Protection.
 *
 * Aktuelle Lage (vor diesem Modul):
 *  - Client hat eine 5-min Map<cid, ts> in replayProtection.ts.
 *  - Server selbst prüft NIE, ob ein Envelope schon mal in den letzten Sekunden
 *    durchgelaufen ist. Ein Angreifer mit gestohlenem JWT kann alte Envelopes
 *    erneut absenden — der Server relayed sie an den Empfänger, dort fängt zwar
 *    die DR-Counter-Logik den Replay ab (drDecrypt: replay_or_out_of_order),
 *    aber bis dahin haben wir Bandbreite verbraten und potenziell den
 *    Empfänger mit verworfenen Frames bombardiert.
 *
 * Ziel:
 *  - Pro Sender-userId einen kleinen Sliding-Window-Set von Envelope-Hashes.
 *  - Identische Envelopes innerhalb des Fensters werden silently gedropt
 *    (mit ws_replay_drop log).
 *
 * Hash:
 *  - SHA-256 der ersten N Bytes des Envelope-Strings reicht, weil zwei
 *    legitime Sealed-Sender-Envelopes auch bei identischem Plaintext
 *    unterschiedliche Bytes haben (eingebauter ephemeral key in
 *    crypto_box_seal). Eine Kollision würde voraussetzen, dass der gleiche
 *    Sender genau denselben Envelope-Wert zweimal generiert — was für einen
 *    legitimen Client ausgeschlossen ist.
 *  - Wir hashen die ersten 256 Bytes (Sealed-Box-Header + Anfang des Cipher),
 *    das vermeidet, große Files mehrfach durch SHA-256 zu jagen.
 *
 * Speicher:
 *  - Pro Sender: max RECENT_PER_SENDER Hashes, FIFO-Eviction.
 *  - Plus Zeitfenster RECENT_WINDOW_MS — alles ältere fällt raus.
 *  - Worst-case: senders × RECENT_PER_SENDER × ~32 Byte Map-Entry.
 */

import { createHash } from "node:crypto";

const RECENT_PER_SENDER = 256;
const RECENT_WINDOW_MS = 10 * 60 * 1000; // 10 min

const recent = new Map<string, Map<string, number>>();

function hashSample(envelopeB64: string): string {
  const sample = envelopeB64.slice(0, 256);
  return createHash("sha256").update(sample).digest("base64").slice(0, 22);
}

function pruneOnInsert(map: Map<string, number>, now: number) {
  const cutoff = now - RECENT_WINDOW_MS;
  for (const [k, ts] of map) {
    if (ts > cutoff) break;
    map.delete(k);
  }
  while (map.size >= RECENT_PER_SENDER) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/**
 * Markiert den Envelope-Hash als "gerade gesehen". Returns true wenn neu,
 * false wenn dieser Hash innerhalb des Fensters schon mal vom selben Sender
 * kam — Caller sollte das Frame dann verwerfen.
 */
export function markIfNew(senderUserId: string, envelopeB64: string): boolean {
  let map = recent.get(senderUserId);
  if (!map) {
    map = new Map();
    recent.set(senderUserId, map);
  }
  const h = hashSample(envelopeB64);
  if (map.has(h)) return false;
  const now = Date.now();
  pruneOnInsert(map, now);
  map.set(h, now);
  return true;
}

export function clearReplayState(senderUserId: string): void {
  recent.delete(senderUserId);
}

export function replayStats(): { senders: number; entries: number } {
  let entries = 0;
  for (const m of recent.values()) entries += m.size;
  return { senders: recent.size, entries };
}
