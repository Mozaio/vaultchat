/**
 * Make the Tauri WebView feel like a native app instead of a browser tab:
 * suppress the right-click context menu, pinch/ctrl-wheel zoom and the
 * ctrl +/-/0 zoom shortcuts, and native image/link dragging. Also tags the
 * document with `is-tauri` so desktop-only CSS (e.g. the custom title bar)
 * can hook in.
 *
 * No-op outside Tauri — the web/PWA keeps normal browser behavior.
 */
import { isTauri } from "./desktopNotify";

export function initDesktopChrome(): void {
  if (!isTauri()) return;
  document.documentElement.classList.add("is-tauri");

  // No browser context menu (Reload / Inspect / "Save image as" …) — keep it
  // inside editable fields so copy/paste menus still work there.
  window.addEventListener("contextmenu", (e) => {
    const t = e.target as HTMLElement | null;
    const editable =
      !!t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.isContentEditable);
    if (!editable) e.preventDefault();
  });

  // No ctrl/cmd + wheel browser zoom.
  window.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    },
    { passive: false }
  );

  // No ctrl/cmd +/-/0 zoom shortcuts.
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && ["+", "-", "=", "0"].includes(e.key)) {
      e.preventDefault();
    }
  });

  // No dragging images/links out of the window like a web page.
  window.addEventListener("dragstart", (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "IMG" || t.tagName === "A")) e.preventDefault();
  });
}
