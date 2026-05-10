/**
 * Service-Worker-Registrierung.
 *
 * Idempotent: kann mehrfach aufgerufen werden ohne mehrere SWs zu registrieren.
 * Bei Update wird neu aktiviert und controllerchange feuert — der Caller
 * (z.B. App.tsx) kann darauf hören, um einen "Neuer Build verfügbar"-Toast
 * zu zeigen.
 *
 * Bewusst Opt-in via env-Flag, damit lokale Entwicklung (Vite dev server)
 * nicht versehentlich den SW cached.
 */

const SW_URL = "/sw.js";

export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  if (typeof window === "undefined") return;
  // SW nur in Production registrieren — sonst cached Vite dev-server-output.
  if (!isProductionLike()) return;
  // SW-Registrierung im Idle, damit der Boot-Pfad nicht blockiert.
  const run = () => {
    void navigator.serviceWorker
      .register(SW_URL)
      .then((reg) => {
        // eslint-disable-next-line no-console
        console.debug("[vaultchat:sw] registered", {
          scope: reg.scope,
          active: !!reg.active,
        });
      })
      .catch((err: unknown) => {
        // SW-Registrierung darf den Boot nicht killen — Render-Free
        // serviert sw.js evtl. mal kurz mit falschem MIME, das wäre kein
        // Hard-Fail.
        // eslint-disable-next-line no-console
        console.warn(
          "[vaultchat:sw] registration_failed",
          err instanceof Error ? err.message : String(err)
        );
      });
  };
  // requestIdleCallback wo verfügbar, sonst nach erstem Paint.
  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (typeof ric === "function") {
    ric(run, { timeout: 5000 });
  } else {
    setTimeout(run, 1000);
  }
}

function isProductionLike(): boolean {
  try {
    if (typeof import.meta !== "undefined") {
      // @ts-expect-error vite-only flag
      if (import.meta.env?.DEV === true) return false;
    }
  } catch {
    /* not a Vite build */
  }
  // Heuristic: localhost / 127.* / .local sind dev.
  const host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) {
    return false;
  }
  return true;
}

/**
 * Wird beim Logout/Reset aufgerufen, damit der SW vom nächsten Boot
 * komplett neu lädt (z.B. nach Code-Integrity-Mismatch).
 */
export async function unregisterServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  } catch {
    /* not fatal */
  }
}
