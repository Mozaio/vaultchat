import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  buildSessionFromLogin,
  buildSessionFromRegister,
} from "../lib/sessionHelpers";
import {
  loadLocalIdentity,
  loadToken,
  saveLocalIdentity,
  type LocalIdentity,
} from "../lib/localIdentity";
import * as api from "../lib/api";
import type { Session } from "../lib/sessionHelpers";
import { parseIdentityBackup } from "../lib/backup";
import { ThemeToggle } from "./ThemeToggle";
import { IconAlertTriangle, IconLock, IconShieldCheck, IconTimer } from "./Icons";

type Mode = "unlock" | "login" | "register" | "import";
type ProductPlanId = "personal" | "pro" | "team";

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
  if (!/^[a-zA-Z]/.test(username)) {
    return { valid: false, error: "Muss mit einem Buchstaben beginnen" };
  }
  // Can't start or end with underscore/hyphen
  if (/^[_-]|[_-]$/.test(username)) {
    return { valid: false, error: "Darf nicht mit _ oder - beginnen/enden" };
  }
  // No double underscore/hyphen
  if (/__|--|-_|_-|__/.test(username)) {
    return { valid: false, error: "Keine doppelte Zeichen wie __ oder -- erlaubt" };
  }
  if (["admin", "support", "vaultchat", "system", "signal", "telegram", "discord"].includes(username.toLowerCase())) {
    return { valid: false, error: "Dieser Name ist reserviert" };
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
  if (msg === "invite_required") return "Registrierung erfordert einen Einladungscode.";
  if (msg === "invalid_invite") return "Einladungscode ist ungueltig.";
  if (msg === "registration_closed") return "Registrierung ist aktuell geschlossen.";
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
  const [inviteCode, setInviteCode] = useState("");
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [selectedPlan, setSelectedPlan] = useState<ProductPlanId>("personal");
  const [showAdvancedAuth, setShowAdvancedAuth] = useState(false);
  const [registrationMode, setRegistrationMode] = useState<"open" | "invite" | "closed">("open");
  const [productConfig, setProductConfig] = useState<api.PublicConfig["product"] | null>(null);
  const [importJson, setImportJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.publicConfig()
      .then((config) => {
        setRegistrationMode(config.registration.mode);
        setProductConfig(config.product ?? null);
      })
      .catch(() => {});
  }, []);

  async function handleUnlock() {
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

  async function handleLogin() {
    setError(null);
    setBusy(true);
    try {
      let local: LocalIdentity | null = null;
      if (importJson.trim()) {
        local = await parseIdentityBackup(importJson, () =>
          window.prompt("Backup-Passphrase eingeben")
        );
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

  async function handleRegister() {
    setError(null);
    setBusy(true);
    try {
      const { session, local } = await buildSessionFromRegister(
        username,
        password,
        inviteCode.trim() || undefined,
        {
          requestedPlan: selectedPlan,
          recoveryEmail: recoveryEmail.trim() || undefined,
        }
      );
      await onSession(session, local);
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="landing-container min-h-full w-full bg-[var(--bg)]">
      <div className="landing-hero">
        <div className="landing-logo" aria-hidden>
          <IconShieldCheck size={34} />
        </div>
        <p
          className="relative z-[1] mb-2 text-xs font-semibold uppercase tracking-widest"
          style={{ color: "var(--accent)" }}
        >
          Secure Messenger
        </p>
        <h1 className="landing-title">VaultChat</h1>
        <p className="landing-subtitle max-w-lg">
          Ende-zu-Ende verschluesselt. Sealed Sender. Private Gruppen.
        </p>
        <div className="feature-list max-w-lg">
          <Feature
            icon={<IconLock size={18} />}
            title="Sealed Sender"
            desc="Server sieht keinen Absender"
          />
          <Feature
            icon={<IconShieldCheck size={18} />}
            title="TOFU + Sicherheitsnummer"
            desc="Schlüsselwechsel-Erkennung (TOFU)"
          />
          <Feature
            icon={<IconTimer size={18} />}
            title="Auto-Lock"
            desc="Schlüssel nach Inaktivität gelöscht"
          />
        </div>
        <div className="landing-trust-grid">
          <div>
            <span>Keine Pflicht-E-Mail</span>
            <strong>Identitaet bleibt minimal</strong>
          </div>
          <div>
            <span>Lokale Schluessel</span>
            <strong>Backup statt Server-Zugriff</strong>
          </div>
          <div>
            <span>Privacy Controls</span>
            <strong>Typing, Receipts, Relay</strong>
          </div>
        </div>
        <p
          className="relative z-[1] mt-10 max-w-md text-sm"
          style={{ color: "var(--text-muted)" }}
        >
          Starte ohne Pflicht-E-Mail. Recovery und Plan kannst du optional einstellen.
        </p>
      </div>

      <div className="flex min-h-full w-full min-w-0 items-center justify-center p-4">
        <div className="auth-card w-full max-w-md">
          <div className="mb-5 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="auth-brand">
                <span className="auth-brand-logo" aria-hidden>
                  <IconShieldCheck size={22} />
                </span>
                <span>VaultChat</span>
              </div>
              <h2
                className="mt-4 text-lg font-bold tracking-tight"
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
                  ? "Lokale Schluessel mit deinem Passwort entsperren."
                  : "Privater Messenger mit lokalem Schluessel-Backup."}
              </p>
              <div className="auth-assurance-row">
                <span>Zero-Knowledge Login</span>
                <span>Argon2id</span>
                <span>E2E Backup</span>
              </div>
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
              Verschluesselt, privat, minimal Metadaten.
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
          <div className="space-y-4">
            <div className="auth-input-group">
              <label>Passwort fuer lokale Schluessel</label>
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
              type="button"
              onClick={() => void handleUnlock()}
              disabled={busy}
              className="auth-button"
            >
              {busy ? "…" : "Entsperren"}
            </button>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Datensicherung und Fingerprint findest du nach dem Entsperren in den Einstellungen.
            </p>
          </div>
        )}

        {mode === "login" && (
          <div className="space-y-4">
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
              type="button"
              onClick={() => void handleLogin()}
              disabled={busy}
              className="auth-button"
            >
              {busy ? "…" : "Anmelden"}
            </button>
          </div>
        )}

        {mode === "register" && !hasLocal && (
          <div className="space-y-4">
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
              {password.length > 0 && (
                <div className="auth-safety-checks">
                  <div className={`flex items-center gap-2 text-xs ${password.length >= 10 ? "text-emerald-400" : "text-zinc-500"}`}>
                    <CheckIcon valid={password.length >= 10} />
                    <span>Mindestens 10 Zeichen</span>
                  </div>
                  <div className={`flex items-center gap-2 text-xs ${/[A-Z]/.test(password) && /[a-z]/.test(password) ? "text-emerald-400" : "text-zinc-500"}`}>
                    <CheckIcon valid={/[A-Z]/.test(password) && /[a-z]/.test(password)} />
                    <span>Gross- und Kleinbuchstaben</span>
                  </div>
                  <div className={`flex items-center gap-2 text-xs ${/\d/.test(password) || /[^a-zA-Z0-9]/.test(password) ? "text-emerald-400" : "text-zinc-500"}`}>
                    <CheckIcon valid={/\d/.test(password) || /[^a-zA-Z0-9]/.test(password)} />
                    <span>Zahl oder Sonderzeichen</span>
                  </div>
                </div>
              )}
            </div>
            {registrationMode !== "open" && (
              <div className="auth-input-group">
                <label>Einladungscode</label>
                <input
                  type="password"
                  className="auth-input"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  autoComplete="one-time-code"
                  disabled={registrationMode === "closed"}
                  required={registrationMode === "invite"}
                />
                <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
                  {registrationMode === "closed"
                    ? "Registrierung ist derzeit geschlossen."
                    : "Dieser Server nimmt neue Konten nur mit Einladung an."}
                </p>
              </div>
            )}
            <button
              type="button"
              className="auth-advanced-toggle"
              onClick={() => setShowAdvancedAuth((v) => !v)}
            >
              {showAdvancedAuth ? "Erweiterte Optionen ausblenden" : "Recovery und Plan optional einstellen"}
            </button>
            {showAdvancedAuth && (
              <div className="auth-advanced-stack">
                <div className="auth-choice-panel">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
                        Authentizitaet & Recovery
                      </p>
                      <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
                        Optional. Der Server speichert keinen Klartext, sondern nur einen HMAC-Hash.
                      </p>
                    </div>
                    <span className="auth-badge">Privacy-first</span>
                  </div>
                  <div className="auth-input-group mt-3">
                    <label>Recovery-E-Mail optional</label>
                    <input
                      type="email"
                      className="auth-input"
                      value={recoveryEmail}
                      onChange={(e) => setRecoveryEmail(e.target.value)}
                      autoComplete="email"
                      placeholder="name@example.com"
                    />
                    <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
                      Hilft spaeter bei Support/Account-Nachweis. Fuer neue Geraete brauchst du trotzdem dein Backup.
                    </p>
                  </div>
                </div>
                <div className="auth-choice-panel">
                  <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
                    Plan waehlen
                  </p>
                  <div className="auth-plan-grid mt-3">
                    {(productConfig?.plans ?? [
                      {
                        id: "personal" as const,
                        name: "Personal",
                        priceEurMonthly: 0,
                        audience: "Private Nutzung",
                        highlights: ["E2E-Chats", "Gruppen", "Backups"],
                      },
                      {
                        id: "pro" as const,
                        name: "Pro",
                        priceEurMonthly: 5,
                        audience: "Power-User",
                        highlights: ["mehr Geraete", "Priority Support"],
                      },
                      {
                        id: "team" as const,
                        name: "Team",
                        priceEurMonthly: 9,
                        audience: "Teams",
                        highlights: ["Einladungen", "Admin-Policy"],
                      },
                    ]).map((plan) => (
                      <button
                        key={plan.id}
                        type="button"
                        className={`auth-plan-card ${selectedPlan === plan.id ? "active" : ""}`}
                        onClick={() => setSelectedPlan(plan.id)}
                      >
                        <span className="font-semibold">{plan.name}</span>
                        <span className="auth-plan-price">
                          {plan.priceEurMonthly === 0 ? "Free" : `${plan.priceEurMonthly} EUR/Monat`}
                        </span>
                        <span className="auth-plan-audience">{plan.audience}</span>
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
                    Payment ist noch nicht aktiv. Diese Auswahl bereitet Pricing, Limits und spaetere Abrechnung vor.
                  </p>
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={() => void handleRegister()}
              disabled={
                busy ||
                registrationMode === "closed" ||
                (registrationMode === "invite" && inviteCode.trim().length < 8) ||
                !validateUsername(username).valid ||
                password.length < 10
              }
              className="auth-button"
            >
              {busy ? "…" : "Konto erstellen"}
            </button>
          </div>
        )}

        {mode === "import" && (
          <div className="space-y-4">
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
              onClick={() => void handleLogin()}
              className="auth-button"
            >
              {busy ? "…" : "Importieren & anmelden"}
            </button>
          </div>
        )}

        {error && (
          <div className="auth-error">
            <IconAlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              {error.includes("Benutzername oder Passwort")
                ? "Benutzername oder Passwort ist falsch."
                : error}
            </span>
          </div>
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

function Feature({ icon, title, desc }: { icon: ReactNode; title: string; desc: string }) {
  return (
    <div className="feature-item">
      <div className="feature-icon" aria-hidden>
        {icon}
      </div>
      <div className="feature-text">
        <h3>{title}</h3>
        <p>{desc}</p>
      </div>
    </div>
  );
}
