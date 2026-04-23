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
import { ThemeToggle } from "./ThemeToggle";

type Mode = "unlock" | "login" | "register" | "import";

// Discord-like username validation
function validateUsername(username: string): { valid: boolean; error?: string } {
  if (!username) {
    return { valid: false, error: "Benutzername erforderlich" };
  }
  if (username.length < 2) {
    return { valid: false, error: "Mindestens 2 Zeichen" };
  }
  if (username.length > 32) {
    return { valid: false, error: "Maximal 32 Zeichen" };
  }
  // Alphanumeric, underscore, hyphen
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return { valid: false, error: "Nur Buchstaben, Zahlen, _ und - erlaubt" };
  }
  // Can't start or end with underscore/hyphen
  if (/^[_-]|[_-]$/.test(username)) {
    return { valid: false, error: "Darf nicht mit _ oder - beginnen/enden" };
  }
  // No double underscore/hyphen
  if (/__|--|-_|_-|__/.test(username)) {
    return { valid: false, error: "Keine doppelte Zeichen wie __ oder -- erlaubt" };
  }
  return { valid: true };
}

// Check icon component
function CheckIcon({ valid }: { valid: boolean }) {
  return valid ? (
    <span className="text-emerald-400">✓</span>
  ) : (
    <span className="text-zinc-500">○</span>
  );
}

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
    <div className="landing-container min-h-full w-full bg-[var(--bg)]">
      <div className="landing-hero">
        <p
          className="relative z-[1] mb-2 text-xs font-semibold uppercase tracking-widest"
          style={{ color: "var(--accent)" }}
        >
          Secure Messenger
        </p>
        <h1 className="landing-title">VaultChat</h1>
        <p className="landing-subtitle max-w-lg">
          Ende-zu-Ende verschlüsselt. Sealed-Sender. Double-Ratchet v4.
        </p>
        <div className="feature-list max-w-lg">
          <Feature
            title="Sealed Sender"
            desc="Der Server sieht keinen Absender in DMs."
          />
          <Feature
            title="TOFU + Sicherheitsnummer"
            desc="Hinweis bei Schlüsselwechsel, ähnlich wie bei Signal."
          />
          <Feature
            title="Auto-Lock"
            desc="Schlüssel nach Inaktivität aus dem Arbeitsspeicher entfernt."
          />
        </div>
        <p
          className="relative z-[1] mt-10 max-w-md text-sm"
          style={{ color: "var(--text-muted)" }}
        >
          Tipp: Exportiere direkt nach der Registrierung dein JSON-Backup.
        </p>
      </div>

      <div className="flex min-h-full w-full min-w-0 items-center justify-center p-4">
        <div className="auth-card w-full max-w-md">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2
                className="text-lg font-bold tracking-tight"
                style={{ color: "var(--text)" }}
              >
                {hasLocal
                  ? mode === "unlock"
                    ? "Willkommen zurück"
                    : "Anderes Konto"
                  : mode === "import"
                    ? "Backup importieren"
                    : mode === "register"
                      ? "Konto erstellen"
                      : "Anmelden"}
              </h2>
              <p
                className="mt-0.5 text-sm"
                style={{ color: "var(--text-secondary)" }}
              >
                {hasLocal
                  ? "Lokale Schlüssel mit deinem Passwort nutzen."
                  : "E2E-verschlüsselter Messenger im Browser."}
              </p>
            </div>
            <ThemeToggle />
          </div>

          <div className="mb-6 border-b pb-5 md:hidden" style={{ borderColor: "var(--border)" }}>
            <h3
              className="text-2xl font-bold tracking-tight"
              style={{ color: "var(--text)" }}
            >
              VaultChat
            </h3>
            <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
              Sicher verschlüsselt, minimal Metadaten.
            </p>
          </div>

        {hasLocal && mode !== "import" && (
          <div className="auth-tabs mb-5">
            <button
              type="button"
              className={mode === "unlock" ? "auth-tab active" : "auth-tab"}
              onClick={() => setMode("unlock")}
            >
              Entsperren
            </button>
            <button
              type="button"
              className={mode === "login" ? "auth-tab active" : "auth-tab"}
              onClick={() => setMode("login")}
            >
              Anderes Konto
            </button>
          </div>
        )}

        {!hasLocal && mode !== "import" && (
          <div className="auth-tabs mb-5">
            <button
              type="button"
              className={mode === "login" ? "auth-tab active" : "auth-tab"}
              onClick={() => setMode("login")}
            >
              Anmelden
            </button>
            <button
              type="button"
              className={mode === "register" ? "auth-tab active" : "auth-tab"}
              onClick={() => setMode("register")}
            >
              Registrieren
            </button>
          </div>
        )}

        {mode === "unlock" && hasLocal && (
          <form onSubmit={handleUnlock} className="space-y-4">
            <div className="auth-input-group">
              <label>Passwort (lokale Schlüssel)</label>
              <input
                type="password"
                autoComplete="current-password"
                className="auth-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="auth-button"
            >
              {busy ? "…" : "Entsperren"}
            </button>
            <div className="flex flex-col gap-2 pt-1">
              <button
                type="button"
                onClick={showFingerprint}
                className="btn btn-ghost w-full !justify-start !px-0"
              >
                Fingerprint anzeigen
              </button>
              <button
                type="button"
                onClick={exportBackup}
                className="btn btn-ghost w-full !justify-start !px-0"
                style={{ color: "var(--accent)" }}
              >
                Backup (JSON) herunterladen
              </button>
            </div>
            {fp && (
              <p
                className="rounded-lg border px-3 py-2 text-center font-mono text-sm"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--bg-sidebar)",
                  color: "var(--accent)",
                }}
              >
                {fp}
              </p>
            )}
          </form>
        )}

        {mode === "login" && (
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="auth-input-group">
              <label>Benutzername</label>
              <input
                className="auth-input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
              />
            </div>
            <div className="auth-input-group">
              <label>Passwort</label>
              <input
                type="password"
                className="auth-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            <button
              type="button"
              onClick={() => setMode("import")}
              className="btn btn-secondary w-full"
            >
              Neues Gerät? Backup importieren
            </button>
            <button
              type="submit"
              disabled={busy}
              className="auth-button"
            >
              {busy ? "…" : "Anmelden"}
            </button>
          </form>
        )}

        {mode === "register" && !hasLocal && (
          <form onSubmit={handleRegister} className="space-y-4">
            <div className="auth-input-group">
              <label className="flex items-center justify-between">
                <span>Benutzername</span>
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                  Discord-like Format
                </span>
              </label>
              <input
                className="auth-input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                placeholder="z.B. cool_user123"
                required
              />
              {/* Username validation checklist */}
              {username.length > 0 && (
                <div className="mt-2 space-y-1 rounded-lg border p-3" style={{ borderColor: "var(--border)", background: "var(--bg-sidebar)" }}>
                  <div className={`flex items-center gap-2 text-xs ${username.length >= 2 && username.length <= 32 ? "text-emerald-400" : "text-zinc-500"}`}>
                    <CheckIcon valid={username.length >= 2 && username.length <= 32} />
                    <span>2-32 Zeichen</span>
                  </div>
                  <div className={`flex items-center gap-2 text-xs ${/^[a-zA-Z0-9_-]+$/.test(username) ? "text-emerald-400" : "text-zinc-500"}`}>
                    <CheckIcon valid={/^[a-zA-Z0-9_-]+$/.test(username)} />
                    <span>Nur a-z, A-Z, 0-9, _, -</span>
                  </div>
                  <div className={`flex items-center gap-2 text-xs ${/^[a-zA-Z]/.test(username) ? "text-emerald-400" : "text-zinc-500"}`}>
                    <CheckIcon valid={/^[a-zA-Z]/.test(username)} />
                    <span>Beginnt mit Buchstabe</span>
                  </div>
                  <div className={`flex items-center gap-2 text-xs ${!/[_-]$/.test(username) ? "text-emerald-400" : "text-zinc-500"}`}>
                    <CheckIcon valid={!/[_-]$/.test(username)} />
                    <span>Endet nicht mit _ oder -</span>
                  </div>
                </div>
              )}
            </div>
            <div className="auth-input-group">
              <label>Passwort (min. 10 Zeichen)</label>
              <input
                type="password"
                className="auth-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                minLength={10}
                required
              />
              {password.length > 0 && password.length < 10 && (
                <p className="mt-1 text-xs text-amber-500">
                  Noch {10 - password.length} Zeichen erforderlich
                </p>
              )}
            </div>
            <button
              type="submit"
              disabled={busy || !validateUsername(username).valid || password.length < 10}
              className="auth-button"
            >
              {busy ? "…" : "Konto erstellen"}
            </button>
          </form>
        )}

        {mode === "import" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setMode("login");
              void handleLogin(e);
            }}
            className="space-y-4"
          >
            <div className="flex items-center justify-between">
              <p
                className="text-sm font-semibold"
                style={{ color: "var(--text)" }}
              >
                Backup-JSON
              </p>
              <button
                type="button"
                onClick={() => setMode("login")}
                className="btn btn-ghost !px-2 !py-1 text-xs"
              >
                Zurück
              </button>
            </div>
            <textarea
              className="auth-input min-h-[140px] font-mono text-xs"
              value={importJson}
              onChange={(e) => setImportJson(e.target.value)}
              placeholder='{"userId":"…","username":"…",…}'
            />
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Danach meldest du dich mit Benutzername und Passwort an. Das
              Backup stellt deinen lokalen Schlüssel wieder her.
            </p>
            <button
              type="button"
              disabled={busy || !importJson.trim()}
              onClick={(e) => void handleLogin(e as unknown as React.FormEvent)}
              className="auth-button"
            >
              {busy ? "…" : "Importieren & anmelden"}
            </button>
          </form>
        )}

        {error && (
          <p
            className="mt-4 rounded-lg border px-3 py-2.5 text-sm"
            style={{
              borderColor: "rgba(248,113,113,0.35)",
              background: "var(--danger-soft)",
              color: "var(--danger)",
            }}
          >
            {error}
          </p>
        )}

        <p className="auth-footer">
          Browser und externer Server: Ohne vollständige Software-Audit ist das
          Bedrohungsmodell schwächer als bei nativen Apps. Siehe THREAT_MODEL.md
          im Repository.
        </p>
        </div>
      </div>
    </div>
  );
}

function Feature({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="feature-item">
      <div className="feature-icon" aria-hidden>
        ✓
      </div>
      <div className="feature-text">
        <h3>{title}</h3>
        <p>{desc}</p>
      </div>
    </div>
  );
}
