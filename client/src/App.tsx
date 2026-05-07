import React, { useCallback, useEffect, useMemo, useState } from "react";
import { sodiumReady, getSodium } from "./lib/sodium";
import {
  clearLocalIdentity,
  clearToken,
  saveLocalIdentity,
  saveToken,
} from "./lib/localIdentity";
import { clearLocalKey, setLocalKeyFromSecret } from "./lib/localKey";
import type { Session } from "./lib/sessionHelpers";
import { AuthPanel } from "./components/AuthPanel";
import { ChatShell } from "./components/ChatShell";
import { idbPurgeExpired, setIdbAccountScope } from "./lib/idb";
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

export type { Session };

export function App() {
  const [sodiumOk, setSodiumOk] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [codeCheck, setCodeCheck] = useState<CodeCheck | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
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
    setSession(null);
  }, [session]);

  useAutoLock(unlocked, autoLockMinutes * 60 * 1000, lock);

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
      setRuntimeError(msg);
    };
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
    };
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
      <div className="flex min-h-full items-center justify-center p-6">
        <p className="text-zinc-400">Kryptografie wird geladen…</p>
      </div>
    );
  }

  const banner = codeCheck ? (
    <CodeIntegrityBanner check={codeCheck} onPinned={refreshCodeIntegrity} />
  ) : null;

  if (!unlocked) {
    return (
      <div className="flex min-h-full flex-col">
        {banner}
        <AppErrorBoundary
          onReset={() => {
            setRuntimeError(null);
            clearToken();
            clearLocalIdentity();
            lock();
          }}
        >
          <div className="flex flex-1 items-center justify-center">
            <AuthPanel
              onSession={async (s, local) => {
                saveToken(s.token);
                saveLocalIdentity(local);
                await setLocalKeyFromSecret(s.secretKey);
                setIdbAccountScope(s.user.id);

                // Verification-Key setzen, aber bei pinned_mismatch nur warnen
                // (der rote Integrity-Banner bleibt sichtbar als Warnung)
                await setVerificationKey(s.secretKey);
                registerKeyForProtection(s.secretKey);
                startPeriodicWipe();

                await idbPurgeExpired().catch(() => {});
                setSession(s);
              }}
            />
          </div>
        </AppErrorBoundary>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      {banner}
      {runtimeError && (
        <div className="border-b border-red-900/50 bg-red-950/40 px-4 py-2 text-xs text-red-200">
          <div className="flex items-center justify-between gap-3">
            <p className="font-semibold">Runtime-Fehler (statt Black Screen)</p>
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
              Reset
            </button>
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
          <ChatShell
            session={session!}
            onLogout={() => {
              clearToken();
              clearLocalIdentity();
              lock();
            }}
            onLock={lock}
          />
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
            UI ist abgestürzt (ErrorBoundary)
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
            Reset
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
        <span className="font-semibold">Build verifiziert</span>
        <span className="font-mono">SHA-384 {check.hash.slice(0, 12)}...</span>
        <button
          type="button"
          className="code-integrity-action"
          onClick={() => setDismissed(true)}
        >
          Ausblenden
        </button>
      </div>
    );
  }
  if (check.state === "unknown") {
    return (
      <div className="code-integrity-banner warn">
        <span className="code-integrity-copy">
          <strong>Build noch nicht verifiziert</strong>
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
          Verifizieren
        </button>
      </div>
    );
  }
  return (
    <div className="code-integrity-banner danger">
      <span className="code-integrity-copy">
        <strong>Build-Integrität geändert</strong>
        <span
          className="font-mono"
          title={`Aktuell: ${check.hash}\nGepinnt: ${check.pinned}`}
        >
          aktuell {check.hash.slice(0, 12)}… · gepinnt {check.pinned.slice(0, 12)}…
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
        Neu verifizieren
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="code-integrity-action code-integrity-dismiss"
        aria-label="Banner ausblenden"
        title="Ausblenden"
      >
        ×
      </button>
    </div>
  );
}
