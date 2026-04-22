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
import { useTheme } from "../lib/theme";

type Mode = "unlock" | "login" | "register";

function humanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : "unknown_error";
  if (msg.startsWith("api_base_misconfigured:")) {
    const b = msg.slice("api_base_misconfigured:".length);
    return `API-Server falsch konfiguriert. Aktuelle API-Basis: ${b}. In Render beim Client bitte VITE_API_BASE auf deinen Server setzen (z. B. https://vaultchat-server.onrender.com).`;
  }
  if (msg === "network_error_or_cors") {
    return "Netzwerk/CORS-Fehler. Prüfe, ob der Server erreichbar ist und VAULTCHAT_CORS_ORIGIN im Server korrekt auf die Client-URL zeigt.";
  }
  if (msg === "api_timeout") {
    return "Server antwortet nicht rechtzeitig (Timeout). Auf Render Free evtl. schläft der Server gerade; versuche es nach 20-30 Sekunden erneut.";
  }
  if (msg === "username_taken") return "Benutzername bereits vergeben.";
  if (msg === "invalid_body") return "Eingaben ungültig. Prüfe Benutzername/Passwort.";
  if (msg === "invalid_credentials") return "Login fehlgeschlagen: Benutzername oder Passwort falsch.";
  return msg;
}

export function AuthPanel({
  onSession,
}: {
  onSession: (s: Session, local: LocalIdentity) => void | Promise<void>;
}) {
  const { theme, toggle } = useTheme();
  const hasLocal = useMemo(
    () => Boolean(loadToken() && loadLocalIdentity()),
    []
  );
  const [mode, setMode] = useState<Mode>(hasLocal ? "unlock" : "login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [importJson, setImportJson] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
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
      setError(humanError(err));
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
      setError(humanError(err));
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
      setError(humanError(err));
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
    <div className="relative flex min-h-full items-center justify-center overflow-hidden bg-zinc-950 px-4 py-10">
      <div className="pointer-events-none absolute -top-32 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-emerald-600/20 blur-3xl" />
      <div className="pointer-events-none absolute bottom-0 right-0 h-72 w-72 rounded-full bg-cyan-500/10 blur-3xl" />
      <div className="relative w-full max-w-5xl">
        <div className="grid gap-6 md:grid-cols-2 md:items-stretch">
          <div className="hidden rounded-3xl border border-zinc-800/70 bg-zinc-900/30 p-8 backdrop-blur-xl md:block">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400/90">
              Secure Messenger
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-white">
              VaultChat
            </h1>
            <p className="mt-3 text-sm text-zinc-400">
              Ende‑zu‑Ende verschlüsselt. Sealed‑Sender. Double‑Ratchet v4.
            </p>
            <div className="mt-6 space-y-3 text-sm text-zinc-300">
              <Feature title="Sealed Sender" desc="Der Server sieht keinen Absender in DMs." />
              <Feature title="TOFU + Safety Number" desc="Warnung bei Key‑Wechsel, Verifikation wie Signal." />
              <Feature title="Auto‑Lock" desc="Schlüssel werden nach Inaktivität aus dem Speicher entfernt." />
            </div>
            <p className="mt-8 text-xs text-zinc-500">
              Tipp: Exportiere nach der Registrierung sofort dein JSON‑Backup.
            </p>
          </div>

          <div className="app-surface rounded-3xl p-7 md:p-8">
            <div className="mb-7 text-center md:hidden">
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400/90">
                Secure Messenger
              </p>
              <h1 className="text-3xl font-semibold tracking-tight text-white">
                VaultChat
              </h1>
              <p className="mt-2 text-sm text-zinc-400">
                Ende‑zu‑Ende verschlüsselt. Der Server sieht keinen Klartext.
              </p>
            </div>
            <div className="mb-5 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400/90">
                {hasLocal ? "Willkommen zurück" : "Los geht’s"}
              </p>
              <button
                type="button"
                onClick={toggle}
                className="rounded-xl border border-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800/60"
                title="Theme umschalten"
              >
                {theme === "dark" ? "Light" : "Dark"}
              </button>
            </div>

        {hasLocal && (
          <div className="mb-6 flex gap-2 rounded-xl border border-zinc-800 bg-zinc-950/80 p-1">
            <button
              type="button"
              className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
                mode === "unlock"
                  ? "bg-emerald-600 text-white shadow-sm shadow-emerald-900/50"
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
                  ? "bg-emerald-600 text-white shadow-sm shadow-emerald-900/50"
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
                className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950/80 px-3 py-2.5 text-white outline-none ring-emerald-500/30 transition focus:border-emerald-500/50 focus:ring-2"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-emerald-600 py-2.5 font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy ? "…" : "Entsperren"}
            </button>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={showFingerprint}
                className="w-full text-sm text-zinc-500 transition hover:text-zinc-300"
              >
                Meinen Schlüsselfingerprint anzeigen
              </button>
              <button
                type="button"
                onClick={exportBackup}
                className="w-full text-sm text-emerald-500/90 transition hover:text-emerald-400"
              >
                Backup (JSON) herunterladen
              </button>
            </div>
            {fp && (
              <p className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-center font-mono text-sm text-emerald-400">
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
                className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950/80 px-3 py-2.5 text-white outline-none ring-emerald-500/30 transition focus:border-emerald-500/50 focus:ring-2"
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
                className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950/80 px-3 py-2.5 text-white outline-none ring-emerald-500/30 transition focus:border-emerald-500/50 focus:ring-2"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/50 p-3">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex w-full items-center justify-between text-sm text-zinc-300"
              >
                <span>Neues Gerät? Backup importieren</span>
                <span className="text-zinc-500">{showAdvanced ? "–" : "+"}</span>
              </button>
              {showAdvanced && (
                <div className="mt-3">
                  <textarea
                    className="min-h-[92px] w-full rounded-xl border border-zinc-700 bg-zinc-950/80 px-3 py-2 font-mono text-xs text-zinc-200 outline-none ring-emerald-500/30 transition focus:border-emerald-500/50 focus:ring-2"
                    value={importJson}
                    onChange={(e) => setImportJson(e.target.value)}
                    placeholder='{"userId":"…","username":"…","publicKey":"…","wrapped":{…}}'
                  />
                  <p className="mt-2 text-xs text-zinc-500">
                    Import nur nötig, wenn du dieses Konto auf einem neuen Gerät entsperren willst.
                  </p>
                </div>
              )}
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-emerald-600 py-2.5 font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
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
                className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950/80 px-3 py-2.5 text-white outline-none ring-emerald-500/30 transition focus:border-emerald-500/50 focus:ring-2"
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
                className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950/80 px-3 py-2.5 text-white outline-none ring-emerald-500/30 transition focus:border-emerald-500/50 focus:ring-2"
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
              className="w-full rounded-xl bg-emerald-600 py-2.5 font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy ? "…" : "Konto erstellen"}
            </button>
          </form>
        )}

        {!hasLocal && (
          <div className="mt-6 flex gap-2 rounded-xl border border-zinc-800 bg-zinc-950/80 p-1 text-sm">
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
          <p className="mt-4 rounded-xl border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
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
      </div>
    </div>
  );
}

function Feature({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="flex gap-3">
      <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-emerald-400/80" />
      <div>
        <p className="font-medium text-white">{title}</p>
        <p className="text-xs text-zinc-400">{desc}</p>
      </div>
    </div>
  );
}
