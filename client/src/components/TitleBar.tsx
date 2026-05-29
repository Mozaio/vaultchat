/**
 * Custom frameless title bar for the Tauri desktop app (Discord/Slack/VS Code
 * style). Renders only inside Tauri — `null` in the browser, so the web/PWA is
 * completely unaffected.
 *
 * The bar itself is the OS drag handle (`data-tauri-drag-region`); the window
 * controls call the Tauri window API. Closing routes through the Rust
 * CloseRequested handler → hide-to-tray.
 */
import { useEffect, useState } from "react";
import { isTauri } from "../lib/desktopNotify";
import { VaultChatLogo } from "./Logo";

type WinAction = "minimize" | "toggleMaximize" | "close";

async function windowAction(action: WinAction): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    if (action === "minimize") await w.minimize();
    else if (action === "toggleMaximize") await w.toggleMaximize();
    else await w.close();
  } catch {
    /* ignore */
  }
}

export function TitleBar() {
  const tauri = isTauri();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!tauri) return;
    let unlisten: (() => void) | undefined;
    let active = true;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const w = getCurrentWindow();
        if (active) setMaximized(await w.isMaximized());
        unlisten = await w.onResized(async () => {
          try {
            setMaximized(await w.isMaximized());
          } catch {
            /* ignore */
          }
        });
      } catch {
        /* ignore */
      }
    })();
    return () => {
      active = false;
      try {
        unlisten?.();
      } catch {
        /* ignore */
      }
    };
  }, [tauri]);

  if (!tauri) return null;

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-brand" data-tauri-drag-region>
        <VaultChatLogo size={15} style={{ color: "var(--accent)" }} />
        <span>Umbra</span>
      </div>
      <div className="titlebar-controls">
        <button
          type="button"
          className="titlebar-btn"
          onClick={() => void windowAction("minimize")}
          aria-label="Minimize"
          title="Minimize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <rect x="1" y="4.5" width="8" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          className="titlebar-btn"
          onClick={() => void windowAction("toggleMaximize")}
          aria-label={maximized ? "Restore" : "Maximize"}
          title={maximized ? "Restore" : "Maximize"}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <rect x="2.5" y="1" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
              <rect x="1" y="2.5" width="6" height="6" fill="var(--bg-sidebar)" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="titlebar-btn titlebar-close"
          onClick={() => void windowAction("close")}
          aria-label="Close"
          title="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>
      </div>
    </div>
  );
}
