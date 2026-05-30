/**
 * Message density personalization (Discord-style "Cozy" vs "Compact").
 * Toggles a `data-density` attribute on :root; the stylesheet adjusts message
 * spacing/avatars accordingly. Persisted in localStorage (UI preference, no
 * sensitive data).
 */
export type DensityId = "cozy" | "compact";

const STORAGE_KEY = "vaultchat.density";

function isDensity(x: unknown): x is DensityId {
  return x === "cozy" || x === "compact";
}

export function loadDensity(): DensityId {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (isDensity(s)) return s;
  } catch {
    /* ignore */
  }
  return "cozy";
}

export function applyDensity(id: DensityId): void {
  const root = document.documentElement;
  // "cozy" is the stylesheet default — keep the attribute absent so there's a
  // single source of truth and nothing to clean up.
  if (id === "cozy") {
    root.removeAttribute("data-density");
  } else {
    root.setAttribute("data-density", id);
  }
}

export function saveDensity(id: DensityId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
  applyDensity(id);
}

export function initDensity(): void {
  applyDensity(loadDensity());
}
