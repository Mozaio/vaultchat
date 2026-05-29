/**
 * Accent-colour personalization. Overrides the accent design tokens on
 * :root via inline style (highest specificity, beats the stylesheet and
 * works in both light/dark). "default" clears the overrides and falls back
 * to the theme's Warm-Cozy terracotta. Persisted in localStorage (UI
 * preference, no sensitive data). Derived tokens use color-mix, which the
 * stylesheet already relies on.
 */
export type AccentId =
  | "default"
  | "ocean"
  | "forest"
  | "violet"
  | "rose"
  | "amber";

export const ACCENTS: { id: AccentId; label: string; color: string }[] = [
  { id: "default", label: "Terracotta", color: "#c75b39" },
  { id: "ocean", label: "Ocean", color: "#2f6fdb" },
  { id: "forest", label: "Forest", color: "#2e9e6b" },
  { id: "violet", label: "Violet", color: "#7c5cdb" },
  { id: "rose", label: "Rose", color: "#db4a6b" },
  { id: "amber", label: "Amber", color: "#d98a26" },
];

const STORAGE_KEY = "vaultchat.accent";

// Tokens we override. Cleared on "default" to revert to the stylesheet.
const OVERRIDDEN = [
  "--accent",
  "--accent-hover",
  "--accent-soft",
  "--accent-glow",
  "--accent-gradient",
  "--bubble-me",
] as const;

function isAccent(x: unknown): x is AccentId {
  return typeof x === "string" && ACCENTS.some((a) => a.id === x);
}

export function loadAccent(): AccentId {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (isAccent(s)) return s;
  } catch {
    /* ignore */
  }
  return "default";
}

export function applyAccent(id: AccentId): void {
  const root = document.documentElement;
  if (id === "default") {
    OVERRIDDEN.forEach((k) => root.style.removeProperty(k));
    return;
  }
  const base = ACCENTS.find((a) => a.id === id)?.color;
  if (!base) return;
  root.style.setProperty("--accent", base);
  root.style.setProperty("--accent-hover", `color-mix(in srgb, ${base} 82%, black)`);
  root.style.setProperty("--accent-soft", `color-mix(in srgb, ${base} 13%, transparent)`);
  root.style.setProperty("--accent-glow", `color-mix(in srgb, ${base} 30%, transparent)`);
  root.style.setProperty("--accent-gradient", base);
  root.style.setProperty("--bubble-me", base);
}

export function saveAccent(id: AccentId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
  applyAccent(id);
}

export function initAccent(): void {
  applyAccent(loadAccent());
}
