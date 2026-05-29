/**
 * PWA install-prompt plumbing.
 *
 * Chromium fires a `beforeinstallprompt` event when the app meets the
 * installability criteria (valid manifest, served over HTTPS, service
 * worker). The browser's own mini-infobar can be suppressed and the event
 * stashed so we can surface a first-class "Install app" button at a moment
 * of our choosing (Settings, empty state) instead of relying on the
 * easy-to-miss address-bar icon.
 *
 * Safari/iOS does not fire this event (install = "Add to Home Screen" from
 * the share sheet), so `useInstallAvailable()` stays false there and the UI
 * simply hides the button — no broken affordance.
 *
 * Dependency-free store mirroring the i18n/theme pattern: a module-level
 * captured event + a `useSyncExternalStore` hook.
 */
import { useSyncExternalStore } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** True once the app is running as an installed PWA (standalone window). */
export function isStandalone(): boolean {
  try {
    return (
      window.matchMedia?.("(display-mode: standalone)")?.matches === true ||
      // iOS Safari legacy flag
      (window.navigator as unknown as { standalone?: boolean }).standalone ===
        true
    );
  } catch {
    return false;
  }
}

/** Wire up the global listeners once, from main.tsx. Safe to call repeatedly. */
let initialized = false;
export function initInstallPrompt(): void {
  if (initialized) return;
  initialized = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    // Suppress the default mini-infobar; we provide our own button.
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    emit();
  });
}

/**
 * Trigger the native install dialog. Returns the user's choice, or "unavailable"
 * if no deferred prompt is held (e.g. already installed, or unsupported
 * browser). The event can only be used once, so it is cleared afterwards.
 */
export async function promptInstall(): Promise<
  "accepted" | "dismissed" | "unavailable"
> {
  if (!deferred) return "unavailable";
  const evt = deferred;
  deferred = null;
  emit();
  try {
    await evt.prompt();
    const { outcome } = await evt.userChoice;
    return outcome;
  } catch {
    return "unavailable";
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Subscribe a component to install availability. True only when the browser
 * has offered an installable prompt AND the app is not already installed.
 */
export function useInstallAvailable(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => deferred !== null && !isStandalone(),
    () => false
  );
}
