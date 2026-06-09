import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { sodiumReady, getSodium } from "./lib/sodium";
import {
  clearLocalIdentity,
  clearToken,
  saveLocalIdentity,
  saveToken,
} from "./lib/localIdentity";
import { clearLocalKey, setLocalKeyFromSecret } from "./lib/localKey";
import type { Session } from "./lib/sessionHelpers";
// Route-level Code-Splitting: AuthPanel + ChatShell wandern in eigene Chunks,
// damit der Initial-Bundle für Splash + Sodium-Boot klein bleibt.
const AuthPanel = lazy(() =>
  import("./components/AuthPanel").then((m) => ({ default: m.AuthPanel }))
);
const ChatShell = lazy(() =>
  import("./components/ChatShell").then((m) => ({ default: m.ChatShell }))
);

function ChunkFallback({ label }: { label: string }) {
  // chunk-fallback ist ein Flex-Kind — füllt seinen Parent (flex flex-1)
  // komplett aus statt am linken Rand zu kleben. boot-loader (für den
  // initial Sodium-Splash auf Top-Level) hat min-height:100vh statt flex:1
  // und ist dafür ungeeignet.
  return (
    <div className="chunk-fallback" role="status" aria-live="polite">
      <div className="boot-loader-spinner" aria-hidden />
      <p>{label}</p>
    </div>
  );
}

/**
 * Error-Boundary für die Suspense-Chunks. Wenn der dynamic import scheitert
 * (Network-Drop während Cold-Start, oder eine gepushte Datei fehlt im
 * Render-Bundle), würde React ohne dies in einen ewigen Suspense-Loop
 * gehen. Diese Boundary fängt es ab und bietet einen "Erneut versuchen"-
 * Knopf, der die Seite reloadet (Chunk-Cache wird invalidiert).
 */
class ChunkErrorBoundary extends React.Component<
  { children: React.ReactNode; label: string },
  { err: Error | null }
> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  componentDidCatch(err: Error) {
    // eslint-disable-next-line no-console
    console.error("[vaultchat] chunk load failed", err);
  }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="chunk-fallback" role="alert">
        <p style={{ color: "var(--danger, #dc2626)", fontWeight: 600 }}>
          {t("app.chunkFailed", { label: this.props.label })}
        </p>
        <p style={{ fontSize: "0.78rem", textAlign: "center", maxWidth: "32rem" }}>
          {t("app.chunkHint")}
        </p>
        <button
          type="button"
          onClick={() => location.reload()}
          className="auth-button"
          style={{ maxWidth: "12rem", marginTop: "0.5rem" }}
        >
          {t("app.reload")}
        </button>
      </div>
    );
  }
}
import { idbPurgeExpired, idbWipeMessageData, setIdbAccountScope } from "./lib/idb";
import {
  loadAutoLockMinutes,
  subscribeAutoLockMinutes,
  useAutoLock,
} from "./lib/useAutoLock";
import {
  checkCodeIntegrity,
  pinCodeHash,
  type CodeCheck,
} from "./lib/codeIntegrity";
// Neue Sicherheitsmodule
import {
  startPeriodicWipe,
  stopPeriodicWipe,
  registerKeyForProtection,
  unregisterKeyForProtection,
} from "./lib/exfilProtection";
import {
  checkCodeIntegrityEnhanced,
  setVerificationKey,
  securePinCodeHash,
  clearVerificationKey,
} from "./lib/codeIntegrityEnhanced";
import { resetAllReplayProtection } from "./lib/replayProtection";
import { shutdownCryptoWorker } from "./lib/cryptoWorkerClient";
import { clearSearchIndex } from "./lib/searchIndex";
import { clearOlmPickleCache } from "./lib/olmSessionStore";
import { clearMegolmPickleCache } from "./lib/megolmSessionStore";
import { t, useLocale } from "./lib/i18n";

export type { Session };

/**
 * Entfernt den pro-Account-spezifischen Social-Graph + Chat-State aus
 * localStorage. Wird beim Wechsel auf einen ANDEREN Account aufgerufen,
 * damit der neue Account keine fremden Kontakte/Blockierungen/Favoriten/
 * Ordner/Ungelesen-Marker erbt. Geräte-/UI-Präferenzen (Theme, Akzent,
 * Dichte, Sprache, Sicherheits-Level, Benachrichtigungen, Auto-Lock,
 * Code-Hash-Pin) bleiben bewusst erhalten.
 */
function clearAccountScopedLocalState(): void {
  const keys = [
    "vaultchat.accepted.peers",
    "vaultchat.requests.peers",
    "vaultchat.requests.migrated",
    "vaultchat.blocked.peers",
    "vaultchat.blocked.names",
    "vaultchat.favorites.peers",
    "vaultchat.pinned.peers",
    "vaultchat.pinned.messages",
    "vaultchat.muted.peers",
    "vaultchat.muted.groups",
    "vaultchat.starred.cids",
    "vaultchat.folders",
    "vaultchat.threads.lastSeen.v1",
    "vaultchat.plan.v1",
    "vaultchat.onboarding.pending",
    "vaultchat.backupReminder.dismissed",
  ];
  for (const k of keys) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
}

export function App() {
  useLocale();
  const [sodiumOk, setSodiumOk] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [codeCheck, setCodeCheck] = useState<CodeCheck | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  // Render-Free schläft nach 15 min Inaktivität ein. Erste API-Anfrage
  // dauert 20-30s. Wir zeigen einen Hinweis-Banner sobald api.ts ein
  // cold-start-Event feuert (>4s ein einzelner Call).
  const [coldStart, setColdStart] = useState(false);
  // Service Worker hat einen neuen Build übernommen — User sollte reloaden.
  const [swUpdateReady, setSwUpdateReady] = useState(false);
  useEffect(() => {
    const onStart = () => setColdStart(true);
    const onDone = () => setColdStart(false);
    const onSwUpdate = () => setSwUpdateReady(true);
    window.addEventListener("vaultchat:cold-start", onStart);
    window.addEventListener("vaultchat:cold-start-done", onDone);
    window.addEventListener("vaultchat:sw-update", onSwUpdate);
    return () => {
      window.removeEventListener("vaultchat:cold-start", onStart);
      window.removeEventListener("vaultchat:cold-start-done", onDone);
      window.removeEventListener("vaultchat:sw-update", onSwUpdate);
    };
  }, []);
  // Auto-lock interval, in minutes. 0 disables auto-lock entirely.
  const [autoLockMinutes, setAutoLockMinutes] = useState<number>(() =>
    loadAutoLockMinutes()
  );

  useEffect(() => subscribeAutoLockMinutes(setAutoLockMinutes), []);

  useEffect(() => {
    sodiumReady()
      .then(() => setSodiumOk(true))
      .catch((e: unknown) =>
        setBootError(e instanceof Error ? e.message : "crypto_init_failed")
      );
  }, []);

  const unlocked = useMemo(() => session !== null, [session]);
  const refreshCodeIntegrity = useCallback(async () => {
    try {
      const enhancedCheck = await checkCodeIntegrityEnhanced();
      switch (enhancedCheck.state) {
        case "pinned_ok":
          setCodeCheck({ state: "pinned_ok", hash: enhancedCheck.hash });
          return;
        case "pinned_mismatch":
          setCodeCheck({
            state: "pinned_mismatch",
            hash: enhancedCheck.hash,
            pinned: enhancedCheck.pinned,
          });
          return;
        case "verification_key_missing":
        case "unknown":
          setCodeCheck({ state: "unknown", hash: enhancedCheck.hash });
          return;
      }
    } catch {
      await checkCodeIntegrity().then(setCodeCheck);
    }
  }, []);

  useEffect(() => {
    void refreshCodeIntegrity();
  }, [refreshCodeIntegrity]);

  const lock = useCallback(() => {
    if (session) {
      try {
        getSodium().memzero(session.secretKey);
      } catch {
        /* ignore */
      }
    }
    clearLocalKey();
    setIdbAccountScope(null);
    unregisterKeyForProtection();
    stopPeriodicWipe();
    resetAllReplayProtection();
    clearVerificationKey();
    shutdownCryptoWorker();
    clearSearchIndex();
    // Olm/Megolm pickle-Keys werden aus dem Local-Key abgeleitet — bei Lock
    // ist der Local-Key weg, also dürfen wir auch die Cache-Kopien davon
    // nicht weiter halten.
    clearOlmPickleCache();
    clearMegolmPickleCache();
    setSession(null);
  }, [session]);

  useAutoLock(unlocked, autoLockMinutes * 60 * 1000, lock);

  // Sliding-Session: Token läuft nach 12 h hart ab — vorher gegen ein
  // frisches tauschen, sonst stirbt jede längere Session mit Re-Login.
  // Details:
  // - Token lebt im Ref, damit der Effekt NICHT auf session.token hängt
  //   (sonst: Refresh → neues Token → Effekt-Neustart → Endlosschleife).
  // - Refresh nur wenn das Token älter als 6 h ist: das neue session-Objekt
  //   triggert den WS-Effekt in ChatShell (kurzer Reconnect) — das soll
  //   selten passieren, nicht bei jedem Entsperren.
  const sessionTokenRef = useRef<string | null>(null);
  useEffect(() => {
    sessionTokenRef.current = session?.token ?? null;
  }, [session]);
  useEffect(() => {
    if (!unlocked) return;
    let disposed = false;
    const tokenIssuedAtSec = (tok: string): number | null => {
      try {
        const part = tok.split(".")[1] ?? "";
        const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
        const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
        const payload = JSON.parse(atob(padded)) as { iat?: number };
        return typeof payload.iat === "number" ? payload.iat : null;
      } catch {
        return null;
      }
    };
    const REFRESH_AFTER_SEC = 6 * 60 * 60;
    const refresh = async () => {
      const tok = sessionTokenRef.current;
      if (!tok) return;
      const iat = tokenIssuedAtSec(tok);
      if (iat !== null && Date.now() / 1000 - iat < REFRESH_AFTER_SEC) return;
      try {
        const api = await import("./lib/api");
        const { token } = await api.refreshToken(tok);
        if (disposed || !token) return;
        saveToken(token);
        setSession((s) => (s ? { ...s, token } : s));
      } catch {
        // Offline, Server schläft oder session_expired — die bestehenden
        // 401-Pfade greifen beim nächsten API-Call; hier nichts erzwingen.
      }
    };
    void refresh();
    const id = window.setInterval(refresh, 30 * 60 * 1000);
    return () => {
      disposed = true;
      window.clearInterval(id);
    };
  }, [unlocked]);

  // Surface unexpected runtime errors instead of a blank screen.
  useEffect(() => {
    // Transient errors that occur during lock/unlock races — surfacing them
    // confuses users (the next async tick fixes them on its own).
    const TRANSIENT = new Set([
      "local_key_missing",
      "session_missing",
    ]);
    const isTransient = (msg: string) =>
      Array.from(TRANSIENT).some((m) => msg.includes(m));

    // IDB-Versionsfehler entstehen, wenn ein älterer Build mit niedriger
    // VER-Konstante eine bereits höher migrierte DB öffnen will (z.B. nach
    // Render-Rollback oder bei stale Service-Worker-Cache). Auf die
    // Reset-Banner wird dann zusätzlich der "DB neu erstellen"-Fix gespielt.
    const isVersionMismatch = (msg: string) =>
      msg.includes("VersionError") ||
      msg.includes("less than the existing version");

    const onRejection = (ev: PromiseRejectionEvent) => {
      const r = ev.reason;
      const text =
        r instanceof Error ? r.message : typeof r === "string" ? r : String(r);
      if (isTransient(text)) {
        // eslint-disable-next-line no-console
        console.warn("[vaultchat] transient error suppressed:", text);
        ev.preventDefault();
        return;
      }
      const msg =
        r instanceof Error ? `${r.name}: ${r.message}\n${r.stack ?? ""}` : String(r);
      if (isVersionMismatch(text)) {
        setRuntimeError(
          "IDB_VERSION_MISMATCH\n" + msg + t("app.idbMismatchFix")
        );
        return;
      }
      setRuntimeError(msg);
    };
    const onError = (ev: ErrorEvent) => {
      if (isTransient(ev.message ?? "")) {
        return;
      }
      const err = ev.error as unknown;
      const msg =
        err instanceof Error
          ? `${err.name}: ${err.message}\n${err.stack ?? ""}`
          : `${ev.message}\n${ev.filename}:${ev.lineno}:${ev.colno}`;
      if (isVersionMismatch(ev.message ?? "")) {
        setRuntimeError(
          "IDB_VERSION_MISMATCH\n" + msg + t("app.idbMismatchFix")
        );
        return;
      }
      setRuntimeError(msg);
    };
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
    };
  }, []);

  /** Löscht die "vaultchat"-IDB komplett und reloadet die Seite. */
  const resetIdb = useCallback(async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase("vaultchat");
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () => resolve(); // best-effort, Reload kommt sowieso
      });
    } catch {
      /* fallthrough */
    }
    location.reload();
  }, []);

  if (bootError) {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <p className="text-red-400">{bootError}</p>
      </div>
    );
  }

  if (!sodiumOk) {
    return (
      <div className="boot-loader">
        <div className="boot-loader-spinner" aria-hidden />
        <p>{t("app.loadingCrypto")}</p>
      </div>
    );
  }

  const banner = codeCheck ? (
    <CodeIntegrityBanner check={codeCheck} onPinned={refreshCodeIntegrity} />
  ) : null;

  const coldStartBanner = coldStart ? (
    <div
      className="cold-start-banner"
      role="status"
      aria-live="polite"
    >
      <span className="cold-start-spinner" aria-hidden />
      <span>{t("app.coldStart")}</span>
    </div>
  ) : null;

  const swUpdateBanner = swUpdateReady ? (
    <div
      className="cold-start-banner"
      role="status"
      aria-live="polite"
      style={{
        background: "var(--accent-soft)",
        borderBottomColor: "var(--accent-glow)",
        color: "var(--accent)",
      }}
    >
      <span>{t("app.updateReady")}</span>
      <button
        type="button"
        onClick={() => location.reload()}
        style={{
          marginLeft: "auto",
          padding: "0.15rem 0.6rem",
          borderRadius: "4px",
          border: "1px solid currentColor",
          background: "transparent",
          color: "inherit",
          fontSize: "0.75rem",
          cursor: "pointer",
        }}
      >
        {t("app.reloadNow")}
      </button>
    </div>
  ) : null;

  if (!unlocked) {
    return (
      <div className="flex min-h-full flex-col">
        {banner}
        {swUpdateBanner}
        {coldStartBanner}
        {runtimeError && (
          <div className="border-b border-red-900/50 bg-red-950/40 px-4 py-2 text-xs text-red-200">
            <div className="flex items-center justify-between gap-3">
              <p className="font-semibold">{t("app.runtimeError")}</p>
              <div className="flex items-center gap-2">
                {runtimeError.startsWith("IDB_VERSION_MISMATCH") && (
                  <button
                    type="button"
                    className="rounded border border-amber-700 bg-amber-900/30 px-2 py-0.5 hover:bg-amber-800/40"
                    onClick={() => void resetIdb()}
                  >
                    {t("app.resetDb")}
                  </button>
                )}
                <button
                  type="button"
                  className="rounded border border-red-800 px-2 py-0.5 hover:bg-red-900/30"
                  onClick={() => {
                    setRuntimeError(null);
                    clearToken();
                    clearLocalIdentity();
                    lock();
                  }}
                >
                  {t("app.reset")}
                </button>
              </div>
            </div>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-red-100/90">
              {runtimeError}
            </pre>
          </div>
        )}
        <AppErrorBoundary
          onReset={() => {
            setRuntimeError(null);
            clearToken();
            clearLocalIdentity();
            lock();
          }}
        >
          <div className="flex flex-1 items-center justify-center">
            <ChunkErrorBoundary label={t("app.login")}>
            <Suspense fallback={<ChunkFallback label={t("app.loadingNamed", { label: t("app.login") })} />}>
              <AuthPanel
                onSession={async (s, local) => {
                  saveToken(s.token);
                  saveLocalIdentity(local);
                  await setLocalKeyFromSecret(s.secretKey);
                  setIdbAccountScope(s.user.id);

                  // Account-Wechsel auf demselben Browser: dm/groupMsg/outbox
                  // liegen global (nicht pro Account) in IndexedDB, und der
                  // Social-Graph (accepted/blocked/favorites/… peers) steckt
                  // global in localStorage. Loggt sich ein ANDERER Account
                  // ein, würde er sonst fremde Kontakte + Ungelesen-Badges +
                  // Metadaten (peerId/Zeitstempel) erben. Beim erkannten
                  // Wechsel daher wipen. Fehlt der Marker (Erst-Adoption),
                  // NICHT wipen — bestehende Single-Account-Daten bleiben.
                  try {
                    const prevOwner = localStorage.getItem("vaultchat.dataOwner");
                    if (prevOwner && prevOwner !== s.user.id) {
                      await idbWipeMessageData().catch(() => {});
                      clearAccountScopedLocalState();
                    }
                    localStorage.setItem("vaultchat.dataOwner", s.user.id);
                  } catch {
                    /* localStorage nicht verfügbar — überspringen */
                  }

                  // Verification-Key setzen, aber bei pinned_mismatch nur warnen
                  // (der rote Integrity-Banner bleibt sichtbar als Warnung)
                  await setVerificationKey(s.secretKey);
                  registerKeyForProtection(s.secretKey);
                  startPeriodicWipe();

                  await idbPurgeExpired().catch(() => {});
                  setSession(s);
                }}
              />
            </Suspense>
            </ChunkErrorBoundary>
          </div>
        </AppErrorBoundary>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      {banner}
      {swUpdateBanner}
      {coldStartBanner}
      {runtimeError && (
        <div className="border-b border-red-900/50 bg-red-950/40 px-4 py-2 text-xs text-red-200">
          <div className="flex items-center justify-between gap-3">
            <p className="font-semibold">{t("app.runtimeError")}</p>
            <div className="flex items-center gap-2">
              {runtimeError.startsWith("IDB_VERSION_MISMATCH") && (
                <button
                  type="button"
                  className="rounded border border-amber-700 bg-amber-900/30 px-2 py-0.5 hover:bg-amber-800/40"
                  onClick={() => void resetIdb()}
                >
                  {t("app.resetDb")}
                </button>
              )}
              <button
                type="button"
                className="rounded border border-red-800 px-2 py-0.5 hover:bg-red-900/30"
                onClick={() => {
                  setRuntimeError(null);
                  clearToken();
                  clearLocalIdentity();
                  lock();
                }}
              >
                {t("app.reset")}
              </button>
            </div>
          </div>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-red-100/90">
            {runtimeError}
          </pre>
        </div>
      )}
      <AppErrorBoundary
        onReset={() => {
          setRuntimeError(null);
          clearToken();
          clearLocalIdentity();
          lock();
        }}
      >
        <div className="flex flex-1 min-h-0">
          <ChunkErrorBoundary label={t("app.chat")}>
            <Suspense fallback={<ChunkFallback label={t("app.loadingNamed", { label: t("app.chat") })} />}>
              <ChatShell
                session={session!}
                onLogout={() => {
                  clearToken();
                  clearLocalIdentity();
                  lock();
                }}
                onLock={lock}
              />
            </Suspense>
          </ChunkErrorBoundary>
        </div>
      </AppErrorBoundary>
    </div>
  );
}

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode; onReset: () => void },
  { err: Error | null }
> {
  state = { err: null as Error | null };

  static getDerivedStateFromError(err: Error) {
    return { err };
  }

  componentDidCatch(err: Error) {
    // eslint-disable-next-line no-console
    console.error("[vaultchat] UI crashed", err);
  }

  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="app-surface max-w-2xl rounded-2xl p-5">
          <p className="text-sm font-semibold text-white">
            {t("app.crashed")}
          </p>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[11px] app-muted">
            {this.state.err.name}: {this.state.err.message}
            {"\n"}
            {this.state.err.stack ?? ""}
          </pre>
          <button
            type="button"
            className="mt-4 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
            onClick={() => {
              this.setState({ err: null });
              this.props.onReset();
            }}
          >
            {t("app.reset")}
          </button>
        </div>
      </div>
    );
  }
}

function CodeIntegrityBanner({
  check,
  onPinned,
}: {
  check: CodeCheck;
  onPinned: () => void | Promise<void>;
}) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  if (check.state === "pinned_ok") {
    return (
      <div className="code-integrity-banner ok">
        <span className="font-semibold">{t("app.buildVerified")}</span>
        <span className="font-mono">SHA-384 {check.hash.slice(0, 12)}...</span>
        <button
          type="button"
          className="code-integrity-action"
          onClick={() => setDismissed(true)}
        >
          {t("app.hide")}
        </button>
      </div>
    );
  }
  if (check.state === "unknown") {
    return (
      <div className="code-integrity-banner warn">
        <span className="code-integrity-copy">
          <strong>{t("app.buildUnverified")}</strong>
          <span className="font-mono" title={`SHA-384 ${check.hash}`}>
            SHA-384 {check.hash.slice(0, 16)}...
          </span>
        </span>
        <button
          type="button"
          onClick={async () => {
            try {
              await securePinCodeHash(check.hash);
            } catch {
              pinCodeHash(check.hash);
            }
            await onPinned();
            setDismissed(true);
          }}
          className="code-integrity-action"
        >
          {t("app.verify")}
        </button>
      </div>
    );
  }
  return (
    <div className="code-integrity-banner danger">
      <span className="code-integrity-copy">
        <strong>{t("app.buildChanged")}</strong>
        <span
          className="font-mono"
          title={`Aktuell: ${check.hash}\nGepinnt: ${check.pinned}`}
        >
          {t("app.currentPinned", {
            cur: check.hash.slice(0, 12),
            pin: check.pinned.slice(0, 12),
          })}
        </span>
      </span>
      <button
        type="button"
        onClick={async () => {
          try {
            await securePinCodeHash(check.hash);
          } catch {
            pinCodeHash(check.hash);
          }
          await onPinned();
          setDismissed(true);
        }}
        className="code-integrity-action"
      >
        {t("app.reVerify")}
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="code-integrity-action code-integrity-dismiss"
        aria-label={t("app.hide")}
        title={t("app.hide")}
      >
        ×
      </button>
    </div>
  );
}
