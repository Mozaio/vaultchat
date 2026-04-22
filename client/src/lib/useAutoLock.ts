/**
 * Auto-Lock bei Inaktivität.
 *
 * Zählt Benutzerinteraktionen (Maus, Tastatur, Touch, Sichtbarkeitswechsel)
 * und ruft `onLock` auf, wenn `timeoutMs` ohne Interaktion verstreicht.
 *
 * Ziel: Ein ungeöffnetes, laufendes Browser-Fenster soll den entsperrten
 * LDK nicht unbegrenzt im Speicher halten. Nach Ablauf ist ein neues
 * Passwort nötig, um die IndexedDB wieder zu entschlüsseln.
 */
import { useEffect } from "react";

export function useAutoLock(enabled: boolean, timeoutMs: number, onLock: () => void) {
  useEffect(() => {
    if (!enabled) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (t) clearTimeout(t);
      t = setTimeout(onLock, timeoutMs);
    };
    const ev = ["mousemove", "keydown", "touchstart", "visibilitychange"] as const;
    ev.forEach((k) => window.addEventListener(k, arm, { passive: true }));
    arm();
    return () => {
      if (t) clearTimeout(t);
      ev.forEach((k) => window.removeEventListener(k, arm));
    };
  }, [enabled, timeoutMs, onLock]);
}
