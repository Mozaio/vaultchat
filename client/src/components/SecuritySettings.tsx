/**
 * Einstellungen: Tabs Allgemein · Datenschutz · Sicherheit · Über
 */
import { useState, useEffect, useRef } from "react";
import {
  startPeriodicWipe,
  stopPeriodicWipe,
  immediateWipe,
  setSecurityMode,
} from "../lib/exfilProtection";
import {
  resetAllReplayProtection,
  getReplayStats,
} from "../lib/replayProtection";
import {
  loadAutoLockMinutes,
  saveAutoLockMinutes,
} from "../lib/useAutoLock";
import {
  DEFAULT_TTL_OPTIONS,
  loadDefaultTtl,
  saveDefaultTtl,
} from "../lib/disappearingDefault";
import type { ServerStatus } from "../lib/api";
import {
  IconAlertTriangle,
  IconCheck,
  IconRefreshCw,
  IconShieldCheck,
  IconX,
} from "./Icons";
import { ThemeToggle } from "./ThemeToggle";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { t, useLocale } from "../lib/i18n";
import { useInstallAvailable, promptInstall } from "../lib/installPrompt";
import { isTauri } from "../lib/desktopNotify";
import { loadScreenSecurity, setScreenSecurity } from "../lib/screenSecurity";
import {
  ACCENTS,
  loadAccent,
  saveAccent,
  type AccentId,
} from "../lib/accentStore";
import {
  loadDensity,
  saveDensity,
  type DensityId,
} from "../lib/densityStore";
import {
  loadCustomEmojis,
  removeCustomEmoji,
  addCustomEmojiFromFile,
  type CustomEmoji,
} from "../lib/customEmojis";
import {
  loadPlan,
  setPlanLocal,
  PLAN_LABELS,
  PLAN_PRICES,
  PLAN_FEATURE_KEYS,
  PLAN_LIMITS,
  type PlanId,
} from "../lib/plan";
import {
  isZkgroupExperimentalEnabled,
  setZkgroupExperimentalEnabled,
  probeZkgroup,
  type ZkgroupProbe,
} from "../lib/zkgroupClient";

export type SecurityLevel = "normal" | "extreme";

const SECURITY_STORAGE_KEY = "vaultchat.security.level";

/** Desktop-Toasts: an, wenn nicht "off" */
export const NOTIFY_STORAGE_KEY = "vaultchat.privacy.notify";
/** Textvorschau in System-Benachrichtigungen */
export const NOTIFY_PREVIEW_STORAGE_KEY = "vaultchat.privacy.notifyPreview";

export function loadSecurityLevel(): SecurityLevel {
  try {
    const stored = localStorage.getItem(SECURITY_STORAGE_KEY);
    if (stored === "extreme" || stored === "normal") {
      return stored;
    }
  } catch {
    /* ignore */
  }
  return "normal";
}

export function saveSecurityLevel(level: SecurityLevel): void {
  try {
    localStorage.setItem(SECURITY_STORAGE_KEY, level);
  } catch {
    /* ignore */
  }
}

type SettingsTabId = "general" | "privacy" | "security" | "emojis" | "plan" | "about";

const SETTINGS_TABS: { id: SettingsTabId; labelKey: string }[] = [
  { id: "general", labelKey: "settings.tab.general" },
  { id: "privacy", labelKey: "settings.tab.privacy" },
  { id: "security", labelKey: "settings.tab.security" },
  { id: "emojis", labelKey: "settings.tab.emojis" },
  { id: "plan", labelKey: "settings.tab.plan" },
  { id: "about", labelKey: "settings.tab.about" },
];

function readNotifyEnabled(): boolean {
  try {
    return localStorage.getItem(NOTIFY_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Signal-Style: Was die System-Benachrichtigung preisgibt.
 *  Legacy-Mapping: kein Wert = "full", "off" (alter Toggle) = "name". */
export type NotifyPreviewMode = "full" | "name" | "none";

function readNotifyPreviewMode(): NotifyPreviewMode {
  try {
    const stored = localStorage.getItem(NOTIFY_PREVIEW_STORAGE_KEY);
    if (stored === "off") return "name";
    if (stored === "none") return "none";
  } catch {
    /* ignore */
  }
  return "full";
}

const NOTIFY_PREVIEW_OPTIONS: { mode: NotifyPreviewMode; labelKey: string }[] = [
  { mode: "full", labelKey: "settings.notifyPreview.full" },
  { mode: "name", labelKey: "settings.notifyPreview.name" },
  { mode: "none", labelKey: "settings.notifyPreview.none" },
];

/** Sealed-Sender für Gruppen (#26): Absender vor dem Server verbergen.
 *  Default aus (Opt-in). */
const SEALED_GROUP_STORAGE_KEY = "vaultchat.privacy.sealedGroup";
function readSealedGroup(): boolean {
  try {
    return localStorage.getItem(SEALED_GROUP_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

interface SecuritySettingsProps {
  onClose: () => void;
  relayOnly?: boolean;
  onRelayOnlyChange?: (value: boolean) => void;
  myFingerprint?: string | null;
  serverStatus?: ServerStatus | null;
  serverStatusError?: string | null;
  onExportBackup?: () => void;
  sendTypingIndicators?: boolean;
  onSendTypingIndicatorsChange?: (value: boolean) => void;
  sendReadReceipts?: boolean;
  onSendReadReceiptsChange?: (value: boolean) => void;
  notificationEnabled?: boolean;
  onNotificationEnabledChange?: (value: boolean) => void;
  notificationPreview?: boolean;
  onNotificationPreviewChange?: (value: boolean) => void;
  notificationPermission?: NotificationPermission | "unsupported";
  onRequestNotificationPermission?: () => void | Promise<void>;
  blockedContacts?: { id: string; username: string }[];
  onUnblockContact?: (id: string) => void;
}

export function SecuritySettings({
  onClose,
  relayOnly = false,
  onRelayOnlyChange,
  myFingerprint,
  serverStatus,
  serverStatusError,
  onExportBackup,
  sendTypingIndicators = false,
  onSendTypingIndicatorsChange,
  sendReadReceipts = false,
  onSendReadReceiptsChange,
  notificationEnabled = false,
  onNotificationEnabledChange,
  notificationPreview = false,
  onNotificationPreviewChange,
  notificationPermission = "default",
  onRequestNotificationPermission,
  blockedContacts = [],
  onUnblockContact,
}: SecuritySettingsProps) {
  useLocale(); // re-render on language change
  const installAvailable = useInstallAvailable();
  const desktop = isTauri();
  const [screenSec, setScreenSec] = useState(() => loadScreenSecurity());
  const [accent, setAccent] = useState<AccentId>(() => loadAccent());
  const [density, setDensity] = useState<DensityId>(() => loadDensity());
  const [tab, setTab] = useState<SettingsTabId>("general");
  const [level, setLevel] = useState<SecurityLevel>(loadSecurityLevel);
  const [autoLockMinutes, setAutoLockMinutes] = useState<number>(() =>
    loadAutoLockMinutes()
  );
  const [defaultTtl, setDefaultTtl] = useState<number>(() => loadDefaultTtl());
  const [replayStats, setReplayStats] = useState(getReplayStats());
  const [desktopNotify, setDesktopNotify] = useState(readNotifyEnabled);
  const [notifyPreviewMode, setNotifyPreviewMode] = useState<NotifyPreviewMode>(
    readNotifyPreviewMode
  );
  const [sealedGroup, setSealedGroup] = useState(readSealedGroup);
  const [notifyPermission, setNotifyPermission] = useState<
    NotificationPermission | "unsupported"
  >(
    typeof Notification !== "undefined"
      ? Notification.permission
      : "unsupported"
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setReplayStats(getReplayStats());
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleLevelChange = async (newLevel: SecurityLevel) => {
    setLevel(newLevel);
    saveSecurityLevel(newLevel);
    setSecurityMode(newLevel);

    if (newLevel === "extreme") {
      startPeriodicWipe();
    } else {
      stopPeriodicWipe();
    }
  };

  const handleImmediateWipe = async () => {
    await immediateWipe();
  };

  const handleResetReplayProtection = () => {
    resetAllReplayProtection();
    setReplayStats(getReplayStats());
  };

  const productionReady =
    serverStatus?.profile === "production" &&
    serverStatus.state.mode === "persistent" &&
    serverStatus.state.writable &&
    serverStatus.registration.mode !== "open" &&
    serverStatus.privacy.sealedDmMailbox &&
    !serverStatus.privacy.messageContentPersistentOnServer &&
    !serverStatus.privacy.urlTokenAuthEnabled;

  const setDesktopNotifyStored = (enabled: boolean) => {
    setDesktopNotify(enabled);
    try {
      if (enabled) localStorage.removeItem(NOTIFY_STORAGE_KEY);
      else localStorage.setItem(NOTIFY_STORAGE_KEY, "off");
    } catch {
      /* ignore */
    }
  };

  const setNotifyPreviewModeStored = (mode: NotifyPreviewMode) => {
    setNotifyPreviewMode(mode);
    try {
      if (mode === "full") localStorage.removeItem(NOTIFY_PREVIEW_STORAGE_KEY);
      else if (mode === "name")
        localStorage.setItem(NOTIFY_PREVIEW_STORAGE_KEY, "off");
      else localStorage.setItem(NOTIFY_PREVIEW_STORAGE_KEY, "none");
    } catch {
      /* ignore */
    }
  };

  const setSealedGroupStored = (enabled: boolean) => {
    setSealedGroup(enabled);
    try {
      if (enabled) localStorage.setItem(SEALED_GROUP_STORAGE_KEY, "on");
      else localStorage.removeItem(SEALED_GROUP_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  const requestNotifyPermission = () => {
    if (!("Notification" in window)) return;
    void Notification.requestPermission().then((p) => {
      setNotifyPermission(p);
    });
  };

  const appVersion =
    (import.meta.env.VITE_APP_VERSION as string | undefined)?.trim() || "1.0.0";

  return (
    <div className="u-modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div
        className="app-surface u-modal-card flex max-h-[min(90vh,720px)] w-full max-w-lg flex-col rounded-2xl p-0 shadow-xl"
        role="dialog"
        aria-labelledby="settings-title"
      >
        <div
          className="flex shrink-0 items-center justify-between border-b px-5 py-4"
          style={{ borderColor: "var(--border)" }}
        >
          <h2
            id="settings-title"
            className="text-lg font-semibold"
            style={{ color: "var(--text)" }}
          >
            {t("nav.settings")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 hover:bg-[var(--bg-hover)]"
            style={{ color: "var(--text-muted)" }}
            aria-label={t("settings.closeAria")}
          >
            <IconX size={18} />
          </button>
        </div>

        <div
          className="settings-tabs mx-4 mt-3 shrink-0"
          role="tablist"
          aria-label={t("settings.tabsAria")}
        >
          {SETTINGS_TABS.map((tabDef) => (
            <button
              key={tabDef.id}
              type="button"
              role="tab"
              aria-selected={tab === tabDef.id}
              className={`settings-tab${tab === tabDef.id ? " active" : ""}`}
              onClick={() => setTab(tabDef.id)}
            >
              {t(tabDef.labelKey)}
            </button>
          ))}
        </div>

        <div
          className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-2"
          role="tabpanel"
        >
          {tab === "general" && (
            <div className="space-y-4">
              <div
                className="flex items-center justify-between gap-3 rounded-lg border p-3"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--bg-elevated)",
                }}
              >
                <div>
                  <h3
                    className="text-sm font-medium"
                    style={{ color: "var(--text)" }}
                  >
                    {t("lang.label")}
                  </h3>
                  <p
                    className="mt-0.5 text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    English · Deutsch · Türkçe · Español · العربية · 中文 …
                  </p>
                </div>
                <LanguageSwitcher />
              </div>
              <div
                className="rounded-lg border p-3"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--bg-elevated)",
                }}
              >
                <h3
                  className="mb-2 text-sm font-medium"
                  style={{ color: "var(--text)" }}
                >
                  {t("accent.label")}
                </h3>
                <div className="flex flex-wrap gap-2">
                  {ACCENTS.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => {
                        setAccent(a.id);
                        saveAccent(a.id);
                      }}
                      title={a.label}
                      aria-label={a.label}
                      aria-pressed={accent === a.id}
                      className="accent-swatch"
                      style={{
                        background: a.color,
                        outline:
                          accent === a.id
                            ? "2px solid var(--text)"
                            : "2px solid transparent",
                      }}
                    />
                  ))}
                </div>
              </div>
              <div
                className="rounded-lg border p-3"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--bg-elevated)",
                }}
              >
                <h3
                  className="mb-2 text-sm font-medium"
                  style={{ color: "var(--text)" }}
                >
                  {t("density.label")}
                </h3>
                <div className="flex gap-2">
                  {(["cozy", "compact"] as DensityId[]).map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => {
                        setDensity(d);
                        saveDensity(d);
                      }}
                      aria-pressed={density === d}
                      className="flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors"
                      style={{
                        borderColor:
                          density === d ? "var(--accent)" : "var(--border)",
                        background:
                          density === d
                            ? "var(--accent-soft)"
                            : "var(--bg-sidebar)",
                        color:
                          density === d ? "var(--accent)" : "var(--text)",
                      }}
                    >
                      {d === "cozy" ? t("density.cozy") : t("density.compact")}
                    </button>
                  ))}
                </div>
                <p
                  className="mt-2 text-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  {t("density.desc")}
                </p>
              </div>
              <div
                className="rounded-lg border p-3"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--bg-elevated)",
                }}
              >
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <h3
                      className="text-sm font-medium"
                      style={{ color: "var(--text)" }}
                    >
                      {t("settings.productStatus")}
                    </h3>
                    <p
                      className="mt-0.5 text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {t("settings.productStatusDesc")}
                    </p>
                  </div>
                  {serverStatus ? (
                    <span
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium"
                      style={{
                        background: productionReady
                          ? "var(--accent-soft)"
                          : "var(--warning-soft)",
                        color: productionReady ? "var(--accent)" : "var(--warning)",
                      }}
                    >
                      {productionReady ? (
                        <IconShieldCheck size={14} />
                      ) : (
                        <IconAlertTriangle size={14} />
                      )}
                      {productionReady ? t("settings.prodReady") : t("settings.hardeningOpen")}
                    </span>
                  ) : (
                    <span
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      <IconRefreshCw size={14} />
                      {t("settings.checking")}
                    </span>
                  )}
                </div>
                {serverStatus ? (
                  <div className="space-y-2">
                    <StatusRow
                      ok={serverStatus.profile === "production"}
                      label={t("settings.label.profile")}
                      value={serverStatus.profile}
                    />
                    <StatusRow
                      ok={
                        serverStatus.state.mode === "persistent" &&
                        serverStatus.state.writable
                      }
                      label={t("settings.label.serverState")}
                      value={
                        serverStatus.state.mode === "persistent"
                          ? "persistent"
                          : t("settings.val.ephemeral")
                      }
                    />
                    <StatusRow
                      ok={serverStatus.registration.mode !== "open"}
                      label={t("settings.label.registration")}
                      value={serverStatus.registration.mode}
                    />
                    <StatusRow
                      ok={!serverStatus.privacy.urlTokenAuthEnabled}
                      label={t("settings.label.wsToken")}
                      value={
                        serverStatus.privacy.urlTokenAuthEnabled
                          ? t("settings.val.urlAllowed")
                          : t("settings.val.authFrameOnly")
                      }
                    />
                    <StatusRow
                      ok={!serverStatus.privacy.messageContentPersistentOnServer}
                      label={t("settings.label.serverMsgContent")}
                      value={
                        serverStatus.privacy.messageContentPersistentOnServer
                          ? t("settings.val.persisted")
                          : t("settings.val.notPersisted")
                      }
                    />
                  </div>
                ) : (
                  <p
                    className="text-xs"
                    style={{
                      color: serverStatusError ? "var(--danger)" : "var(--text-muted)",
                    }}
                  >
                    {serverStatusError
                      ? t("settings.statusUnavailable", { err: serverStatusError })
                      : t("settings.statusLoading")}
                  </p>
                )}
              </div>

              <div
                className="rounded-lg border p-3"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--bg-elevated)",
                }}
              >
                <h3
                  className="mb-2 text-sm font-medium"
                  style={{ color: "var(--text)" }}
                >
                  {t("settings.appearance")}
                </h3>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
                    {t("settings.lightDark")}
                  </span>
                  <ThemeToggle />
                </div>
              </div>

              {installAvailable && (
                <div
                  className="rounded-lg border p-3"
                  style={{
                    borderColor: "var(--accent)",
                    background: "var(--accent-soft)",
                  }}
                >
                  <h3
                    className="mb-1 text-sm font-medium"
                    style={{ color: "var(--text)" }}
                  >
                    {t("settings.installTitle")}
                  </h3>
                  <p
                    className="mb-2.5 text-xs leading-relaxed"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {t("settings.installDesc")}
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary !px-3 !py-1.5 !text-xs"
                    onClick={() => void promptInstall()}
                  >
                    {t("settings.installButton")}
                  </button>
                </div>
              )}

              <div
                className="rounded-lg border p-3"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--bg-elevated)",
                }}
              >
                <h3
                  className="mb-2 text-sm font-medium"
                  style={{ color: "var(--text)" }}
                >
                  {t("settings.deviceKeys")}
                </h3>
                <p className="text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                  {t("settings.deviceKeysDesc")}
                </p>
                {myFingerprint && (
                  <p
                    className="mt-3 break-all font-mono text-xs"
                    style={{ color: "var(--accent)" }}
                  >
                    {t("settings.publicFingerprint")} {myFingerprint}
                  </p>
                )}
              </div>

              <div
                className="rounded-lg border p-3"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--bg-elevated)",
                }}
              >
                <h3
                  className="mb-2 text-sm font-medium"
                  style={{ color: "var(--text)" }}
                >
                  {t("settings.dataBackup")}
                </h3>
                <button
                  type="button"
                  onClick={onExportBackup}
                  className="w-full rounded-lg px-3 py-2 text-sm font-medium transition-colors"
                  style={{
                    background: "var(--accent-soft)",
                    color: "var(--accent)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {t("settings.downloadBackup")}
                </button>
              </div>
            </div>
          )}

          {tab === "privacy" && (
            <div className="space-y-4">
              <div
                className="rounded-lg border p-3"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--bg-elevated)",
                }}
              >
                <h3
                  className="mb-1 text-sm font-medium"
                  style={{ color: "var(--text)" }}
                >
                  {t("settings.serverSeesTitle")}
                </h3>
                <p
                  className="mb-3 text-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  {t("settings.serverSeesDesc")}
                </p>
                <ul className="space-y-1.5">
                  {[
                    { ok: true, label: t("privacy.see.content") },
                    { ok: true, label: t("privacy.see.calls") },
                    { ok: true, label: t("privacy.see.voiceMembers") },
                    { ok: true, label: t("privacy.see.ip") },
                    { ok: true, label: t("privacy.see.email") },
                    { ok: false, label: t("privacy.see.dmRecipient") },
                    { ok: false, label: t("privacy.see.groupMembers") },
                    { ok: false, label: t("privacy.see.online") },
                    { ok: false, label: t("privacy.see.groupNames") },
                  ].map((row, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs">
                      <span
                        aria-hidden
                        style={{
                          color: row.ok ? "var(--success)" : "var(--warning)",
                          flexShrink: 0,
                          marginTop: 1,
                        }}
                      >
                        {row.ok ? (
                          <IconShieldCheck size={14} />
                        ) : (
                          <IconAlertTriangle size={14} />
                        )}
                      </span>
                      <span style={{ color: "var(--text-secondary)" }}>
                        <strong
                          style={{
                            color: row.ok ? "var(--success)" : "var(--warning)",
                          }}
                        >
                          {row.ok ? t("settings.protected") : t("settings.visible")}
                        </strong>
                        {row.label}
                      </span>
                    </li>
                  ))}
                </ul>
                <p
                  className="mt-3 text-[11px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {t("settings.coverTrafficNote")}
                </p>
              </div>
              <div
                className="rounded-lg border p-3"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--bg-elevated)",
                }}
              >
                <h3
                  className="mb-1 text-sm font-medium"
                  style={{ color: "var(--text)" }}
                >
                  {t("settings.disappearing")}
                </h3>
                <p
                  className="mb-2 text-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  {t("settings.disappearingDesc")}
                </p>
                <select
                  value={defaultTtl}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setDefaultTtl(next);
                    saveDefaultTtl(next);
                  }}
                  className="app-input w-full !py-2 text-sm"
                  aria-label={t("settings.defaultExpiryAria")}
                >
                  {DEFAULT_TTL_OPTIONS.map((opt) => (
                    <option key={opt.ms} value={opt.ms}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div
                className="rounded-lg border p-3"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--bg-elevated)",
                }}
              >
                <h3
                  className="mb-2 text-sm font-medium"
                  style={{ color: "var(--text)" }}
                >
                  {t("settings.metadataCalls")}
                </h3>
                <label
                  className="flex cursor-pointer items-start gap-3 text-sm"
                  style={{ color: "var(--text-secondary)" }}
                >
                  <input
                    type="checkbox"
                    checked={relayOnly}
                    onChange={(e) => onRelayOnlyChange?.(e.target.checked)}
                    className="mt-1"
                  />
                  <span>
                    {t("settings.relayOnly")}
                    <span
                      className="mt-0.5 block text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {t("settings.relayOnlyDesc")}
                    </span>
                  </span>
                </label>
                <label
                  className="mt-3 flex cursor-pointer items-start gap-3 text-sm"
                  style={{ color: "var(--text-secondary)" }}
                >
                  <input
                    type="checkbox"
                    checked={sendTypingIndicators}
                    onChange={(e) =>
                      onSendTypingIndicatorsChange?.(e.target.checked)
                    }
                    className="mt-1"
                  />
                  <span>
                    {t("settings.typingIndicators")}
                    <span
                      className="mt-0.5 block text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {t("settings.typingDesc")}
                    </span>
                  </span>
                </label>
                <label
                  className="mt-3 flex cursor-pointer items-start gap-3 text-sm"
                  style={{ color: "var(--text-secondary)" }}
                >
                  <input
                    type="checkbox"
                    checked={sendReadReceipts}
                    onChange={(e) =>
                      onSendReadReceiptsChange?.(e.target.checked)
                    }
                    className="mt-1"
                  />
                  <span>
                    {t("settings.readReceipts")}
                    <span
                      className="mt-0.5 block text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {t("settings.readReceiptsDesc")}
                    </span>
                  </span>
                </label>
                <label
                  className="mt-3 flex cursor-pointer items-start gap-3 text-sm"
                  style={{ color: "var(--text-secondary)" }}
                >
                  <input
                    type="checkbox"
                    checked={sealedGroup}
                    onChange={(e) => setSealedGroupStored(e.target.checked)}
                    className="mt-1"
                  />
                  <span>
                    {t("settings.sealedGroup")}
                    <span
                      className="mt-0.5 block text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {t("settings.sealedGroupDesc")}
                    </span>
                  </span>
                </label>
              </div>

              <div
                className="rounded-lg border p-3"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--bg-elevated)",
                }}
              >
                <h3
                  className="mb-2 text-sm font-medium"
                  style={{ color: "var(--text)" }}
                >
                  {t("settings.desktopNotify")}
                </h3>
                {notifyPermission === "unsupported" ? (
                  <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                    {t("settings.notifyUnsupported")}
                  </p>
                ) : (
                  <>
                    <p
                      className="mb-3 text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {t("settings.notifyPermLabel")}{" "}
                      <span className="font-medium" style={{ color: "var(--text-secondary)" }}>
                        {notifyPermission === "granted"
                          ? t("settings.permGranted")
                          : notifyPermission === "denied"
                            ? t("settings.permDenied")
                            : t("settings.permUnset")}
                      </span>
                    </p>
                    {notifyPermission !== "granted" && (
                      <button
                        type="button"
                        className="mb-3 w-full rounded-lg border px-3 py-2 text-sm font-medium transition-colors"
                        style={{
                          borderColor: "var(--border)",
                          color: "var(--text)",
                          background: "var(--bg-sidebar)",
                        }}
                        onClick={requestNotifyPermission}
                      >
                        {t("settings.requestPerm")}
                      </button>
                    )}
                    <label
                      className="flex cursor-pointer items-start gap-3 text-sm"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      <input
                        type="checkbox"
                        checked={desktopNotify}
                        onChange={(e) =>
                          setDesktopNotifyStored(e.target.checked)
                        }
                        className="mt-1"
                      />
                      <span>
                        {t("settings.notifyOnNew")}
                        <span
                          className="mt-0.5 block text-xs"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {t("settings.notifyOnNewDesc")}
                        </span>
                      </span>
                    </label>
                    <div className="mt-3">
                      <p
                        className="text-sm"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {t("settings.notifyPreview")}
                      </p>
                      <p
                        className="mt-0.5 mb-2 text-xs"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {t("settings.notifyPreviewModeDesc")}
                      </p>
                      <div className="space-y-1.5">
                        {NOTIFY_PREVIEW_OPTIONS.map((opt) => (
                          <label
                            key={opt.mode}
                            className="flex cursor-pointer items-center gap-3 text-sm"
                            style={{ color: "var(--text-secondary)" }}
                          >
                            <input
                              type="radio"
                              name="notify-preview-mode"
                              checked={notifyPreviewMode === opt.mode}
                              onChange={() =>
                                setNotifyPreviewModeStored(opt.mode)
                              }
                              disabled={!desktopNotify}
                              className="disabled:opacity-40"
                            />
                            <span>{t(opt.labelKey)}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>

              <div
                className="rounded-lg border p-3"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--bg-elevated)",
                }}
              >
                <h3
                  className="mb-1 text-sm font-medium"
                  style={{ color: "var(--text)" }}
                >
                  {t("settings.blockedTitle")}
                </h3>
                <p
                  className="mb-3 text-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  {t("settings.blockedDesc")}
                </p>
                {blockedContacts.length === 0 ? (
                  <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                    {t("settings.blockedEmpty")}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {blockedContacts.map((c) => (
                      <li
                        key={c.id}
                        className="flex items-center justify-between gap-2"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold text-white"
                            style={{ background: "var(--text-muted)" }}
                          >
                            {c.username.slice(0, 1).toUpperCase()}
                          </span>
                          <span
                            className="truncate text-sm"
                            style={{ color: "var(--text)" }}
                          >
                            {c.username}
                          </span>
                        </span>
                        <button
                          type="button"
                          className="shrink-0 rounded-lg border px-3 py-1 text-xs font-medium transition-colors"
                          style={{
                            borderColor: "var(--border)",
                            color: "var(--text)",
                            background: "var(--bg-sidebar)",
                          }}
                          onClick={() => onUnblockContact?.(c.id)}
                        >
                          {t("chat.unblock")}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {tab === "security" && (
            <div className="space-y-4">
              {desktop && (
                <div
                  className="rounded-lg border p-3"
                  style={{
                    borderColor: "var(--border)",
                    background: "var(--bg-elevated)",
                  }}
                >
                  <label
                    className="flex cursor-pointer items-start gap-3 text-sm"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    <input
                      type="checkbox"
                      checked={screenSec}
                      onChange={(e) => {
                        const next = e.target.checked;
                        setScreenSec(next);
                        void setScreenSecurity(next);
                      }}
                      className="mt-1"
                    />
                    <span>
                      {t("settings.screenSecurity")}
                      <span
                        className="mt-0.5 block text-xs"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {t("settings.screenSecurityDesc")}
                      </span>
                    </span>
                  </label>
                </div>
              )}
              <div>
                <label
                  className="mb-2 block text-sm font-medium"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {t("settings.securityLevel")}
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => handleLevelChange("normal")}
                    className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                      level === "normal"
                        ? "bg-emerald-600 text-white"
                        : "bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                    }`}
                  >
                    {t("settings.levelNormal")}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleLevelChange("extreme")}
                    className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                      level === "extreme"
                        ? "bg-red-600 text-white"
                        : "bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                    }`}
                  >
                    {t("settings.levelExtreme")}
                  </button>
                </div>
              </div>

              <div className="rounded-lg p-3" style={{ background: "var(--bg-elevated)" }}>
                {level === "normal" ? (
                  <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                    <strong style={{ color: "var(--accent)" }}>{t("settings.levelNormal")}:</strong>{" "}
                    {t("settings.levelNormalBody")}
                  </p>
                ) : (
                  <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                    <strong style={{ color: "var(--danger)" }}>{t("settings.levelExtreme")}:</strong>{" "}
                    {t("settings.levelExtremeBody")}
                  </p>
                )}
              </div>

              <div>
                <label
                  className="mb-2 block text-sm font-medium"
                  style={{ color: "var(--text-secondary)" }}
                  htmlFor="auto-lock-select"
                >
                  {t("settings.autoLock")}
                </label>
                <select
                  id="auto-lock-select"
                  value={autoLockMinutes}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setAutoLockMinutes(next);
                    saveAutoLockMinutes(next);
                  }}
                  className="app-input w-full !py-2 text-sm"
                >
                  <option value={0}>{t("time.off")}</option>
                  <option value={1}>{t("time.min1")}</option>
                  <option value={5}>{t("time.min5")}</option>
                  <option value={10}>{t("time.min10default")}</option>
                  <option value={30}>{t("time.min30")}</option>
                  <option value={60}>{t("time.hour1")}</option>
                </select>
                <p
                  className="mt-1 text-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  {t("settings.autoLockDesc")}
                </p>
              </div>

              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => void handleImmediateWipe()}
                  className="w-full rounded-lg px-3 py-2 text-sm font-medium transition-colors"
                  style={{
                    background: "var(--bg-elevated)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {t("settings.wipeNow")}
                </button>

                <button
                  type="button"
                  onClick={handleResetReplayProtection}
                  className="w-full rounded-lg px-3 py-2 text-sm font-medium transition-colors"
                  style={{
                    background: "var(--bg-elevated)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {t("settings.resetReplay")}
                </button>
              </div>

              <div
                className="border-t pt-3"
                style={{ borderColor: "var(--border)" }}
              >
                <h3
                  className="mb-2 text-sm font-medium"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {t("settings.statusHeading")}
                </h3>
                <div className="space-y-1 text-xs" style={{ color: "var(--text-muted)" }}>
                  <p>{t("settings.replayCache", { n: replayStats.stored })}</p>
                  <p>{t("settings.timeWindow", { n: (replayStats.windowMs / 60000).toFixed(0) })}</p>
                </div>
              </div>

              {level === "extreme" && (
                <div
                  className="rounded-lg p-3"
                  style={{
                    background: "var(--danger-soft)",
                    border: "1px solid var(--danger)",
                  }}
                >
                  <p className="text-xs" style={{ color: "var(--danger)" }}>
                    {t("settings.extremePerf")}
                  </p>
                </div>
              )}
              <ZkgroupExperimentalSection />
              <AccountDangerZone />
            </div>
          )}

          {tab === "emojis" && <EmojiSettingsTab />}

          {tab === "plan" && <PlanSettingsTab />}

          {tab === "about" && (
            <div className="space-y-4">
              <div>
                <p className="text-base font-semibold" style={{ color: "var(--text)" }}>
                  Umbra
                </p>
                <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                  Version {appVersion} · {import.meta.env.MODE === "production" ? "Production" : "Development"}
                </p>
              </div>
              <ul
                className="list-inside list-disc space-y-2 text-sm"
                style={{ color: "var(--text-secondary)" }}
              >
                <li>{t("about.feat.e2ee")}</li>
                <li>{t("about.feat.sealedSender")}</li>
                <li>{t("about.feat.tofu")}</li>
                <li>{t("about.feat.groupE2ee")}</li>
                <li>{t("about.feat.qr")}</li>
                <li>{t("about.feat.threads")}</li>
              </ul>
              <a
                href="https://github.com/Mozaio/vaultchat"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition"
                style={{
                  borderColor: "var(--border)",
                  color: "var(--text-secondary)",
                  textDecoration: "none",
                }}
              >
                {t("about.sourceCode")}
              </a>
              <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
                {t("about.serverNote")}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ZkgroupExperimentalSection() {
  useLocale();
  const [enabled, setEnabled] = useState(() => isZkgroupExperimentalEnabled());
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<ZkgroupProbe | null>(null);

  const runProbe = async () => {
    setBusy(true);
    setProbe(null);
    const result = await probeZkgroup();
    setProbe(result);
    setBusy(false);
  };

  return (
    <div className="border-t pt-3" style={{ borderColor: "var(--border)" }}>
      <h3
        className="mb-1 text-sm font-medium"
        style={{ color: "var(--text-secondary)" }}
      >
        {t("settings.zkgroupHeading")}
      </h3>
      <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>
        {t("settings.zkgroupDesc")}
      </p>
      <label
        className="flex cursor-pointer items-start gap-3 text-sm"
        style={{ color: "var(--text-secondary)" }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setZkgroupExperimentalEnabled(e.target.checked);
            setEnabled(e.target.checked);
            setProbe(null);
          }}
          className="mt-1"
        />
        <span>{t("settings.zkgroupToggle")}</span>
      </label>
      {enabled && (
        <div className="mt-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void runProbe()}
            className="w-full rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--bg-elevated)",
              color: "var(--text-secondary)",
            }}
          >
            {busy ? t("settings.zkgroupTesting") : t("settings.zkgroupSelfTest")}
          </button>
          {probe && (
            <p
              className="mt-2 text-xs"
              style={{
                color: probe.selfTest ? "var(--accent)" : "var(--danger)",
              }}
            >
              {probe.selfTest
                ? t("settings.zkgroupOk", { version: probe.version ?? "?" })
                : t("settings.zkgroupFail", {
                    reason: probe.reason ?? "unknown",
                  })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function AccountDangerZone() {
  useLocale();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requiredPhrase = t("settings.deletePhrase");

  async function handleDelete() {
    setError(null);
    setBusy(true);
    try {
      const token = (await import("../lib/localIdentity")).loadToken();
      if (!token) throw new Error("no_token");
      const { deleteMyAccount } = await import("../lib/api");
      await deleteMyAccount(token);
      // Server gelöscht — jetzt alles lokal wipen und reloaden.
      const li = await import("../lib/localIdentity");
      li.clearToken();
      li.clearLocalIdentity();
      try {
        await new Promise<void>((resolve) => {
          const r = indexedDB.deleteDatabase("vaultchat");
          r.onsuccess = () => resolve();
          r.onerror = () => resolve();
          r.onblocked = () => resolve();
        });
      } catch {
        /* best effort */
      }
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        /* noop */
      }
      location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="rounded-xl border p-4"
      style={{
        borderColor: "var(--danger)",
        background: "var(--danger-soft)",
        marginTop: "1.5rem",
      }}
    >
      <p className="text-sm font-semibold" style={{ color: "var(--danger)" }}>
        {t("settings.dangerZone")}
      </p>
      <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>
        {t("settings.dangerZoneDesc")}
      </p>
      {!confirming ? (
        <button
          type="button"
          className="mt-3 rounded-lg px-3 py-2 text-sm font-medium"
          style={{ background: "var(--danger-soft)", color: "var(--danger)", border: "1px solid var(--danger)" }}
          onClick={() => setConfirming(true)}
        >
          {t("settings.deleteAccount")}
        </button>
      ) : (
        <div className="mt-3 space-y-2">
          <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
            {t("settings.deleteConfirmPrompt")}{" "}
            <code style={{ color: "var(--danger)" }}>{requiredPhrase}</code>
          </p>
          <input
            type="text"
            className="w-full rounded-lg border px-3 py-2 text-sm"
            style={{
              borderColor: "var(--border)",
              background: "var(--bg-elevated)",
              color: "var(--text)",
            }}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={requiredPhrase}
            autoFocus
            disabled={busy}
          />
          {error && (
            <p className="text-xs" style={{ color: "var(--danger)" }}>
              {t("common.error")}: {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="flex-1 rounded-lg px-3 py-2 text-sm font-medium"
              style={{ background: "var(--bg-elevated)", color: "var(--text)" }}
              onClick={() => {
                setConfirming(false);
                setTyped("");
                setError(null);
              }}
              disabled={busy}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="flex-1 rounded-lg px-3 py-2 text-sm font-medium"
              style={{ background: "var(--danger)", color: "white" }}
              onClick={() => void handleDelete()}
              disabled={busy || typed !== requiredPhrase}
            >
              {busy ? t("settings.deleting") : t("settings.deleteForever")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function EmojiSettingsTab() {
  useLocale();
  const [emojis, setEmojis] = useState<CustomEmoji[]>(() => loadCustomEmojis());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const plan = loadPlan();
  const limit = PLAN_LIMITS[plan].customEmojiMax;
  const remaining = Math.max(0, limit - emojis.length);
  const usagePercent = Math.min(100, Math.round((emojis.length / limit) * 100));

  async function handleAdd(file: File) {
    setError(null);
    setBusy(true);
    try {
      await addCustomEmojiFromFile(file);
      setEmojis(loadCustomEmojis());
    } catch (err) {
      const code = err instanceof Error ? err.message : "emoji_failed";
      setError(
        code === "emoji_invalid_type"
          ? t("emoji.errType")
          : code === "emoji_too_large"
            ? t("emoji.errTooLarge")
            : t("emoji.errGeneric")
      );
    } finally {
      setBusy(false);
    }
  }

  function handleRemove(id: string) {
    removeCustomEmoji(id);
    setEmojis(loadCustomEmojis());
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-base font-semibold" style={{ color: "var(--text)" }}>
          {t("emoji.custom")}
        </p>
        <p
          className="mt-1 text-xs leading-relaxed"
          style={{ color: "var(--text-muted)" }}
        >
          {t("emoji.settings.desc")}
        </p>
      </div>

      <button
        type="button"
        className="emoji-picker-upload"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        style={{ width: "100%" }}
      >
        {busy ? t("emoji.uploading") : t("emoji.settings.addBtn")}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleAdd(f);
          e.target.value = "";
        }}
      />
      {error && (
        <p className="text-xs" style={{ color: "var(--danger, #ef4444)" }}>
          {error}
        </p>
      )}

      {emojis.length === 0 ? (
        <p
          className="rounded-lg border p-4 text-center text-xs"
          style={{
            borderColor: "var(--border)",
            color: "var(--text-muted)",
          }}
        >
          {t("emoji.settings.empty")}
        </p>
      ) : (
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))" }}
        >
          {emojis.map((e) => (
            <div
              key={e.id}
              className="emoji-settings-cell"
              title={e.name}
            >
              <img src={e.dataUrl} alt={e.name} />
              <span className="emoji-settings-name">{e.name}</span>
              <button
                type="button"
                onClick={() => handleRemove(e.id)}
                className="emoji-settings-remove"
                aria-label={t("emoji.remove", { name: e.name })}
                title={t("common.remove")}
              >
                <IconX size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div
        className="rounded-lg border p-3"
        style={{
          borderColor: usagePercent >= 90 ? "var(--accent)" : "var(--border)",
          background:
            usagePercent >= 90 ? "var(--accent-soft)" : "var(--bg-elevated)",
        }}
      >
        <div className="flex items-center justify-between text-xs mb-1.5">
          <span style={{ color: "var(--text-secondary)" }}>
            {t("emoji.settings.usage", {
              used: emojis.length,
              limit,
              plan: PLAN_LABELS[plan],
            })}
          </span>
          <span
            style={{
              color: remaining <= 2 ? "var(--accent)" : "var(--text-muted)",
              fontWeight: 600,
            }}
          >
            {remaining === 0
              ? t("emoji.settings.limitReached")
              : t("emoji.settings.remaining", { n: remaining })}
          </span>
        </div>
        <div
          className="h-1.5 rounded-full overflow-hidden"
          style={{ background: "var(--bg-sidebar)" }}
        >
          <div
            className="h-full transition-all"
            style={{
              width: `${usagePercent}%`,
              background:
                usagePercent >= 90 ? "var(--accent)" : "var(--text-secondary)",
            }}
          />
        </div>
        {plan === "free" && remaining <= 4 && (
          <p
            className="mt-2 text-xs"
            style={{ color: "var(--text-secondary)" }}
          >
            {t("emoji.settings.proUpsell")}
          </p>
        )}
      </div>

      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        {t("emoji.settings.sizeNote")}
      </p>
    </div>
  );
}

function PlanSettingsTab() {
  useLocale();
  const [plan, setPlan] = useState<PlanId>(() => loadPlan());

  function activate(next: PlanId) {
    setPlanLocal(next);
    setPlan(next);
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-base font-semibold" style={{ color: "var(--text)" }}>
          {t("plan.title")}
        </p>
        <p
          className="mt-1 text-xs leading-relaxed"
          style={{ color: "var(--text-muted)" }}
        >
          {t("plan.intro")}
        </p>
        <p
          className="mt-2 text-xs"
          style={{ color: "var(--accent)" }}
        >
          {t("plan.current")} <strong>{PLAN_LABELS[plan]}</strong>
        </p>
      </div>

      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        }}
      >
        {(["free", "pro", "team"] as PlanId[]).map((id) => {
          const isCurrent = plan === id;
          const price = PLAN_PRICES[id];
          return (
            <div
              key={id}
              className={`pricing-card${isCurrent ? " current" : ""}${id === "pro" ? " featured" : ""}`}
            >
              {id === "pro" && (
                <span className="pricing-card-tag">{t("plan.popular")}</span>
              )}
              <p className="pricing-card-name">{PLAN_LABELS[id]}</p>
              <p className="pricing-card-price">
                {price.eurMonthly === 0 ? (
                  <span>{t("plan.free")}</span>
                ) : (
                  <>
                    <strong>{price.eurMonthly} €</strong>
                    <span className="pricing-card-period">{t("plan.perMonth")}</span>
                  </>
                )}
              </p>
              <p className="pricing-card-audience">{t(price.audience)}</p>
              <ul className="pricing-card-features">
                {PLAN_FEATURE_KEYS[id].map((f) => (
                  <li key={f}>{t(f)}</li>
                ))}
              </ul>
              <button
                type="button"
                disabled={isCurrent}
                onClick={() => activate(id)}
                className="pricing-card-cta"
              >
                {isCurrent
                  ? t("plan.currentPlan")
                  : id === "free"
                    ? t("plan.switch")
                    : t("plan.upgrade")}
              </button>
              {id !== "free" && (
                <p className="pricing-card-note">
                  {t("plan.demoNote")}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        {t("plan.privacyNote")}
      </p>
    </div>
  );
}

function StatusRow({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs"
      style={{ borderColor: "var(--border)", background: "var(--bg)" }}
    >
      <span className="inline-flex min-w-0 items-center gap-2" style={{ color: "var(--text-secondary)" }}>
        {ok ? (
          <IconCheck size={14} style={{ color: "var(--accent)", flexShrink: 0 }} />
        ) : (
          <IconAlertTriangle size={14} style={{ color: "var(--warning)", flexShrink: 0 }} />
        )}
        <span className="truncate">{label}</span>
      </span>
      <span
        className="max-w-[45%] truncate font-mono"
        style={{ color: ok ? "var(--accent)" : "var(--warning)" }}
      >
        {value}
      </span>
    </div>
  );
}
