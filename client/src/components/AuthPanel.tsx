import { useMemo, useState } from "react";
import {
  buildSessionFromLogin,
  buildSessionFromRegister,
  fingerprintFor,
} from "../lib/sessionHelpers";
import {
  loadLocalIdentity,
  loadToken,
  saveLocalIdentity,
  type LocalIdentity,
} from "../lib/localIdentity";
import * as api from "../lib/api";
import type { Session } from "../lib/sessionHelpers";

type Mode = "unlock" | "login" | "register";

export function AuthPanel({
  onSession,
}: {
  onSession: (s: Session, local: LocalIdentity) => void | Promise<void>;
}) {
  const hasLocal = useMemo(
    () => Boolean(loadToken() && loadLocalIdentity()),
    []
  );
  const [mode, setMode] = useState<Mode>(hasLocal ? "unlock" : "login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [importJson, setImportJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fp, setFp] = useState<string | null>(null);

  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const token = loadToken();
      const local = loadLocalIdentity();
      if (!token || !local) throw new Error("session_missing");
      await api.me(token);
      const session = await buildSessionFromLogin(
        local.username,
        password,
        local
      );
      await onSession(session, local);
    } catch (err) {
      setError(err instanceof Error ? err.message : "unlock_failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      let local: LocalIdentity | null = null;
      if (importJson.trim()) {
        local = JSON.parse(importJson) as LocalIdentity;
        saveLocalIdentity(local);
      } else {
        local = loadLocalIdentity();
      }
      if (!local || local.username !== username) {
        throw new Error(
          "Für dieses Gerät fehlt ein Schlüssel-Backup oder der Benutzername passt nicht."
        );
      }
      const session = await buildSessionFromLogin(username, password, local);
      await onSession(session, local);
    } catch (err) {
      setError(err instanceof Error ? err.message : "login_failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { session, local } = await buildSessionFromRegister(
        username,
        password
      );
      await onSession(session, local);
    } catch (err) {
      setError(err instanceof Error ? err.message : "register_failed");
    } finally {
      setBusy(false);
    }
  }

  async function showFingerprint() {
    setError(null);
    try {
      const token = loadToken();
      const local = loadLocalIdentity();
      if (!token || !local) return;
      const user = await api.me(token);
      const f = await fingerprintFor(user);
      setFp(f);
    } catch {
      setFp(null);
      setError("Token ungültig — bitte über „Anderes Konto“ neu anmelden.");
    }
  }

  function exportBackup() {
    const local = loadLocalIdentity();
    if (!local) return;
    const blob = new Blob([JSON.stringify(local, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `vaultchat-backup-${local.username}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-zinc-950 px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/80 p-8 shadow-2xl shadow-emerald-950/20 backdrop-blur">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            VaultChat
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Ende-zu-Ende verschlüsselt. Der Server sieht keinen Klartext.
          </p>
        </div>

        {hasLocal && (
          <div className="mb-6 flex gap-2 rounded-lg bg-zinc-950 p-1">
            <button
              type="button"
              className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
                mode === "unlock"
                  ? "bg-emerald-600 text-white"
                  : "text-zinc-400 hover:text-white"
              }`}
              onClick={() => setMode("unlock")}
            >
              Entsperren
            </button>
            <button
              type="button"
              className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
                mode === "login"
                  ? "bg-emerald-600 text-white"
                  : "text-zinc-400 hover:text-white"
              }`}
              onClick={() => setMode("login")}
            >
              Anderes Konto
            </button>
          </div>
        )}

        {mode === "unlock" && hasLocal && (
          <form onSubmit={handleUnlock} className="space-y-4">
            <label className="block text-sm text-zinc-300">
              Passwort (lokale Schlüssel)
              <input
                type="password"
                autoComplete="current-password"
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white outline-none ring-emerald-500/30 focus:ring-2"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy ? "…" : "Entsperren"}
            </button>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={showFingerprint}
                className="w-full text-sm text-zinc-500 hover:text-zinc-300"
              >
                Meinen Schlüsselfingerprint anzeigen
              </button>
              <button
                type="button"
                onClick={exportBackup}
                className="w-full text-sm text-emerald-500/90 hover:text-emerald-400"
              >
                Backup (JSON) herunterladen
              </button>
            </div>
            {fp && (
              <p className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-center font-mono text-sm text-emerald-400">
                {fp}
              </p>
            )}
          </form>
        )}

        {mode === "login" && (
          <form onSubmit={handleLogin} className="space-y-4">
            <label className="block text-sm text-zinc-300">
              Benutzername
              <input
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white outline-none ring-emerald-500/30 focus:ring-2"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Passwort
              <input
                type="password"
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white outline-none ring-emerald-500/30 focus:ring-2"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Backup importieren (JSON, neues Gerät)
              <textarea
                className="mt-1 min-h-[80px] w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-200 outline-none ring-emerald-500/30 focus:ring-2"
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
                placeholder='{"userId":"…","username":"…","publicKey":"…","wrapped":{…}}'
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy ? "…" : "Anmelden"}
            </button>
          </form>
        )}

        {mode === "register" && (
          <form onSubmit={handleRegister} className="space-y-4">
            <label className="block text-sm text-zinc-300">
              Benutzername
              <input
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white outline-none ring-emerald-500/30 focus:ring-2"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Passwort (min. 10 Zeichen)
              <input
                type="password"
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white outline-none ring-emerald-500/30 focus:ring-2"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                minLength={10}
                required
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy ? "…" : "Konto erstellen"}
            </button>
          </form>
        )}

        {!hasLocal && (
          <div className="mt-6 flex gap-2 text-sm">
            <button
              type="button"
              className={`flex-1 rounded-lg py-2 ${
                mode === "login"
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
              onClick={() => setMode("login")}
            >
              Anmelden
            </button>
            <button
              type="button"
              className={`flex-1 rounded-lg py-2 ${
                mode === "register"
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
              onClick={() => setMode("register")}
            >
              Registrieren
            </button>
          </div>
        )}

        {error && (
          <p className="mt-4 rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}

        <p className="mt-8 text-center text-xs leading-relaxed text-zinc-600">
          Browser + fremder Server: ohne Subresource-Integrity und Audit ist
          das Bedrohungsmodell schwächer als bei nativen Apps. Details siehe{" "}
          <code className="text-zinc-500">THREAT_MODEL.md</code>.
        </p>
      </div>
    </div>
  );
}
