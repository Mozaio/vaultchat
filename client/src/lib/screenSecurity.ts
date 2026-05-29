/**
 * Screen Security (inspired by Signal's "Screen Security" setting).
 *
 * When enabled in the Tauri desktop app, the window is marked as
 * content-protected — on Windows it is excluded from screen capture
 * (WDA_EXCLUDEFROMCAPTURE), so screenshots and screen recordings show a
 * black window instead of your conversations. Opt-in; persisted locally.
 *
 * No-op in the browser/PWA (the OS can't be told to exclude a tab), so the
 * toggle is only surfaced in the desktop app.
 */
import { isTauri } from "./desktopNotify";

const KEY = "umbra.screenSecurity";

export function loadScreenSecurity(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

async function applyContentProtection(enabled: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setContentProtected(enabled);
  } catch {
    /* unsupported / no permission — ignore */
  }
}

/** Persist the preference and apply it immediately. */
export async function setScreenSecurity(enabled: boolean): Promise<void> {
  try {
    localStorage.setItem(KEY, enabled ? "on" : "off");
  } catch {
    /* ignore */
  }
  await applyContentProtection(enabled);
}

/** Apply the saved preference at startup (no-op in the browser). */
export function initScreenSecurity(): void {
  if (!isTauri()) return;
  void applyContentProtection(loadScreenSecurity());
}
