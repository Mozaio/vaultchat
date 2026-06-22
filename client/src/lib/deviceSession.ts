/**
 * Stabile, OPAKE Geräte-/Session-ID für die Geräte-Verwaltung (GOAL Phase 2).
 *
 * Diese ID wird beim Login/Register an den Server geschickt und in das JWT
 * eingebacken (`dv`-Claim), damit ein EINZELNES Gerät widerrufen werden kann
 * (ohne alle anderen mitzunehmen — anders als „auf allen Geräten abmelden").
 *
 * Privatsphäre: rein zufällig (crypto), NICHT aus Hardware/IP/Identität
 * abgeleitet — der Server lernt durch die ID nichts über den Nutzer außer
 * „dies ist eine eigenständige Session". Pro Browser/Profil persistiert in
 * localStorage; ein neues Gerät / ein gelöschtes localStorage erzeugt eine
 * frische ID (= zählt dann als neues Gerät, was korrekt ist).
 */
const STORAGE = "vaultchat.deviceId.v1";

function randomId(): string {
  // 16 zufällige Bytes → URL-sicherer base64-String (kein Padding-Müll).
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Liefert die stabile Geräte-ID dieses Browsers/Profils, erzeugt sie beim
 * ersten Aufruf. Best-effort: wenn localStorage nicht verfügbar ist
 * (Privatmodus o.Ä.), wird eine flüchtige In-Memory-ID zurückgegeben, damit
 * der Login-Pfad nie bricht.
 */
let _memoryFallback: string | null = null;
export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(STORAGE);
    if (existing && existing.length > 0) return existing;
    const fresh = randomId();
    localStorage.setItem(STORAGE, fresh);
    return fresh;
  } catch {
    if (!_memoryFallback) _memoryFallback = randomId();
    return _memoryFallback;
  }
}
