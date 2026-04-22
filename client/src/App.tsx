import { useCallback, useEffect, useMemo, useState } from "react";
import { sodiumReady } from "./lib/sodium";
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
import { idbPurgeExpired } from "./lib/idb";
import { useAutoLock } from "./lib/useAutoLock";
import {
  checkCodeIntegrity,
  pinCodeHash,
  type CodeCheck,
} from "./lib/codeIntegrity";
import { getSodium } from "./lib/sodium";

export type { Session };

/** Automatische Sperre nach N Millisekunden Inaktivität. */
const AUTO_LOCK_MS = 10 * 60 * 1000;

export function App() {
  const [sodiumOk, setSodiumOk] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [codeCheck, setCodeCheck] = useState<CodeCheck | null>(null);

  useEffect(() => {
    sodiumReady()
      .then(() => setSodiumOk(true))
      .catch((e: unknown) =>
        setBootError(e instanceof Error ? e.message : "crypto_init_failed")
      );
  }, []);

  useEffect(() => {
    void checkCodeIntegrity()
      .then(setCodeCheck)
      .catch(() => setCodeCheck(null));
  }, []);

  const unlocked = useMemo(() => session !== null, [session]);

  const lock = useCallback(() => {
    if (session) {
      try {
        getSodium().memzero(session.secretKey);
      } catch {
        /* ignore */
      }
    }
    clearLocalKey();
    setSession(null);
  }, [session]);

  useAutoLock(unlocked, AUTO_LOCK_MS, lock);

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
    <CodeIntegrityBanner check={codeCheck} />
  ) : null;

  if (!unlocked) {
    return (
      <div className="flex min-h-full flex-col">
        {banner}
        <div className="flex flex-1 items-center justify-center">
          <AuthPanel
            onSession={async (s, local) => {
              saveToken(s.token);
              saveLocalIdentity(local);
              await setLocalKeyFromSecret(s.secretKey);
              await idbPurgeExpired().catch(() => {});
              setSession(s);
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      {banner}
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
    </div>
  );
}

function CodeIntegrityBanner({ check }: { check: CodeCheck }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  if (check.state === "pinned_ok") {
    return (
      <div className="border-b border-emerald-900/40 bg-emerald-950/30 px-4 py-1 text-[11px] text-emerald-300">
        Code-Hash gepinnt · SHA-384 {check.hash.slice(0, 16)}…
        <button
          type="button"
          className="ml-2 underline hover:text-emerald-200"
          onClick={() => setDismissed(true)}
        >
          ausblenden
        </button>
      </div>
    );
  }
  if (check.state === "unknown") {
    return (
      <div className="border-b border-amber-900/50 bg-amber-950/40 px-4 py-2 text-xs text-amber-200">
        <span>
          Dieser Code-Hash wurde noch nicht gepinnt. SHA-384:{" "}
          <span className="font-mono">{check.hash}</span>
        </span>
        <button
          type="button"
          onClick={() => {
            pinCodeHash(check.hash);
            setDismissed(true);
          }}
          className="ml-3 rounded border border-emerald-600 px-2 py-0.5 text-emerald-300 hover:bg-emerald-900/30"
        >
          Jetzt pinnen
        </button>
      </div>
    );
  }
  return (
    <div className="border-b border-red-900/60 bg-red-950/50 px-4 py-2 text-xs text-red-200">
      <p className="font-semibold">
        ⚠ Code-Hash weicht vom gepinnten Wert ab. Neues Bundle könnte bösartig
        sein.
      </p>
      <p className="font-mono">Aktuell: {check.hash}</p>
      <p className="font-mono">Gepinnt: {check.pinned}</p>
      <div className="mt-1 flex gap-2">
        <button
          type="button"
          onClick={() => {
            pinCodeHash(check.hash);
            setDismissed(true);
          }}
          className="rounded border border-amber-600 px-2 py-0.5 text-amber-200 hover:bg-amber-900/30"
        >
          Akzeptieren &amp; neu pinnen
        </button>
      </div>
    </div>
  );
}
