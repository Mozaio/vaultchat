/**
 * Anti-Replay-Schutz für VaultChat-Nachrichten (clientseitig)
 *
 * Verhindert Nachrichten-Replay-Angriffe durch:
 * - Duplicate-Detection mit O(1)-Lookup über Map (vorher: O(n) Array-scan)
 * - Insertion-Order-FIFO-Eviction (Map.keys() ist insertion-ordered, Spec)
 * - Hard-Cap MAX_MESSAGE_IDS + Zeitfenster MESSAGE_WINDOW_MS
 *
 * Hinweis: Diese Schicht ist client-only. Ein vollwertiger Replay-Schutz
 * benötigt zusätzlich serverseitige Sequence-Checks (siehe SECURITY_ROADMAP).
 */

const MAX_MESSAGE_IDS = 1000;
const MESSAGE_WINDOW_MS = 5 * 60 * 1000;

const _seenAt = new Map<string, number>();
const _groupSeen = new Map<string, Map<string, number>>();

function pruneOnInsert(map: Map<string, number>, now: number) {
  // Zeitfenster zuerst: alte Einträge löschen, solange das älteste Element
  // (= erste Map-Iteration, weil insertion-ordered) abgelaufen ist.
  const cutoff = now - MESSAGE_WINDOW_MS;
  for (const [k, ts] of map) {
    if (ts > cutoff) break;
    map.delete(k);
  }
  // Hard-Cap: ältester Eintrag fliegt raus.
  while (map.size >= MAX_MESSAGE_IDS) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/**
 * Prüft ob eine Message-ID bereits verarbeitet wurde.
 * @param cid Client-generierte Message-ID
 * @returns true wenn Duplikat, false wenn neu (und nun gemerkt)
 */
export function isMessageDuplicate(cid: string): boolean {
  if (_seenAt.has(cid)) return true;
  const now = Date.now();
  pruneOnInsert(_seenAt, now);
  _seenAt.set(cid, now);
  return false;
}

/**
 * Alias zu isMessageDuplicate für API-Kompatibilität.
 */
export function checkAndMarkMessage(cid: string): boolean {
  return isMessageDuplicate(cid);
}

/**
 * Setzt die globale Replay-Protection zurück (z.B. bei Lock).
 */
export function resetReplayProtection(): void {
  _seenAt.clear();
}

/**
 * Stats für Debugging.
 */
export function getReplayStats(): { stored: number; windowMs: number } {
  return { stored: _seenAt.size, windowMs: MESSAGE_WINDOW_MS };
}

/**
 * Gruppenspezifischer Replay-Schutz mit eigener Map pro Gruppe.
 */
export function isGroupMessageDuplicate(groupId: string, messageId: string): boolean {
  let map = _groupSeen.get(groupId);
  if (!map) {
    map = new Map<string, number>();
    _groupSeen.set(groupId, map);
  }
  if (map.has(messageId)) return true;
  const now = Date.now();
  pruneOnInsert(map, now);
  map.set(messageId, now);
  return false;
}

export function resetGroupReplayProtection(groupId: string): void {
  _groupSeen.delete(groupId);
}

export function resetAllReplayProtection(): void {
  _seenAt.clear();
  _groupSeen.clear();
}
