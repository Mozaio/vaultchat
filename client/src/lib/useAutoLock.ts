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
    if (!enabled || timeoutMs <= 0) return;
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

const AUTO_LOCK_STORAGE_KEY = "vaultchat.autoLockMinutes";
/** Default 10 minutes; 0 = never auto-lock. */
const DEFAULT_AUTO_LOCK_MINUTES = 10;
const AUTO_LOCK_CHANGED_EVENT = "vaultchat:autoLockChanged";

export function loadAutoLockMinutes(): number {
  try {
    const raw = localStorage.getItem(AUTO_LOCK_STORAGE_KEY);
    if (raw === null) return DEFAULT_AUTO_LOCK_MINUTES;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_AUTO_LOCK_MINUTES;
    return Math.floor(n);
  } catch {
    return DEFAULT_AUTO_LOCK_MINUTES;
  }
}

export function saveAutoLockMinutes(minutes: number): void {
  try {
    const clamped = Math.max(0, Math.floor(minutes));
    localStorage.setItem(AUTO_LOCK_STORAGE_KEY, String(clamped));
    window.dispatchEvent(
      new CustomEvent(AUTO_LOCK_CHANGED_EVENT, { detail: clamped })
    );
  } catch {
    /* ignore */
  }
}

export function subscribeAutoLockMinutes(
  listener: (minutes: number) => void
): () => void {
  const handler = (ev: Event) => {
    const detail = (ev as CustomEvent<number>).detail;
    if (typeof detail === "number") listener(detail);
  };
  window.addEventListener(AUTO_LOCK_CHANGED_EVENT, handler);
  return () => window.removeEventListener(AUTO_LOCK_CHANGED_EVENT, handler);
}
