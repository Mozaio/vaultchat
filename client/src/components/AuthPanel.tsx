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
import { LanguageSwitcher } from "./LanguageSwitcher";
import { t, useLocale } from "../lib/i18n";
import {
  IconAlertTriangle,
  IconEye,
  IconEyeOff,
  IconLoader2,
} from "./Icons";
import { VaultChatLogo } from "./Logo";

type Mode = "unlock" | "login" | "register" | "import";
type ProductPlanId = "personal" | "pro" | "team";

function validateUsername(username: string): { valid: boolean; error?: string } {
  if (!username) return { valid: false, error: t("auth.valid.required") };
  if (username.length < 2) return { valid: false, error: t("auth.valid.min2") };
  if (username.length > 32) return { valid: false, error: t("auth.valid.max32") };
  if (!/^[a-zA-Z0-9_-]+$/.test(username))
    return { valid: false, error: t("auth.valid.charset") };
  if (!/^[a-zA-Z]/.test(username))
    return { valid: false, error: t("auth.valid.startLetter") };
  if (/^[_-]|[_-]$/.test(username))
    return { valid: false, error: t("auth.valid.noEdgeSep") };
  if (/__|--|-_|_-/.test(username))
    return { valid: false, error: t("auth.valid.noDoubleSep") };
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
    return { valid: false, error: t("auth.valid.reserved") };
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
    return t("auth.err.apiMisconfigured", { base: b });
  }
  if (msg === "network_error_or_cors") return t("auth.err.network");
  if (msg === "api_timeout") return t("auth.err.timeout");
  if (msg === "username_taken") return t("auth.err.usernameTaken");
  if (msg === "invite_required") return t("auth.err.inviteRequired");
  if (msg === "invalid_invite") return t("auth.err.invalidInvite");
  if (msg === "registration_closed") return t("auth.err.registrationClosed");
  if (msg === "invalid_body") return t("auth.err.invalidBody");
  if (msg === "invalid_credentials") return t("auth.err.invalidCredentials");
  if (msg === "not_found" || msg === "user_not_found")
    return t("auth.err.notFound");
  if (msg === "session_missing") return t("auth.err.sessionMissing");
  if (msg === "unauthorized" || msg === "token_expired")
    return t("auth.err.unauthorized");
  if (msg === "rate_limited") return t("auth.err.rateLimited");
  // Backup-Restore-Codes (vom backup.ts shape-check)
  if (msg === "backup_passphrase_wrong_or_tampered")
    return t("auth.err.backupWrongPass");
  if (msg === "backup_corrupt_json") return t("auth.err.backupCorruptJson");
  if (msg === "backup_unexpected_shape") return t("auth.err.backupShape");
  if (msg === "backup_must_be_encrypted_v2") return t("auth.err.backupMustV2");
  if (msg === "backup_passphrase_required")
    return t("auth.err.backupPassRequired");
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
  // Subscribe to locale changes so all t() strings below re-render live.
  useLocale();
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
          window.prompt(t("auth.enterBackupPass"))
        );
        saveLocalIdentity(local);
      } else {
        local = loadLocalIdentity();
      }
      if (!local || local.username !== username) {
        throw new Error(t("auth.deviceMismatch"));
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
      ? t("auth.welcomeBack")
      : t("auth.otherAccount")
    : mode === "import"
      ? t("auth.importBackup")
      : mode === "register"
        ? t("auth.createAccount")
        : t("auth.signIn");

  const cardSubtitle = hasLocal
    ? mode === "unlock"
      ? t("auth.sub.unlock")
      : t("auth.sub.other")
    : mode === "register"
      ? t("auth.sub.register")
      : mode === "import"
        ? t("auth.sub.import")
        : t("auth.sub.login");

  return (
    <div className="auth-split">
      <div className="auth-form-panel">
        <div className="auth-form-panel-toggle">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>

        {/* Mobile-only compact brand header */}
        <div className="auth-form-panel-mobile-brand">
          <VaultChatLogo size={28} style={{ color: "var(--accent)" }} />
          <span>Umbra</span>
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
                {t("auth.unlock")}
              </button>
              <button
                type="button"
                className={`auth-pill-tab${mode === "login" ? " active" : ""}`}
                onClick={() => setMode("login")}
              >
                {t("auth.otherAccount")}
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
                {t("auth.signIn")}
              </button>
              <button
                type="button"
                className={`auth-pill-tab${mode === "register" ? " active" : ""}`}
                onClick={() => setMode("register")}
              >
                {t("auth.register")}
              </button>
            </div>
          )}

          {/* ── Unlock form ── */}
          {mode === "unlock" && hasLocal && (
            <div className="auth-form">
              <div className="auth-input-group">
                <label htmlFor="auth-password">{t("auth.passwordLocalLabel")}</label>
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
                      showPassword
                        ? t("auth.hidePassword")
                        : t("auth.showPassword")
                    }
                    title={
                      showPassword
                        ? t("auth.hidePassword")
                        : t("auth.showPassword")
                    }
                    tabIndex={-1}
                  >
                    {showPassword ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                  </button>
                </div>
                {capsLockOn && (
                  <p className="auth-capslock">
                    <IconAlertTriangle size={12} /> {t("auth.capsLock")}
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
                    <span>{t("auth.unlocking")}</span>
                  </>
                ) : (
                  t("auth.unlock")
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
                <label htmlFor="auth-username">{t("auth.username")}</label>
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
                <label htmlFor="auth-password-login">{t("auth.password")}</label>
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
                      showPassword
                        ? t("auth.hidePassword")
                        : t("auth.showPassword")
                    }
                    title={
                      showPassword
                        ? t("auth.hidePassword")
                        : t("auth.showPassword")
                    }
                    tabIndex={-1}
                  >
                    {showPassword ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                  </button>
                </div>
                {capsLockOn && (
                  <p className="auth-capslock">
                    <IconAlertTriangle size={12} /> {t("auth.capsLock")}
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
                    <span>{t("auth.signingIn")}</span>
                  </>
                ) : (
                  t("auth.signIn")
                )}
              </button>
              {busySlowHint && (
                <p
                  id="auth-busy-hint-login"
                  className="auth-hint"
                  aria-live="polite"
                >
                  {t("auth.busyHint")}
                </p>
              )}
              <button
                type="button"
                onClick={() => setMode("import")}
                className="auth-link"
              >
                {t("auth.newDeviceImport")}
              </button>
            </div>
          )}

          {/* ── Register form ── */}
          {mode === "register" && !hasLocal && (
            <div className="auth-form">
              <div className="auth-input-group">
                <label htmlFor="auth-username-reg">
                  <span>{t("auth.username")}</span>
                  <span className="auth-label-hint">{t("auth.usernameHint")}</span>
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
                      {t("auth.usernameHint")}
                    </span>
                    <span>
                      <CheckIcon valid={/^[a-zA-Z0-9_-]+$/.test(username)} />
                      {t("auth.check.charset")}
                    </span>
                    <span>
                      <CheckIcon valid={/^[a-zA-Z]/.test(username)} />
                      {t("auth.check.startLetter")}
                    </span>
                    <span>
                      <CheckIcon valid={!/[_-]$/.test(username)} />
                      {t("auth.check.noEndSep")}
                    </span>
                  </div>
                )}
              </div>
              <div className="auth-input-group">
                <label htmlFor="auth-password-reg">
                  <span>{t("auth.password")}</span>
                  <span className="auth-label-hint">{t("auth.passwordHint")}</span>
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
                      showPassword
                        ? t("auth.hidePassword")
                        : t("auth.showPassword")
                    }
                    title={
                      showPassword
                        ? t("auth.hidePassword")
                        : t("auth.showPassword")
                    }
                    tabIndex={-1}
                  >
                    {showPassword ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                  </button>
                </div>
                {capsLockOn && (
                  <p className="auth-capslock">
                    <IconAlertTriangle size={12} /> {t("auth.capsLock")}
                  </p>
                )}
                {password.length > 0 && (
                  <div className="auth-checks">
                    <span>
                      <CheckIcon valid={password.length >= 10} />
                      {t("auth.check.min10")}
                    </span>
                    <span>
                      <CheckIcon
                        valid={/[A-Z]/.test(password) && /[a-z]/.test(password)}
                      />
                      {t("auth.check.case")}
                    </span>
                    <span>
                      <CheckIcon
                        valid={/\d/.test(password) || /[^a-zA-Z0-9]/.test(password)}
                      />
                      {t("auth.check.digitSpecial")}
                    </span>
                  </div>
                )}
              </div>
              {registrationMode !== "open" && (
                <div className="auth-input-group">
                  <label htmlFor="auth-invite">{t("auth.inviteCode")}</label>
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
                      ? t("auth.regClosed")
                      : t("auth.regInviteOnly")}
                  </p>
                </div>
              )}
              <button
                type="button"
                className="auth-link"
                onClick={() => setShowAdvancedAuth((v) => !v)}
              >
                {showAdvancedAuth ? t("auth.advHide") : t("auth.advShow")}
              </button>
              {showAdvancedAuth && (
                <div className="auth-advanced">
                  <div className="auth-input-group">
                    <label htmlFor="auth-recovery">
                      {t("auth.recoveryEmail")}
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
                      {t("auth.recoveryHint")}
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
                            ? t("auth.planFree")
                            : t("auth.perMonth", {
                                price: plan.priceEurMonthly,
                              })}
                        </span>
                        <span className="auth-plan-audience">
                          {t(`auth.audience.${plan.id}`)}
                        </span>
                      </button>
                    ))}
                  </div>
                  <p className="auth-hint">
                    {t("auth.paymentHint")}
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
                    <span>{t("auth.creatingAccount")}</span>
                  </>
                ) : (
                  t("auth.createAccount")
                )}
              </button>
              {busySlowHint && (
                <p
                  id="auth-busy-hint-register"
                  className="auth-hint"
                  aria-live="polite"
                >
                  {t("auth.busyHintRegister")}
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
                  {t("auth.backupJson")}
                </p>
                <button
                  type="button"
                  onClick={() => setMode("login")}
                  className="auth-link"
                >
                  {t("common.back")}
                </button>
              </div>
              <textarea
                className="auth-input auth-input-textarea"
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
                placeholder='{"userId":"…","username":"…",…}'
              />
              <p className="auth-hint">
                {t("auth.afterImportHint")}
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
                    <span>{t("auth.importing")}</span>
                  </>
                ) : (
                  t("auth.importAndSignIn")
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
