/**
 * Theme-Store: Persistiert Theme-Präferenz in localStorage
 * (unverschlüsselt, da UI-Präferenz, keine sensiblen Daten).
 */
export type Theme = "light" | "dark" | "system";

const THEME_KEY = "vaultchat.theme";

function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark" || stored === "system")
      return stored;
  } catch {
    /* ignore */
  }
  // Default to the polished "Clean Light" experience. Users can still pick
  // dark or system from the theme toggle.
  return "light";
}

export function getTheme(): Theme {
  return getStoredTheme();
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
  applyTheme(theme);
}

export function applyTheme(theme: Theme = getStoredTheme()): void {
  const root = document.documentElement;
  if (theme === "system") {
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
    root.classList.toggle("dark", Boolean(prefersDark));
  } else {
    root.classList.toggle("dark", theme === "dark");
  }
}

export function initTheme(): void {
  applyTheme();
  const mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
  mediaQuery?.addEventListener?.("change", () => {
    if (getStoredTheme() === "system") {
      applyTheme("system");
    }
  });
}

