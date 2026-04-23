/**
 * Anti-Replay-Schutz für VaultChat-Nachrichten
 * 
 * Verhindert Nachrichten-Replay-Angriffe durch:
 * - Client-seitige Duplicate-Detection mit kompaktem Set
 * - Message-ID basierte Prüfung mit Zeitfenster
 * - Automatisches Cleanup alter Einträge
 * 
 * Hinweis: Server-seitiger Sequence-Check wird separat empfohlen
 * (in wsHub.ts als Token-Bucket + weitere Maßnahmen)
 */

// Kompakte Set-Struktur für Message-IDs
// Verwendet ein zeitbasiertes Fenster mit automatischer Bereinigung
const MAX_MESSAGE_IDS = 1000; // Maximale Anzahl gespeicherter IDs
const MESSAGE_WINDOW_MS = 5 * 60 * 1000; // 5 Minuten Fenster für Replay-Schutz

type MessageRecord = {
  cid: string;
  receivedAt: number;
};

let _recentMessages: MessageRecord[] = [];

/**
 * Prüft ob eine Message-ID bereits verarbeitet wurde.
 * @param cid Client-generierte Message-ID
 * @returns true wenn Duplikat, false wenn neu
 */
export function isMessageDuplicate(cid: string): boolean {
  const now = Date.now();
  
  // Prüfe ob ID bereits existiert
  const exists = _recentMessages.some((r) => r.cid === cid);
  if (exists) {
    return true;
  }
  
  // Füge neue ID hinzu
  _recentMessages.push({
    cid,
    receivedAt: now,
  });
  
  // Cleanup alter Einträge
  cleanupOldMessages(now);
  
  return false;
}

/**
 * Prüft und markiert eine Message-ID als verarbeitet (atomar).
 * @param cid Client-generierte Message-ID
 * @returns true wenn Duplikat (sollte verworfen werden), false wenn neu
 */
export function checkAndMarkMessage(cid: string): boolean {
  if (isMessageDuplicate(cid)) {
    return true; // Duplikat
  }
  return false; // Neu
}

/**
 * Bereinigt alte Message-IDs außerhalb des Zeitfensters.
 */
function cleanupOldMessages(now: number): void {
  const cutoff = now - MESSAGE_WINDOW_MS;
  
  // Alte Einträge entfernen
  const before = _recentMessages.length;
  _recentMessages = _recentMessages.filter((r) => r.receivedAt > cutoff);
  
  // Falls Set zu groß wird, älteste entfernen
  if (_recentMessages.length > MAX_MESSAGE_IDS) {
    _recentMessages = _recentMessages
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, MAX_MESSAGE_IDS);
  }
}

/**
 * Setzt die Replay-Protection zurück (z.B. bei Lock).
 */
export function resetReplayProtection(): void {
  _recentMessages = [];
}

/**
 * Gibt Statistiken zurück (für Debugging).
 */
export function getReplayStats(): { stored: number; windowMs: number } {
  return {
    stored: _recentMessages.length,
    windowMs: MESSAGE_WINDOW_MS,
  };
}

/**
 * Gruppenspezifische Replay-Protection.
 * Hält separate Sets pro Gruppe.
 */
const _groupMessages = new Map<string, MessageRecord[]>();

export function isGroupMessageDuplicate(groupId: string, messageId: string): boolean {
  const now = Date.now();
  let messages = _groupMessages.get(groupId);
  
  if (!messages) {
    messages = [];
    _groupMessages.set(groupId, messages);
  }
  
  const exists = messages.some((r) => r.cid === messageId);
  if (exists) {
    return true;
  }
  
  messages.push({
    cid: messageId,
    receivedAt: now,
  });
  
  // Cleanup
  const cutoff = now - MESSAGE_WINDOW_MS;
  _groupMessages.set(
    groupId,
    messages.filter((r) => r.receivedAt > cutoff)
  );
  
  return false;
}

/**
 * Setzt gruppenspezifische Replay-Protection zurück.
 */
export function resetGroupReplayProtection(groupId: string): void {
  _groupMessages.delete(groupId);
}

/**
 * Setzt alle Replay-Protection-Daten zurück.
 */
export function resetAllReplayProtection(): void {
  _recentMessages = [];
  _groupMessages.clear();
}
