# Umbra Desktop (Tauri)

A standalone desktop app that wraps the existing web client in a native
[Tauri v2](https://v2.tauri.app/) shell. Same code, same E2EE — but it
installs and launches like a native app (Discord-style), with full WebRTC
(voice, group calls **and** screen share) and OS-native notifications.

## Why Tauri (not Electron)

- **Tiny + secure.** Uses the OS WebView (WebView2/Chromium on Windows), so
  binaries are ~5–10 MB instead of ~100 MB, and there is no bundled Node
  runtime — a much smaller native attack surface, in line with Umbra's
  Signal-level security goal.
- **Full feature parity.** WebView2 is Chromium, so WASM (Olm/libsodium),
  WebRTC (incl. `getDisplayMedia` screen share) and IndexedDB all work.
- **~99% code reuse.** The native layer (`src-tauri/`) is intentionally thin:
  a window, a strict CSP, and the notification plugin. No custom Rust commands
  and no fs/shell/http capability is exposed to the web context.

## How the app reaches the backend

In a packaged app the web code runs from a local WebView origin, not from the
server — so relative `/api` calls and `location`-based WebSocket URLs would
break. Umbra already supports build-time overrides, so **no app code changes
are needed** — just set these when building:

```
VITE_API_BASE=https://vaultchat-server-g0p2.onrender.com
VITE_WS_URL=wss://vaultchat-server-g0p2.onrender.com
```

`apiBase()` (lib/api.ts) and `getWsUrl()` (lib/wsUrl.ts) read these.

## Security posture

- Strict CSP in `src-tauri/tauri.conf.json` → `app.security.csp`:
  `default-src 'self'`, scripts limited to `'self' 'wasm-unsafe-eval'`,
  `connect-src` pinned to the Umbra backend (https + wss) only, `object-src
  'none'`, `frame-ancestors 'none'`.
- Capability set (`src-tauri/capabilities/default.json`) grants only
  `core:default` + `notification:default`. No filesystem, shell, or HTTP
  plugin is reachable from JS.
- Per-asset Subresource Integrity is disabled for this target
  (`VITE_DISABLE_SRI=1`): the desktop bundle ships as a single signed
  artifact, so SRI adds little and can interfere with the WebView loader.

## Build it

### Via CI (recommended — no local toolchain)

Push a `v*` tag or run the **Desktop (Windows)** workflow manually
(`.github/workflows/desktop-windows.yml`). It builds on a Windows runner and
uploads `.exe` (NSIS) + `.msi` installers as artifacts.

### Locally on Windows

Prerequisites: Node 20+, Rust (stable), and the
[WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
(preinstalled on Windows 10/11).

```bash
cd client
npm install
npm run tauri:icon        # generate icons from src-tauri/app-icon.svg (once)

# Dev (hot-reload, talks to a local server via the vite proxy):
npm run tauri:dev

# Production build (point at the hosted backend):
#   PowerShell:
#     $env:VITE_API_BASE="https://vaultchat-server-g0p2.onrender.com"
#     $env:VITE_WS_URL="wss://vaultchat-server-g0p2.onrender.com"
#     $env:VITE_DISABLE_SRI="1"
npm run tauri:build
```

Installers land in `client/src-tauri/target/release/bundle/`.

## Platform notes & roadmap

- **Screen share** works on desktop (unlike iOS Safari/WebView, which has no
  `getDisplayMedia`).
- **Notifications:** bridged to the native `notification` plugin when running
  under Tauri (detected via `window.__TAURI__`); falls back to Web
  Notifications in the browser. See `lib/desktopNotify.ts`.
- **Discord-class shell (done):** system tray with Show/Quit menu,
  close-to-tray (closing hides; quit via tray), left-click tray to restore,
  single-instance focus (second launch focuses the running window), and
  persisted window size/position across launches.
- **Planned:** deep links for invite URLs (`umbra://` + https), an in-app
  toggle for close-to-tray vs close-to-quit, and signed auto-updates (needs a
  signing keypair + update endpoint).

## Relationship to mobile

The same `VITE_API_BASE`/`VITE_WS_URL` mechanism unblocks the future
Capacitor mobile builds (Android, then iOS via cloud macOS CI). Solving it
here de-risks those.
