/**
 * Einzel-Geräte-Revocation (GOAL Phase 2: „aktive Geräte sehen, einzeln
 * widerrufen"). RAM-only, ergänzt — bricht NICHT — die bestehende
 * grob-granulare `tokenEpoch`-Revocation ("auf allen Geräten abmelden").
 *
 * Zero-Knowledge-Grenze (bewusst eng gehalten):
 * - Eine `deviceId` ist ein OPAKER, vom CLIENT zufällig erzeugter String
 *   (siehe `dv`-JWT-Claim). Sie ist NICHT an Hardware, IP oder Identität
 *   gebunden — der Server erfährt durch sie nichts Neues über den Nutzer,
 *   außer dass es "eine weitere Session" gibt (das verriet die Socket-Zahl
 *   via `getWsStats` ohnehin schon).
 * - Hier wird KEIN Geräte-Label, kein User-Agent, keine IP gespeichert. Der
 *   Server hält nur die Menge der WIDERRUFENEN deviceIds pro User, damit
 *   `verifyToken` ein einzelnes Token entwerten kann.
 * - Die LISTE der aktiven Geräte stammt aus der ohnehin vorhandenen Live-WS-
 *   Registry (`wsHub`), nicht aus persistenten Metadaten. Sie ist also rein
 *   ephemer (nur aktuell verbundene Sockets) und überlebt keinen Restart.
 *
 * Persistenz: bewusst NICHT persistiert. Der gesamte Server-State ist heute
 * RAM-only (`state: ephemeral`, hängt an GOAL 0.1a); ein widerrufenes Gerät
 * bleibt widerrufen, solange der Prozess lebt. Nach einem echten Restart sind
 * ohnehin alle Live-Sockets weg und der Nutzer meldet sich neu an. (Ein
 * gestohlenes Token überlebt einen Restart formal weiter — exakt dieselbe
 * Einschränkung wie bei `tokenEpoch`, das ebenfalls nur via memoryStore-
 * Persistenz dauerhaft wäre. Ein Re-Login mintet eine frische deviceId.)
 */

/** userId → Set widerrufener deviceIds. */
const revokedByUser = new Map<string, Set<string>>();

/** Obergrenze pro User, damit ein bösartiger Client den Speicher nicht mit
 *  endlosen Fake-Revokes flutet (jede deviceId ist ohnehin client-erzeugt). */
const MAX_REVOKED_PER_USER = 512;

/** Markiert ein Gerät als widerrufen. Idempotent. */
export function revokeDevice(userId: string, deviceId: string): void {
  if (!userId || !deviceId) return;
  let set = revokedByUser.get(userId);
  if (!set) {
    set = new Set();
    revokedByUser.set(userId, set);
  }
  if (set.size >= MAX_REVOKED_PER_USER && !set.has(deviceId)) {
    // Ältesten Eintrag verwerfen (Insertion-Order von Set) — die Revocation
    // eines sehr alten Geräts ist praktisch bedeutungslos, weil dessen Token
    // ohnehin längst per TTL/te abgelaufen ist.
    const first = set.values().next().value;
    if (first !== undefined) set.delete(first);
  }
  set.add(deviceId);
}

/** Prüft, ob `(userId, deviceId)` widerrufen wurde. */
export function isDeviceRevoked(userId: string, deviceId: string): boolean {
  if (!userId || !deviceId) return false;
  return revokedByUser.get(userId)?.has(deviceId) ?? false;
}

/** Hebt die Revocation aller Geräte eines Users auf (z.B. nach logout-all,
 *  das die Epoch bumpt und damit ohnehin alles entwertet — die explizite
 *  Einzel-Liste wäre dann nur Ballast). */
export function clearRevokedDevices(userId: string): void {
  revokedByUser.delete(userId);
}

/** Test-Hilfe: kompletten Zustand zurücksetzen. */
export function _resetDeviceSessionsForTest(): void {
  revokedByUser.clear();
}
