/**
 * Notification bridge — native OS notifications under the Tauri desktop app,
 * Web Notifications in a normal browser/PWA.
 *
 * Tauri's WebView (WebView2 on Windows) does not reliably expose the Web
 * Notifications API, so the desktop app routes through
 * `@tauri-apps/plugin-notification` instead. All Tauri imports are dynamic +
 * guarded, so the web/PWA bundle never loads them — they ship in a separate
 * lazy chunk that is only fetched when actually running inside Tauri.
 */

/** True when running inside the Tauri desktop shell. */
export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

/**
 * Show a notification through the best available channel. Best-effort:
 * silently no-ops on any failure or when permission is denied.
 */
export async function sendDesktopNotification(
  title: string,
  body: string
): Promise<void> {
  if (isTauri()) {
    try {
      const n = await import("@tauri-apps/plugin-notification");
      let granted = await n.isPermissionGranted();
      if (!granted) {
        granted = (await n.requestPermission()) === "granted";
      }
      if (granted) n.sendNotification({ title, body });
    } catch {
      /* notification plugin unavailable — ignore */
    }
    return;
  }
  // Browser / PWA fallback.
  try {
    if (
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      // eslint-disable-next-line no-new
      new Notification(title, { body, tag: "umbra-message" });
    }
  } catch {
    /* ignore */
  }
}

/**
 * Flash the taskbar/dock to request attention for a new message when the
 * window isn't focused (Discord-style). No-op outside Tauri / when focused.
 */
export async function flashDesktopWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow, UserAttentionType } = await import(
      "@tauri-apps/api/window"
    );
    const w = getCurrentWindow();
    if (!(await w.isFocused())) {
      await w.requestUserAttention(UserAttentionType.Informational);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Reflect the total unread count in the window/tab title (Discord-style
 * "(3) Umbra"). Updates the browser tab title everywhere, and additionally
 * the native window title + taskbar badge under Tauri. Best-effort.
 */
export async function setUnreadBadge(count: number): Promise<void> {
  const base = "Umbra";
  const title = count > 0 ? `(${count > 99 ? "99+" : count}) ${base}` : base;
  try {
    document.title = title;
  } catch {
    /* ignore */
  }
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    await w.setTitle(title);
    // Numeric taskbar/dock badge — supported on macOS/Linux; harmless no-op
    // (or unsupported) on Windows, hence the inner guard.
    try {
      const setBadge = (w as unknown as {
        setBadgeCount?: (n?: number) => Promise<void>;
      }).setBadgeCount;
      if (setBadge) await setBadge.call(w, count > 0 ? count : undefined);
    } catch {
      /* badge unsupported on this platform */
    }
  } catch {
    /* ignore */
  }
}

/**
 * Proactively ensure notification permission under Tauri (called once at
 * startup). Browser permission is requested lazily via the in-app prompt, so
 * this is a no-op outside Tauri.
 */
export async function ensureDesktopNotifyPermission(): Promise<void> {
  if (!isTauri()) return;
  try {
    const n = await import("@tauri-apps/plugin-notification");
    if (!(await n.isPermissionGranted())) {
      await n.requestPermission();
    }
  } catch {
    /* ignore */
  }
}
