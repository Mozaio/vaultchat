import { useEffect, useMemo, useState } from "react";
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
import {
  IconAlertTriangle,
  IconLock,
  IconShieldCheck,
  IconTimer,
  IconBookmark,
  IconEye,
  IconEyeOff,
  IconLoader2,
} from "./Icons";
import { VaultChatLogo } from "./Logo";

type Mode = "unlock" | "login" | "register" | "import";
type ProductPlanId = "personal" | "pro" | "team";

function validateUsername(username: string): { valid: boolean; error?: string } {
  if (!username) return { valid: false, error: "Benutzername erforderlich" };
  if (username.length < 2) return { valid: false, error: "Mindestens 2 Zeichen" };
  if (username.length > 32) return { valid: false, error: "Maximal 32 Zeichen" };
  if (!/^[a-zA-Z0-9_-]+$/.test(username))
    return { valid: false, error: "Nur Buchstaben, Zahlen, _ und -" };
  if (!/^[a-zA-Z]/.test(username))
    return { valid: false, error: "Muss mit einem Buchstaben beginnen" };
  if (/^[_-]|[_-]$/.test(username))
    return { valid: false, error: "Darf nicht mit _ oder - beginnen/enden" };
  if (/__|--|-_|_-/.test(username))
    return { valid: false, error: "Keine doppelten Trennzeichen" };
  if (
    [
      "admin",
      "support",
      "vaultchat",
      "system",
      "signal",
      "telegram",
      "discord",
    ].includes(username.toLowerCase())
  )
    return { valid: false, error: "Dieser Name ist reserviert" };
  return { valid: true };
}

function CheckIcon({ valid }: { valid: boolean }) {
  return valid ? (
    <span style={{ color: "var(--accent)" }}>✓</span>
  ) : (
    <span style={{ color: "var(--text-muted)" }}>○</span>
  );
}

function humanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : "unknown_error";
  if (msg.startsWith("api_base_misconfigured:")) {
    const b = msg.slice("api_base_misconfigured:".length);
    return `API-Server falsch konfiguriert. Aktuelle API-Basis: ${b}.`;
  }
  if (msg === "network_error_or_cors")
    return "Netzwerk- oder CORS-Fehler. Server vielleicht nicht erreichbar.";
  if (msg === "api_timeout")
    return "Server antwortet nicht (Timeout). Render Free schläft evtl. — in 20-30 Sekunden erneut versuchen.";
  if (msg === "username_taken") return "Benutzername bereits vergeben.";
  if (msg === "invite_required")
    return "Registrierung erfordert einen Einladungscode.";
  if (msg === "invalid_invite") return "Einladungscode ist ungültig.";
  if (msg === "registration_closed")
    return "Registrierung ist aktuell geschlossen.";
  if (msg === "invalid_body")
    return "Eingaben ungültig. Prüfe Benutzername und Passwort.";
  if (msg === "invalid_credentials")
    return "Benutzername oder Passwort falsch.";
  if (msg === "not_found" || msg === "user_not_found")
    return "Konto nicht gefunden. Der Server wurde evtl. neu gestartet (Render Free) — bitte neu registrieren oder das Backup importieren.";
  if (msg === "session_missing")
    return "Lokale Sitzung verloren. Bitte über „Anderes Konto“ einloggen.";
  if (msg === "unauthorized" || msg === "token_expired")
    return "Sitzung abgelaufen. Bitte erneut einloggen.";
  if (msg === "rate_limited")
    return "Zu viele Versuche. Bitte einen Moment warten.";
  // Backup-Restore-Codes (vom backup.ts shape-check)
  if (msg === "backup_passphrase_wrong_or_tampered")
    return "Backup konnte nicht entschlüsselt werden — falsche Passphrase oder beschädigte Datei.";
  if (msg === "backup_corrupt_json")
    return "Backup ist beschädigt (kein gültiges JSON nach Entschlüsselung).";
  if (msg === "backup_unexpected_shape")
    return "Backup hat ein unerwartetes Format — vermutlich aus einer inkompatiblen Version.";
  if (msg === "backup_must_be_encrypted_v2")
    return "Backup-Format wird nicht unterstützt. Erwartet: VaultChat-Backup v2.";
  if (msg === "backup_passphrase_required")
    return "Backup-Passphrase wurde nicht eingegeben.";
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
  const [registrationMode, setRegistrationMode] = useState<
    "open" | "invite" | "closed"
  >("open");
  const [productConfig, setProductConfig] = useState<
    api.PublicConfig["product"] | null
  >(null);
  const [importJson, setImportJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busySlowHint, setBusySlowHint] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);

  // Argon2id im Worker dauert 600-1200ms. Nach 800ms zeigen wir einen
  // erklärenden Sub-Hinweis, damit User nicht den Eindruck bekommen,
  // die App hänge. Vorher reicht der Spinner.
  useEffect(() => {
    if (!busy) {
      setBusySlowHint(false);
      return;
    }
    const t = setTimeout(() => setBusySlowHint(true), 800);
    return () => clearTimeout(t);
  }, [busy]);

  function detectCaps(e: React.KeyboardEvent<HTMLInputElement>) {
    try {
      setCapsLockOn(e.getModifierState && e.getModifierState("CapsLock"));
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    void api
      .publicConfig()
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
      try {
        localStorage.setItem("vaultchat.onboarding.pending", "1");
        localStorage.removeItem("vaultchat.backupReminder.dismissed");
      } catch {
        /* ignore */
      }
      await onSession(session, local);
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  }

  const cardTitle = hasLocal
    ? mode === "unlock"
      ? "Willkommen zurück"
      : "Anderes Konto"
    : mode === "import"
      ? "Backup importieren"
      : mode === "register"
        ? "Konto erstellen"
        : "Anmelden";

  const cardSubtitle = hasLocal
    ? mode === "unlock"
      ? "Lokale Schlüssel mit deinem Passwort entsperren."
      : "Mit anderem Konto auf diesem Gerät einloggen."
    : mode === "register"
      ? "Wähle einen Benutzernamen und ein starkes Passwort. Keine E-Mail nötig."
      : mode === "import"
        ? "Importiere ein verschlüsseltes Backup, um auf diesem Gerät weiter zu chatten."
        : "Mit Benutzername und Passwort einloggen.";

  return (
    <div className="auth-split">
      {/* ── Left: always-dark brand panel ── */}
      <div className="auth-brand-panel" aria-hidden="true">
        <div className="auth-brand-top">
          <VaultChatLogo size={32} style={{ color: "#0d9488" }} />
          <span className="auth-brand-top-name">VaultChat</span>
        </div>

        <div className="auth-brand-content">
          <div className="auth-brand-hero">
            <h1>
              Kein Server kennt<br /><em>deine Nachrichten.</em>
            </h1>
            <p>
              Post-Quantum-verschlüsselt, Zero-Knowledge-Relay —
              kein Konto mit E-Mail nötig.
            </p>
          </div>

        <ul className="auth-brand-features">
          <li>
            <span className="auth-brand-feat-icon">
              <IconLock size={14} />
            </span>
            <div>
              <strong>Double Ratchet + ML-KEM-1024</strong>
              <span>Post-Quantum Forward Secrecy</span>
            </div>
          </li>
          <li>
            <span className="auth-brand-feat-icon">
              <IconShieldCheck size={14} />
            </span>
            <div>
              <strong>Sealed Sender</strong>
              <span>Absender-Metadaten nicht übertragen</span>
            </div>
          </li>
          <li>
            <span className="auth-brand-feat-icon">
              <IconTimer size={14} />
            </span>
            <div>
              <strong>Auto-Lock</strong>
              <span>Schlüssel automatisch aus dem Speicher löschen</span>
            </div>
          </li>
          <li>
            <span className="auth-brand-feat-icon">
              <IconBookmark size={14} />
            </span>
            <div>
              <strong>E2E-Backup</strong>
              <span>Verschlüsselter Schlüssel-Export für neue Geräte</span>
            </div>
          </li>
        </ul>
        </div>{/* end auth-brand-content */}

        <p className="auth-brand-footer">
          Web-Build. Kein auditierter Signal-Ersatz — siehe{" "}
          <code>THREAT_MODEL.md</code>.
        </p>
      </div>

      {/* ── Right: form panel ── */}
      <div className="auth-form-panel">
        <div className="auth-form-panel-toggle">
          <ThemeToggle />
        </div>

        {/* Mobile-only compact brand header */}
        <div className="auth-form-panel-mobile-brand">
          <VaultChatLogo size={28} style={{ color: "var(--accent)" }} />
          <span>VaultChat</span>
        </div>

        <div className="auth-form-body">
          <header>
            <h2 className="auth-form-head-title">{cardTitle}</h2>
            <p className="auth-form-head-sub">{cardSubtitle}</p>
          </header>

          {/* Tab switcher — unlock vs. other account */}
          {hasLocal && mode !== "import" && (
            <div className="auth-pill-tabs">
              <button
                type="button"
                className={`auth-pill-tab${mode === "unlock" ? " active" : ""}`}
                onClick={() => setMode("unlock")}
              >
                Entsperren
              </button>
              <button
                type="button"
                className={`auth-pill-tab${mode === "login" ? " active" : ""}`}
                onClick={() => setMode("login")}
              >
                Anderes Konto
              </button>
            </div>
          )}

          {/* Tab switcher — login vs. register */}
          {!hasLocal && mode !== "import" && (
            <div className="auth-pill-tabs">
              <button
                type="button"
                className={`auth-pill-tab${mode === "login" ? " active" : ""}`}
                onClick={() => setMode("login")}
              >
                Anmelden
              </button>
              <button
                type="button"
                className={`auth-pill-tab${mode === "register" ? " active" : ""}`}
                onClick={() => setMode("register")}
              >
                Registrieren
              </button>
            </div>
          )}

          {/* ── Unlock form ── */}
          {mode === "unlock" && hasLocal && (
            <div className="auth-form">
              <div className="auth-input-group">
                <label htmlFor="auth-password">Passwort für lokale Schlüssel</label>
                <div className="auth-password-wrap">
                  <input
                    id="auth-password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    className="auth-input auth-input-with-toggle"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => {
                      detectCaps(e);
                      if (e.key === "Enter") void handleUnlock();
                    }}
                    onKeyUp={detectCaps}
                    required
                    autoFocus
                  />
                  <button
                    type="button"
                    className="auth-password-toggle"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={
                      showPassword ? "Passwort verbergen" : "Passwort anzeigen"
                    }
                    title={
                      showPassword ? "Passwort verbergen" : "Passwort anzeigen"
                    }
                    tabIndex={-1}
                  >
                    {showPassword ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                  </button>
                </div>
                {capsLockOn && (
                  <p className="auth-capslock">
                    <IconAlertTriangle size={12} /> Feststelltaste ist aktiv
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => void handleUnlock()}
                disabled={busy || !password}
                className="auth-button"
                aria-describedby={busySlowHint ? "auth-busy-hint" : undefined}
              >
                {busy ? (
                  <>
                    <IconLoader2 size={16} className="auth-button-spinner" />
                    <span>Entsperre …</span>
                  </>
                ) : (
                  "Entsperren"
                )}
              </button>
              {busySlowHint && (
                <p
                  id="auth-busy-hint"
                  className="auth-hint"
                  aria-live="polite"
                >
                  Schlüssel werden im Worker abgeleitet (Argon2id) — kann ein
                  paar Sekunden dauern.
                </p>
              )}
              <p className="auth-hint">
                Backup &amp; Fingerprint findest du nach dem Entsperren in den
                Einstellungen.
              </p>
            </div>
          )}

          {/* ── Login form ── */}
          {mode === "login" && (
            <div className="auth-form">
              <div className="auth-input-group">
                <label htmlFor="auth-username">Benutzername</label>
                <input
                  id="auth-username"
                  className="auth-input"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void handleLogin()}
                  autoComplete="username"
                  required
                  autoFocus
                />
              </div>
              <div className="auth-input-group">
                <label htmlFor="auth-password-login">Passwort</label>
                <div className="auth-password-wrap">
                  <input
                    id="auth-password-login"
                    type={showPassword ? "text" : "password"}
                    className="auth-input auth-input-with-toggle"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => {
                      detectCaps(e);
                      if (e.key === "Enter") void handleLogin();
                    }}
                    onKeyUp={detectCaps}
                    autoComplete="current-password"
                    required
                  />
                  <button
                    type="button"
                    className="auth-password-toggle"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={
                      showPassword ? "Passwort verbergen" : "Passwort anzeigen"
                    }
                    title={
                      showPassword ? "Passwort verbergen" : "Passwort anzeigen"
                    }
                    tabIndex={-1}
                  >
                    {showPassword ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                  </button>
                </div>
                {capsLockOn && (
                  <p className="auth-capslock">
                    <IconAlertTriangle size={12} /> Feststelltaste ist aktiv
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => void handleLogin()}
                disabled={busy || !username || !password}
                className="auth-button"
                aria-describedby={busySlowHint ? "auth-busy-hint-login" : undefined}
              >
                {busy ? (
                  <>
                    <IconLoader2 size={16} className="auth-button-spinner" />
                    <span>Anmeldung läuft …</span>
                  </>
                ) : (
                  "Anmelden"
                )}
              </button>
              {busySlowHint && (
                <p
                  id="auth-busy-hint-login"
                  className="auth-hint"
                  aria-live="polite"
                >
                  Schlüssel werden im Worker abgeleitet (Argon2id) — kann ein
                  paar Sekunden dauern.
                </p>
              )}
              <button
                type="button"
                onClick={() => setMode("import")}
                className="auth-link"
              >
                Neues Gerät? Backup importieren
              </button>
            </div>
          )}

          {/* ── Register form ── */}
          {mode === "register" && !hasLocal && (
            <div className="auth-form">
              <div className="auth-input-group">
                <label htmlFor="auth-username-reg">
                  <span>Benutzername</span>
                  <span className="auth-label-hint">2–32 Zeichen</span>
                </label>
                <input
                  id="auth-username-reg"
                  className="auth-input"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  placeholder="cool_user123"
                  required
                />
                {username.length > 0 && (
                  <div className="auth-checks">
                    <span>
                      <CheckIcon valid={username.length >= 2 && username.length <= 32} />
                      2–32 Zeichen
                    </span>
                    <span>
                      <CheckIcon valid={/^[a-zA-Z0-9_-]+$/.test(username)} />
                      Nur a–z, 0–9, _, -
                    </span>
                    <span>
                      <CheckIcon valid={/^[a-zA-Z]/.test(username)} />
                      Beginnt mit Buchstabe
                    </span>
                    <span>
                      <CheckIcon valid={!/[_-]$/.test(username)} />
                      Endet nicht mit _ oder -
                    </span>
                  </div>
                )}
              </div>
              <div className="auth-input-group">
                <label htmlFor="auth-password-reg">
                  <span>Passwort</span>
                  <span className="auth-label-hint">min. 10 Zeichen</span>
                </label>
                <div className="auth-password-wrap">
                  <input
                    id="auth-password-reg"
                    type={showPassword ? "text" : "password"}
                    className="auth-input auth-input-with-toggle"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={detectCaps}
                    onKeyUp={detectCaps}
                    autoComplete="new-password"
                    minLength={10}
                    required
                  />
                  <button
                    type="button"
                    className="auth-password-toggle"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={
                      showPassword ? "Passwort verbergen" : "Passwort anzeigen"
                    }
                    title={
                      showPassword ? "Passwort verbergen" : "Passwort anzeigen"
                    }
                    tabIndex={-1}
                  >
                    {showPassword ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                  </button>
                </div>
                {capsLockOn && (
                  <p className="auth-capslock">
                    <IconAlertTriangle size={12} /> Feststelltaste ist aktiv
                  </p>
                )}
                {password.length > 0 && (
                  <div className="auth-checks">
                    <span>
                      <CheckIcon valid={password.length >= 10} />
                      Mindestens 10 Zeichen
                    </span>
                    <span>
                      <CheckIcon
                        valid={/[A-Z]/.test(password) && /[a-z]/.test(password)}
                      />
                      Groß- und Kleinbuchstaben
                    </span>
                    <span>
                      <CheckIcon
                        valid={/\d/.test(password) || /[^a-zA-Z0-9]/.test(password)}
                      />
                      Zahl oder Sonderzeichen
                    </span>
                  </div>
                )}
              </div>
              {registrationMode !== "open" && (
                <div className="auth-input-group">
                  <label htmlFor="auth-invite">Einladungscode</label>
                  <input
                    id="auth-invite"
                    type="password"
                    className="auth-input"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    autoComplete="one-time-code"
                    disabled={registrationMode === "closed"}
                    required={registrationMode === "invite"}
                  />
                  <p className="auth-hint">
                    {registrationMode === "closed"
                      ? "Registrierung ist derzeit geschlossen."
                      : "Dieser Server nimmt neue Konten nur mit Einladung an."}
                  </p>
                </div>
              )}
              <button
                type="button"
                className="auth-link"
                onClick={() => setShowAdvancedAuth((v) => !v)}
              >
                {showAdvancedAuth
                  ? "Erweiterte Optionen ausblenden"
                  : "Recovery & Plan optional einstellen"}
              </button>
              {showAdvancedAuth && (
                <div className="auth-advanced">
                  <div className="auth-input-group">
                    <label htmlFor="auth-recovery">
                      Recovery-E-Mail (optional)
                    </label>
                    <input
                      id="auth-recovery"
                      type="email"
                      className="auth-input"
                      value={recoveryEmail}
                      onChange={(e) => setRecoveryEmail(e.target.value)}
                      autoComplete="email"
                      placeholder="name@example.com"
                    />
                    <p className="auth-hint">
                      Server speichert nur HMAC-Hash. Backup bleibt für neue
                      Geräte trotzdem nötig.
                    </p>
                  </div>
                  <div className="auth-plans">
                    {(productConfig?.plans ?? [
                      {
                        id: "personal" as const,
                        name: "Personal",
                        priceEurMonthly: 0,
                        audience: "Private Nutzung",
                        highlights: [],
                      },
                      {
                        id: "pro" as const,
                        name: "Pro",
                        priceEurMonthly: 5,
                        audience: "Power-User",
                        highlights: [],
                      },
                      {
                        id: "team" as const,
                        name: "Team",
                        priceEurMonthly: 9,
                        audience: "Teams",
                        highlights: [],
                      },
                    ]).map((plan) => (
                      <button
                        key={plan.id}
                        type="button"
                        className={`auth-plan${selectedPlan === plan.id ? " active" : ""}`}
                        onClick={() => setSelectedPlan(plan.id)}
                      >
                        <span className="auth-plan-name">{plan.name}</span>
                        <span className="auth-plan-price">
                          {plan.priceEurMonthly === 0
                            ? "Free"
                            : `${plan.priceEurMonthly} €/Monat`}
                        </span>
                        <span className="auth-plan-audience">
                          {plan.audience}
                        </span>
                      </button>
                    ))}
                  </div>
                  <p className="auth-hint">
                    Payment ist noch nicht aktiv — Auswahl bereitet Pricing
                    und spätere Abrechnung vor.
                  </p>
                </div>
              )}
              <button
                type="button"
                onClick={() => void handleRegister()}
                disabled={
                  busy ||
                  registrationMode === "closed" ||
                  (registrationMode === "invite" &&
                    inviteCode.trim().length < 8) ||
                  !validateUsername(username).valid ||
                  password.length < 10
                }
                className="auth-button"
                aria-describedby={
                  busySlowHint ? "auth-busy-hint-register" : undefined
                }
              >
                {busy ? (
                  <>
                    <IconLoader2 size={16} className="auth-button-spinner" />
                    <span>Konto wird erstellt …</span>
                  </>
                ) : (
                  "Konto erstellen"
                )}
              </button>
              {busySlowHint && (
                <p
                  id="auth-busy-hint-register"
                  className="auth-hint"
                  aria-live="polite"
                >
                  Schlüssel werden im Worker generiert (Argon2id + X25519 +
                  ML-KEM-1024) — kann ein paar Sekunden dauern.
                </p>
              )}
            </div>
          )}

          {/* ── Import form ── */}
          {mode === "import" && (
            <div className="auth-form">
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
                  className="auth-link"
                >
                  Zurück
                </button>
              </div>
              <textarea
                className="auth-input auth-input-textarea"
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
                placeholder='{"userId":"…","username":"…",…}'
              />
              <p className="auth-hint">
                Danach mit Benutzername und Passwort anmelden.
              </p>
              <button
                type="button"
                disabled={busy || !importJson.trim()}
                onClick={() => void handleLogin()}
                className="auth-button"
              >
                {busy ? (
                  <>
                    <IconLoader2 size={16} className="auth-button-spinner" />
                    <span>Import läuft …</span>
                  </>
                ) : (
                  "Importieren & anmelden"
                )}
              </button>
            </div>
          )}

          {error && (
            <div className="auth-error">
              <IconAlertTriangle
                size={16}
                style={{ flexShrink: 0, marginTop: 1 }}
              />
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
