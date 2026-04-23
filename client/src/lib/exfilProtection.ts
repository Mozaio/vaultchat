/**
 * Anti-Exfiltration Protection für VaultChat
 * 
 * Zusätzlicher Schutz gegen RAM-Exfiltration bei aktiver Sitzung:
 * - Periodisches Wiping des Local Data Key (LDK) mit Zufallsdaten
 * - Zusätzliches Wiping bei Tab-Wechsel/Visibility-Änderung
 * - Randomisierte Wipe-Intervalle zur Erschwerung von Timing-Angriffen
 */
import { getSodium, sodiumReady } from "./sodium";

let _wipeInterval: ReturnType<typeof setTimeout> | null = null;
let _lastActivity = Date.now();

// Normal Mode: 30-120 Sekunden
const MIN_WIPE_INTERVAL_NORMAL = 30_000;
const MAX_WIPE_INTERVAL_NORMAL = 120_000;

// Extreme Mode: 15-60 Sekunden (aggressiver)
const MIN_WIPE_INTERVAL_EXTREME = 15_000;
const MAX_WIPE_INTERVAL_EXTREME = 60_000;

type SecurityMode = "normal" | "extreme";
let _securityMode: SecurityMode = "normal";

// Aktive Referenzen auf sensitive Daten (werden bei Bedarf gewipt)
const _sensitiveRefs: Array<{ ref: Uint8Array; name: string }> = [];

let _keyRef: Uint8Array | null = null;

/**
 * Registriert den Local Data Key für periodisches Wiping.
 * Diese Funktion sollte nach setLocalKeyFromSecret aufgerufen werden.
 */
export function registerKeyForProtection(key: Uint8Array): void {
  _keyRef = key;
}

/**
 * Entfernt die Key-Referenz bei Lock.
 */
export function unregisterKeyForProtection(): void {
  _keyRef = null;
}

/**
 * Führt sofortiges Wiping aller sensitiven Daten durch.
 * Kann manuell oder bei Tab-Wechsel aufgerufen werden.
 */
export async function immediateWipe(): Promise<void> {
  await sodiumReady();
  const sodium = getSodium();
  
  // Wipe aller registrierten Referenzen
  for (const { ref, name } of _sensitiveRefs) {
    if (ref && ref.length > 0) {
      sodium.memzero(ref);
      // Ersetzen mit Zufallsdaten (additional confusion)
      const noise = sodium.randombytes_buf(ref.length);
      ref.set(noise);
      sodium.memzero(noise);
    }
  }
  
  // Primären LDK wipen
  if (_keyRef) {
    sodium.memzero(_keyRef);
  }
}

/**
 * Setzt den Security-Modus (normal/extreme).
 * @param mode Der neue Sicherheitsmodus
 */
export function setSecurityMode(mode: SecurityMode): void {
  _securityMode = mode;
}

/**
 * Aktiviert periodisches Memory-Wiping bei aktiver Sitzung.
 * Wird automatisch bei Entsperrung aktiviert.
 */
export function startPeriodicWipe(): void {
  if (_wipeInterval) return;
  
  const scheduleNextWipe = () => {
    // Zufälliges Intervall basierend auf Security Mode
    const min = _securityMode === "extreme" ? MIN_WIPE_INTERVAL_EXTREME : MIN_WIPE_INTERVAL_NORMAL;
    const max = _securityMode === "extreme" ? MAX_WIPE_INTERVAL_EXTREME : MAX_WIPE_INTERVAL_NORMAL;
    const jitter = Math.random() * (max - min);
    const interval = min + jitter;
    
    _wipeInterval = setTimeout(async () => {
      const timeSinceActivity = Date.now() - _lastActivity;
      
      // Nur wipen wenn aktiv in letzter Zeit
      const maxInactivity = _securityMode === "extreme" ? 30_000 : 60_000;
      if (timeSinceActivity < maxInactivity) {
        await immediateWipe();
      }
      
      // Nächstes Wipe planen
      if (_wipeInterval) {
        clearTimeout(_wipeInterval);
        _wipeInterval = null;
      }
      scheduleNextWipe();
    }, interval);
  };
  
  scheduleNextWipe();
  
  // Zusätzlicher Schutz bei Tab-Wechsel (immer aktiv)
  document.addEventListener("visibilitychange", handleVisibilityChange, { passive: true });
}

/**
 * Stoppt periodisches Memory-Wiping (bei Lock).
 */
export function stopPeriodicWipe(): void {
  if (_wipeInterval) {
    clearTimeout(_wipeInterval);
    _wipeInterval = null;
  }
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  _lastActivity = Date.now();
}

/**
 * Aktualisiert die letzte Aktivitätszeit.
 * Sollte bei Benutzerinteraktion aufgerufen werden.
 */
export function touchActivity(): void {
  _lastActivity = Date.now();
}

function handleVisibilityChange(): void {
  // Bei Tab-Wechsel zu einem anderen Tab: wipen (nicht bei return)
  if (document.visibilityState === "hidden") {
    immediateWipe().catch(() => {});
  }
}

/**
 * Registriert eine sensitive Referenz für periodisches Wiping.
 */
export function registerSensitiveRef(ref: Uint8Array, name: string): void {
  const exists = _sensitiveRefs.find((r) => r.name === name);
  if (!exists) {
    _sensitiveRefs.push({ ref, name });
  }
}

/**
 * Entfernt eine sensitive Referenz.
 */
export function unregisterSensitiveRef(name: string): void {
  const idx = _sensitiveRefs.findIndex((r) => r.name === name);
  if (idx !== -1) {
    _sensitiveRefs.splice(idx, 1);
  }
}
