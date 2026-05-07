/**
 * Default disappearing-message TTL applied to new conversations that
 * have not had a per-chat value set yet. Stored in localStorage as a
 * number of milliseconds. 0 = off (messages do not disappear by default).
 */

const KEY = "vaultchat.defaultTtlMs";
const CHANGED_EVENT = "vaultchat:defaultTtlChanged";

export function loadDefaultTtl(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

export function saveDefaultTtl(ms: number): void {
  try {
    const clamped = Math.max(0, Math.floor(ms));
    localStorage.setItem(KEY, String(clamped));
    window.dispatchEvent(
      new CustomEvent(CHANGED_EVENT, { detail: clamped })
    );
  } catch {
    /* ignore */
  }
}

export const DEFAULT_TTL_OPTIONS: { ms: number; label: string }[] = [
  { ms: 0, label: "Aus" },
  { ms: 30 * 1000, label: "30 Sekunden" },
  { ms: 5 * 60 * 1000, label: "5 Minuten" },
  { ms: 60 * 60 * 1000, label: "1 Stunde" },
  { ms: 24 * 60 * 60 * 1000, label: "1 Tag" },
  { ms: 7 * 24 * 60 * 60 * 1000, label: "7 Tage" },
];
