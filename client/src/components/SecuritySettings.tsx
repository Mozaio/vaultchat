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
import {
  loadCustomEmojis,
  removeCustomEmoji,
  addCustomEmojiFromFile,
  type CustomEmoji,
} from "../lib/customEmojis";

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

type SettingsTabId = "general" | "privacy" | "security" | "emojis" | "about";

const SETTINGS_TABS: { id: SettingsTabId; label: string }[] = [
  { id: "general", label: "Allgemein" },
  { id: "privacy", label: "Datenschutz" },
  { id: "security", label: "Sicherheit" },
  { id: "emojis", label: "Emojis" },
  { id: "about", label: "Über" },
];

function readNotifyEnabled(): boolean {
  try {
    return localStorage.getItem(NOTIFY_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

function readNotifyPreview(): boolean {
  try {
    return localStorage.getItem(NOTIFY_PREVIEW_STORAGE_KEY) !== "off";
  } catch {
    return true;
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
}: SecuritySettingsProps) {
  const [tab, setTab] = useState<SettingsTabId>("general");
  const [level, setLevel] = useState<SecurityLevel>(loadSecurityLevel);
  const [autoLockMinutes, setAutoLockMinutes] = useState<number>(() =>
    loadAutoLockMinutes()
  );
  const [defaultTtl, setDefaultTtl] = useState<number>(() => loadDefaultTtl());
  const [replayStats, setReplayStats] = useState(getReplayStats());
  const [desktopNotify, setDesktopNotify] = useState(readNotifyEnabled);
  const [notifyPreview, setNotifyPreview] = useState(readNotifyPreview);
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

  const setNotifyPreviewStored = (enabled: boolean) => {
    setNotifyPreview(enabled);
    try {
      if (enabled) localStorage.removeItem(NOTIFY_PREVIEW_STORAGE_KEY);
      else localStorage.setItem(NOTIFY_PREVIEW_STORAGE_KEY, "off");
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div
        className="app-surface flex max-h-[min(90vh,720px)] w-full max-w-lg flex-col rounded-2xl p-0 shadow-xl"
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
            Einstellungen
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 hover:bg-[var(--bg-hover)]"
            style={{ color: "var(--text-muted)" }}
            aria-label="Einstellungen schließen"
          >
            <IconX size={18} />
          </button>
        </div>

        <div
          className="settings-tabs mx-4 mt-3 shrink-0"
          role="tablist"
          aria-label="Einstellungsbereiche"
        >
          {SETTINGS_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`settings-tab${tab === t.id ? " active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
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
                      Produktstatus
                    </h3>
                    <p
                      className="mt-0.5 text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Server- und Datenschutz-Gates für den produktiven Betrieb.
                    </p>
                  </div>
                  {serverStatus ? (
                    <span
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium"
                      style={{
                        background: productionReady
                          ? "var(--accent-soft)"
                          : "rgba(245, 158, 11, 0.12)",
                        color: productionReady ? "var(--accent)" : "#f59e0b",
                      }}
                    >
                      {productionReady ? (
                        <IconShieldCheck size={14} />
                      ) : (
                        <IconAlertTriangle size={14} />
                      )}
                      {productionReady ? "Produktionsbereit" : "Härtung offen"}
                    </span>
                  ) : (
                    <span
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      <IconRefreshCw size={14} />
                      Prüfe
                    </span>
                  )}
                </div>
                {serverStatus ? (
                  <div className="space-y-2">
                    <StatusRow
                      ok={serverStatus.profile === "production"}
                      label="Profil"
                      value={serverStatus.profile}
                    />
                    <StatusRow
                      ok={
                        serverStatus.state.mode === "persistent" &&
                        serverStatus.state.writable
                      }
                      label="Server-State"
                      value={
                        serverStatus.state.mode === "persistent"
                          ? "persistent"
                          : "flüchtig"
                      }
                    />
                    <StatusRow
                      ok={serverStatus.registration.mode !== "open"}
                      label="Registrierung"
                      value={serverStatus.registration.mode}
                    />
                    <StatusRow
                      ok={!serverStatus.privacy.urlTokenAuthEnabled}
                      label="WebSocket-Token"
                      value={
                        serverStatus.privacy.urlTokenAuthEnabled
                          ? "URL erlaubt"
                          : "nur Auth-Frame"
                      }
                    />
                    <StatusRow
                      ok={!serverStatus.privacy.messageContentPersistentOnServer}
                      label="Server-Nachrichteninhalt"
                      value={
                        serverStatus.privacy.messageContentPersistentOnServer
                          ? "persistiert"
                          : "nicht persistiert"
                      }
                    />
                  </div>
                ) : (
                  <p
                    className="text-xs"
                    style={{
                      color: serverStatusError ? "#fca5a5" : "var(--text-muted)",
                    }}
                  >
                    {serverStatusError
                      ? `Status nicht verfügbar: ${serverStatusError}`
                      : "Status wird geladen."}
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
                  Erscheinungsbild
                </h3>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
                    Hell- / Dunkelmodus
                  </span>
                  <ThemeToggle />
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
                  Gerät & Schlüssel
                </h3>
                <p className="text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                  Dein VaultChat-Konto ist an dieses Gerät gebunden. Ohne
                  verschlüsseltes Backup gibt es auf einem neuen Gerät keinen
                  Zugriff auf bestehende Chats.
                </p>
                {myFingerprint && (
                  <p
                    className="mt-3 break-all font-mono text-xs"
                    style={{ color: "var(--accent)" }}
                  >
                    Öffentlicher Fingerprint: {myFingerprint}
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
                  Datensicherung
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
                  Verschlüsseltes Backup herunterladen
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
                  Verschwindende Nachrichten
                </h3>
                <p
                  className="mb-2 text-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  Standardwert für neue Chats. Bestehende Chats behalten ihre
                  individuelle Einstellung.
                </p>
                <select
                  value={defaultTtl}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setDefaultTtl(next);
                    saveDefaultTtl(next);
                  }}
                  className="app-input w-full !py-2 text-sm"
                  aria-label="Standardablaufzeit für neue Chats"
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
                  Metadaten & Anrufe
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
                    Anrufe nur über TURN (Relay)
                    <span
                      className="mt-0.5 block text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Verbirgt direkte Peer-Verbindungen, kann die Qualität
                      reduzieren.
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
                    Tippstatus senden
                    <span
                      className="mt-0.5 block text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Optional; ausgeschaltet weniger sichtbare Aktivität.
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
                    Lese- & Zustellbestätigungen senden
                    <span
                      className="mt-0.5 block text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      E2EE, verrät Kontakten aber deine Aktivität.
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
                  Desktop-Benachrichtigungen
                </h3>
                {notifyPermission === "unsupported" ? (
                  <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                    Werden von diesem Browser nicht unterstützt.
                  </p>
                ) : (
                  <>
                    <p
                      className="mb-3 text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Nur wenn der Tab im Hintergrund ist. Berechtigung:{" "}
                      <span className="font-medium" style={{ color: "var(--text-secondary)" }}>
                        {notifyPermission === "granted"
                          ? "erteilt"
                          : notifyPermission === "denied"
                            ? "verweigert"
                            : "noch nicht festgelegt"}
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
                        Browser-Berechtigung anfragen
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
                        Benachrichtigungen bei neuer Nachricht
                        <span
                          className="mt-0.5 block text-xs"
                          style={{ color: "var(--text-muted)" }}
                        >
                          Master-Schalter (unabhängig von der Browser-Freigabe).
                        </span>
                      </span>
                    </label>
                    <label
                      className="mt-3 flex cursor-pointer items-start gap-3 text-sm"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      <input
                        type="checkbox"
                        checked={notifyPreview}
                        onChange={(e) =>
                          setNotifyPreviewStored(e.target.checked)
                        }
                        disabled={!desktopNotify}
                        className="mt-1 disabled:opacity-40"
                      />
                      <span>
                        Textvorschau in der Benachrichtigung
                        <span
                          className="mt-0.5 block text-xs"
                          style={{ color: "var(--text-muted)" }}
                        >
                          Aus: nur „Neue Nachricht“ (weniger Inhalt auf dem
                          Sperrbildschirm).
                        </span>
                      </span>
                    </label>
                  </>
                )}
              </div>
            </div>
          )}

          {tab === "security" && (
            <div className="space-y-4">
              <div>
                <label
                  className="mb-2 block text-sm font-medium"
                  style={{ color: "var(--text-secondary)" }}
                >
                  Sicherheitsstufe (Speicher-Schutz)
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
                    Normal
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
                    Extrem
                  </button>
                </div>
              </div>

              <div className="rounded-lg p-3" style={{ background: "var(--bg-elevated)" }}>
                {level === "normal" ? (
                  <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                    <strong style={{ color: "var(--accent)" }}>Normal:</strong>{" "}
                    Standard Auto-Lock, moderate Memory-Wipe-Intervalle.
                  </p>
                ) : (
                  <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                    <strong style={{ color: "#ef4444" }}>Extrem:</strong>{" "}
                    Aggressives Wiping, häufiger Speicher-Zyklen.
                  </p>
                )}
              </div>

              <div>
                <label
                  className="mb-2 block text-sm font-medium"
                  style={{ color: "var(--text-secondary)" }}
                  htmlFor="auto-lock-select"
                >
                  Automatische Sperre nach
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
                  <option value={0}>Aus (nicht empfohlen)</option>
                  <option value={1}>1 Minute</option>
                  <option value={5}>5 Minuten</option>
                  <option value={10}>10 Minuten (Standard)</option>
                  <option value={30}>30 Minuten</option>
                  <option value={60}>1 Stunde</option>
                </select>
                <p
                  className="mt-1 text-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  Nach Inaktivität wird der lokale Schlüssel aus dem
                  Arbeitsspeicher gelöscht. Beim nächsten Mal brauchst du dein
                  Passwort.
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
                  Jetzt sensiblen Arbeitsspeicher wischen
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
                  Replay-Schutz zurücksetzen
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
                  Status
                </h3>
                <div className="space-y-1 text-xs" style={{ color: "var(--text-muted)" }}>
                  <p>Replay-Cache: {replayStats.stored} Einträge</p>
                  <p>Zeitfenster: {(replayStats.windowMs / 60000).toFixed(0)} Min.</p>
                </div>
              </div>

              {level === "extreme" && (
                <div
                  className="rounded-lg p-3"
                  style={{
                    background: "rgba(127, 29, 29, 0.3)",
                    border: "1px solid rgba(127, 29, 29, 0.5)",
                  }}
                >
                  <p className="text-xs" style={{ color: "#fca5a5" }}>
                    Extrem-Modus kann die Performance beeinträchtigen.
                  </p>
                </div>
              )}
            </div>
          )}

          {tab === "emojis" && <EmojiSettingsTab />}

          {tab === "about" && (
            <div className="space-y-4">
              <div>
                <p className="text-base font-semibold" style={{ color: "var(--text)" }}>
                  VaultChat
                </p>
                <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                  Version {appVersion} · {import.meta.env.MODE === "production" ? "Production" : "Development"}
                </p>
              </div>
              <ul
                className="list-inside list-disc space-y-2 text-sm"
                style={{ color: "var(--text-secondary)" }}
              >
                <li>Ende-zu-Ende-Verschlüsselung (Double-Ratchet, libsodium)</li>
                <li>Sealed Sender für Direktnachrichten</li>
                <li>TOFU &amp; verifizierbare Sicherheitsnummern</li>
                <li>Gruppennachrichten E2EE mit verteilten Schlüsseln</li>
                <li>QR-Code-Sicherheitsnummer (out-of-band-Verifikation)</li>
                <li>Threads in DMs &amp; Gruppen, Custom-Emoji-Reaktionen</li>
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
                Quellcode auf GitHub →
              </a>
              <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
                Server sieht Nachrichteninhalte und DM-Absender nicht. Gruppen-
                Frames enthalten nur ciphertext. Keine serverseitige
                Nachrichtenhistorie (RAM-only Demo-Backend).
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EmojiSettingsTab() {
  const [emojis, setEmojis] = useState<CustomEmoji[]>(() => loadCustomEmojis());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
          ? "Bitte ein Bild (PNG, JPEG, WebP, GIF) auswählen."
          : code === "emoji_too_large"
            ? "Bild zu groß — versuche ein kleineres Motiv."
            : "Konnte den Emoji nicht hinzufügen."
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
          Eigene Emojis
        </p>
        <p
          className="mt-1 text-xs leading-relaxed"
          style={{ color: "var(--text-muted)" }}
        >
          Lade Bilder hoch und nutze sie als Reaktionen. Sie liegen nur lokal
          auf deinem Gerät; beim Reagieren wird das Bild als data-URL
          mit dem verschlüsselten Frame mitgesendet — der Server sieht nichts.
        </p>
      </div>

      <button
        type="button"
        className="emoji-picker-upload"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        style={{ width: "100%" }}
      >
        {busy ? "Lade …" : "+ Eigenes Emoji hinzufügen"}
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
          Noch keine eigenen Emojis. Lade dein erstes hoch — z. B. ein Logo,
          Sticker oder Inside-Joke-Bild.
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
                aria-label={`„${e.name}“ entfernen`}
                title="Entfernen"
              >
                <IconX size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      <p
        className="text-xs"
        style={{ color: "var(--text-muted)" }}
      >
        Maximal 32 Emojis · Bilder werden auf 48×48 verkleinert (~2 KB)
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
          <IconAlertTriangle size={14} style={{ color: "#f59e0b", flexShrink: 0 }} />
        )}
        <span className="truncate">{label}</span>
      </span>
      <span
        className="max-w-[45%] truncate font-mono"
        style={{ color: ok ? "var(--accent)" : "#f59e0b" }}
      >
        {value}
      </span>
    </div>
  );
}
