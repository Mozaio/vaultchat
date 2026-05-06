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
import { useAutoLock } from "./lib/useAutoLock";
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

/** Automatische Sperre nach N Millisekunden Inaktivität. */
const AUTO_LOCK_MS = 10 * 60 * 1000;

export function App() {
  const [sodiumOk, setSodiumOk] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [codeCheck, setCodeCheck] = useState<CodeCheck | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

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

  useAutoLock(unlocked, AUTO_LOCK_MS, lock);

  // Surface unexpected runtime errors instead of a blank screen.
  useEffect(() => {
    const onRejection = (ev: PromiseRejectionEvent) => {
      const r = ev.reason;
      const msg =
        r instanceof Error ? `${r.name}: ${r.message}\n${r.stack ?? ""}` : String(r);
      setRuntimeError(msg);
    };
    const onError = (ev: ErrorEvent) => {
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
    if (codeCheck?.state === "pinned_mismatch") {
      return (
        <div className="flex min-h-full flex-col">
          {banner}
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="app-surface max-w-xl rounded-2xl p-5">
              <p className="text-sm font-semibold text-red-200">
                Entsperren blockiert: Der ausgelieferte App-Code stimmt nicht
                mit dem gepinnten Hash überein.
              </p>
              <p className="mt-2 text-sm app-muted">
                Vergleiche den aktuellen Hash mit einer unabhängigen Quelle.
                Pinne nur neu, wenn du diesem Build bewusst vertraust.
              </p>
            </div>
          </div>
        </div>
      );
    }
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

                // Neue Sicherheits-Features initialisieren
                await setVerificationKey(s.secretKey);
                const postUnlockCheck = await checkCodeIntegrityEnhanced();
                if (postUnlockCheck.state === "pinned_mismatch") {
                  clearVerificationKey();
                  throw new Error("code_integrity_mismatch");
                }
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
      <p className="font-semibold">
        Build-Integritaet stimmt nicht mit dem verifizierten Wert ueberein.
      </p>
      <p className="font-mono">Aktuell: {check.hash}</p>
      <p className="font-mono">Gepinnt: {check.pinned}</p>
      <div className="mt-1 flex gap-2">
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
      </div>
    </div>
  );
}
