# Umbra — project memory for Claude Code

> This file is auto-loaded by every Claude Code session (local CLI **and**
> Claude Code on the web / mobile). It is the portable "shared memory" so any
> session — including from the phone — starts with full context.

## What this is

**Umbra** (formerly "VaultChat") is a **browser-based, end-to-end encrypted
messenger** — Discord-class features at Signal-level privacy. It ships three
ways from the same web client:
- **Web app / PWA** (installable) — the live product.
- **Tauri v2 desktop app** (Windows, standalone, Discord-style shell) — see `DESKTOP.md`.
- (Mobile via Capacitor was scoped but deprioritized; desktop is the focus.)

Repo: `github.com/Mozaio/vaultchat`. Owner: **Musa** (@Mozaio).

## Communicate in German

The user prefers **German (Du-Form)**. Reply in German unless asked otherwise.

## Working style (important)

- **Push small, isolated commits directly to `main`. Do NOT ask for
  permission to push** — the user has said repeatedly "frag nicht, push direkt".
- **Iterate autonomously** across features / UI-UX / security / privacy. Don't
  stop to ask for prioritization; pick sensibly and keep going. Don't write
  long recaps unless asked.
- **Security & privacy are priority #1.** When adding features, preserve the
  E2EE/zero-knowledge-server model.
- **Deployment is manual via Render** (the user clicks "Manual Deploy"). Render
  is effectively the CI for web. End commit messages with:
  `Co-Authored-By: Claude <noreply@anthropic.com>`.
- **On the user's local Windows machine: do NOT run `npm`/builds** (their rule —
  builds go through CI/Render). In a **cloud/sandbox** session you *may* run
  `npm`/`tsc`/tests to verify, since that's isolated.

## Stack & critical build facts

- **client/** — React 19 + Vite 6 + TypeScript 5.7 + Tailwind 4. Crypto:
  `@matrix-org/olm` (Olm/Megolm WASM), `libsodium-wrappers-sumo` (Argon2id),
  `@noble/post-quantum` (ML-KEM). i18n is a custom dependency-free module.
  - ⚠️ **The client builds with Vite/esbuild and is NOT type-checked on deploy.**
    A wrong identifier / missing import fails at **runtime** (white screen), not
    build time. So: after edits, grep for all references when renaming, keep
    brace/JSX balance, and never assume `tsc` will catch client errors.
  - `vite.config.ts` copies `olm.wasm` to dist and aliases the libsodium-sumo
    CJS path. `vite-plugin-sri.ts` adds SRI hashes (skippable via
    `VITE_DISABLE_SRI=1`, off for the desktop build).
- **server/** — Express 4 + `ws`. Built with **`tsc`** (type errors DO fail the
  build). RAM-only relay: stores ciphertext mailbox, prekey bundles, group
  routing — never plaintext. CORS allowlist via `VAULTCHAT_CORS_ORIGIN`
  (+ Tauri origins hardcoded).
- **client/src-tauri/** — Tauri v2 desktop shell. Backend URL via build-time
  `VITE_API_BASE` / `VITE_WS_URL` (both `apiBase()`/`getWsUrl()` read them).
  CI: `.github/workflows/desktop-windows.yml` builds the Windows installer.

## Architecture (how A talks to B)

Text/files/groups: A ↔ **relay server (WebSocket)** ↔ B — server forwards only
ciphertext + offline mailbox. Calls/voice/screenshare: **P2P WebRTC**, only
signaling via the relay. Crypto: Olm (1:1) + Megolm (groups), sealed sender,
TOFU key pinning + verifiable safety numbers, Argon2id for at-rest/backup.

## Key files

- `client/src/components/ChatShell.tsx` — the ~6k-line core (DM+group chat,
  composer, calls, menus). Most features live here.
- `client/src/lib/i18n.ts` — central i18n dictionary, **10 locales** incl.
  Turkish (`en de tr es fr pt ru ar zh hi`), Arabic is RTL. `t(key, vars?)`
  with `{name}` interpolation. **Every visible string goes through `t()`.**
- `client/src/components/MessageBubble.tsx`, `lib/inlineMarkdown.tsx`
  (markdown: bold/italic/strike/code/`||spoiler||`/```fenced```/@mention/links).
- `client/src/lib/desktopNotify.ts`, `desktopChrome.ts`, `screenSecurity.ts`,
  `installPrompt.ts`, `components/TitleBar.tsx` — desktop/PWA integration
  (feature-detected via `isTauri()`, no-op in the browser).
- `server/src/index.ts` — API + WS + CORS + rate limits.

## Current state (keep this updated)

- ✅ Full product: DMs, groups, voice + group calls, screenshare, threads,
  reactions, custom emojis, polls, folders, view-once, disappearing messages,
  encrypted backups, read receipts, pinned/starred, mentions, unread divider,
  message requests (gate unknown senders + blurred avatars), block list,
  chat archive (WhatsApp-style), per-chat drafts (encrypted-at-rest, survive
  reload, "Draft:" preview in list), 3-level notification privacy
  (name+message / name only / nothing — Signal-style).
- ✅ **Fully localized** (10 languages) — verified: every used `t()` key exists.
- ✅ PWA installable (manifest, icons, themed address bar, install prompt).
- ✅ Tauri desktop app: tray, close-to-tray, single-instance, persisted window
  state, native notifications, frameless **custom title bar**, unread in title,
  taskbar flash, **Screen Security** (Signal-style capture blocking).
- ⏳ Desktop Rust build is **only validated via CI** (no local compile here).

## Roadmap / open items

- Security shipped since May: `#15` OTK-exhaustion mitigation, `#25` E2EE
  group names/descriptions/avatars, `#26` sealed-sender for groups (opt-in
  toggle in settings), sender-key rotation on every membership change,
  mailbox per-user byte quota (OOM-DoS guard), login timing-leak fix
  (dummy Argon2 verify against username enumeration), `#22` versioned KDF
  params in identity wrap + backup (clamped, backwards-compatible),
  JWT **sliding sessions** (`POST /api/token/refresh`, s0-claim caps absolute
  age at 30d; client refreshes when token >6h old), safety-number-change
  system notice in DMs (Signal pattern), WS pre-auth frame cap. Still open:
  group **member list** is plaintext on the server (metadata gap —
  zkgroup-style fix speced in `ZKGROUP_SPEC.md`, hard review gate). Token
  **revocation** now exists: per-user `tokenEpoch` baked into JWTs (`te`
  claim), `POST /api/account/logout-all` bumps it + drops live WS;
  "Sign out of all devices" in Settings → Security. See
  `SECURITY_ROADMAP.md`, `THREAT_MODEL.md`.
- UX next (from June 2026 review): swipe actions / long-press context menu on
  chat rows (mobile), warm-dark pass over remaining legacy CSS blocks,
  unarchive-on-new-message option, contact QR.
- Desktop: deep links for invite URLs, close-to-tray toggle, signed
  auto-updates (needs a signing keypair from the user).

## More docs

`DESKTOP.md` (Tauri build/architecture), `THREAT_MODEL.md`, `SECURITY_ROADMAP.md`,
`PRODUCT_STRATEGY.md`, `PRODUCT_READINESS.md`, `DEPLOY.md`, `CRYPTO_CORE.md`.
