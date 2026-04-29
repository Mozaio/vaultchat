/**
 * Security Settings Panel für VaultChat
 * 
 * Ermöglicht das Ein-/Ausschalten der erweiterten Sicherheitsfunktionen:
 * - Extreme Security Mode (aggressives Memory-Wiping, kürzere Intervalle)
 * - Replay-Schutz
 * - Code-Integrity-Pinning
 */
import { useState, useEffect } from "react";
import {
  startPeriodicWipe,
  immediateWipe,
  setSecurityMode,
} from "../lib/exfilProtection";
import {
  resetAllReplayProtection,
  getReplayStats,
} from "../lib/replayProtection";
import type { ServerStatus } from "../lib/api";
import {
  IconAlertTriangle,
  IconCheck,
  IconLock,
  IconRefreshCw,
  IconShieldCheck,
} from "./Icons";

export type SecurityLevel = "normal" | "extreme";

const SECURITY_STORAGE_KEY = "vaultchat.security.level";

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

/**
 * Security Settings Panel Component
 * Das Panel wird nur gerendert wenn es in ChatShell conditional gerendert wird
 */
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
  const [level, setLevel] = useState<SecurityLevel>(loadSecurityLevel);
  const [replayStats, setReplayStats] = useState(getReplayStats());

  useEffect(() => {
    // Update replay stats periodically
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
      // Extreme Mode: Start aggressive wiping
      startPeriodicWipe();
    } else {
      // Normal Mode: keep wiping enabled, only with less aggressive intervals.
      startPeriodicWipe();
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="app-surface max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold" style={{ color: "var(--text)" }}>
            <IconLock size={18} />
            Sicherheitseinstellungen
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 hover:bg-[var(--bg-hover)]"
            style={{ color: "var(--text-muted)" }}
          >
            x
          </button>
        </div>

        <div className="mb-4 rounded-lg border p-3" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium" style={{ color: "var(--text)" }}>
                Produktstatus
              </h3>
              <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
                Server- und Datenschutz-Gates fuer den produktiven Betrieb.
              </p>
            </div>
            {serverStatus ? (
              <span
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium"
                style={{
                  background: productionReady ? "var(--accent-soft)" : "rgba(245, 158, 11, 0.12)",
                  color: productionReady ? "var(--accent)" : "#f59e0b",
                }}
              >
                {productionReady ? <IconShieldCheck size={14} /> : <IconAlertTriangle size={14} />}
                {productionReady ? "Produktionsbereit" : "Haertung offen"}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs" style={{ color: "var(--text-muted)" }}>
                <IconRefreshCw size={14} />
                Pruefe
              </span>
            )}
          </div>
          {serverStatus ? (
            <div className="space-y-2">
              <StatusRow ok={serverStatus.profile === "production"} label="Profil" value={serverStatus.profile} />
              <StatusRow
                ok={serverStatus.state.mode === "persistent" && serverStatus.state.writable}
                label="Server-State"
                value={serverStatus.state.mode === "persistent" ? "persistent" : "fluechtig"}
              />
              <StatusRow
                ok={serverStatus.registration.mode !== "open"}
                label="Registrierung"
                value={serverStatus.registration.mode}
              />
              <StatusRow
                ok={!serverStatus.privacy.urlTokenAuthEnabled}
                label="WebSocket-Token"
                value={serverStatus.privacy.urlTokenAuthEnabled ? "URL erlaubt" : "nur Auth-Frame"}
              />
              <StatusRow
                ok={!serverStatus.privacy.messageContentPersistentOnServer}
                label="Server-Nachrichteninhalt"
                value={serverStatus.privacy.messageContentPersistentOnServer ? "persistiert" : "nicht persistiert"}
              />
            </div>
          ) : (
            <p className="text-xs" style={{ color: serverStatusError ? "#fca5a5" : "var(--text-muted)" }}>
              {serverStatusError
                ? `Status nicht verfuegbar: ${serverStatusError}`
                : "Status wird geladen."}
            </p>
          )}
        </div>

        <div className="mb-4 rounded-lg border p-3" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
          <h3 className="mb-2 text-sm font-medium" style={{ color: "var(--text)" }}>
            Datenschutz & Anrufe
          </h3>
          <label className="flex cursor-pointer items-start gap-3 text-sm" style={{ color: "var(--text-secondary)" }}>
            <input
              type="checkbox"
              checked={relayOnly}
              onChange={(e) => onRelayOnlyChange?.(e.target.checked)}
              className="mt-1"
            />
            <span>
              Anrufe nur über TURN (Relay) leiten
              <span className="mt-0.5 block text-xs" style={{ color: "var(--text-muted)" }}>
                Verbirgt direkte Peer-Verbindungen, kann aber die Sprachqualität reduzieren.
              </span>
            </span>
          </label>
          <label className="mt-3 flex cursor-pointer items-start gap-3 text-sm" style={{ color: "var(--text-secondary)" }}>
            <input
              type="checkbox"
              checked={sendTypingIndicators}
              onChange={(e) => onSendTypingIndicatorsChange?.(e.target.checked)}
              className="mt-1"
            />
            <span>
              Tippstatus senden
              <span className="mt-0.5 block text-xs" style={{ color: "var(--text-muted)" }}>
                Optionales Metadatum. Deaktivieren reduziert sichtbare Aktivitätsmuster.
              </span>
            </span>
          </label>
          <label className="mt-3 flex cursor-pointer items-start gap-3 text-sm" style={{ color: "var(--text-secondary)" }}>
            <input
              type="checkbox"
              checked={sendReadReceipts}
              onChange={(e) => onSendReadReceiptsChange?.(e.target.checked)}
              className="mt-1"
            />
            <span>
              Lese-/Zustellbestätigungen senden
              <span className="mt-0.5 block text-xs" style={{ color: "var(--text-muted)" }}>
                Bleibt Ende-zu-Ende verschlüsselt, verrät Kontakten aber Aktivität.
              </span>
            </span>
          </label>
          <div className="mt-3 rounded-lg border p-3" style={{ borderColor: "var(--border)", background: "var(--bg)" }}>
            <div className="flex items-start justify-between gap-3">
              <label className="flex cursor-pointer items-start gap-3 text-sm" style={{ color: "var(--text-secondary)" }}>
                <input
                  type="checkbox"
                  checked={notificationEnabled}
                  onChange={(e) => onNotificationEnabledChange?.(e.target.checked)}
                  className="mt-1"
                />
                <span>
                  Systembenachrichtigungen
                  <span className="mt-0.5 block text-xs" style={{ color: "var(--text-muted)" }}>
                    Fragt Berechtigung nur nach Klick an. Ohne Vorschau bleibt der Inhalt privat.
                  </span>
                </span>
              </label>
              {notificationPermission !== "granted" && notificationPermission !== "unsupported" && (
                <button
                  type="button"
                  onClick={() => void onRequestNotificationPermission?.()}
                  className="rounded-lg px-2 py-1 text-xs font-medium"
                  style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
                >
                  Erlauben
                </button>
              )}
            </div>
            <label className="mt-3 flex cursor-pointer items-start gap-3 text-sm" style={{ color: "var(--text-secondary)" }}>
              <input
                type="checkbox"
                checked={notificationPreview}
                disabled={!notificationEnabled}
                onChange={(e) => onNotificationPreviewChange?.(e.target.checked)}
                className="mt-1"
              />
              <span>
                Vorschau in Benachrichtigungen anzeigen
                <span className="mt-0.5 block text-xs" style={{ color: "var(--text-muted)" }}>
                  Komfort gegen Privatsphaere: Titel und Nachrichtentext koennen im OS sichtbar werden.
                </span>
              </span>
            </label>
            <p className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
              Browser-Status: {notificationPermission}
            </p>
          </div>
        </div>

        <div className="mb-4 rounded-lg border p-3" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
          <h3 className="mb-2 text-sm font-medium" style={{ color: "var(--text)" }}>
            Datensicherung
          </h3>
          {myFingerprint && (
            <p className="mb-3 break-all font-mono text-xs" style={{ color: "var(--accent)" }}>
              Fingerprint: {myFingerprint}
            </p>
          )}
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

        {/* Security Level Toggle */}
        <div className="mb-4">
          <label className="block text-sm font-medium mb-2" style={{ color: "var(--text-secondary)" }}>
            Sicherheitsstufe
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => handleLevelChange("normal")}
              className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
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
              className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                level === "extreme"
                  ? "bg-red-600 text-white"
                  : "bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              }`}
            >
              Extrem
            </button>
          </div>
        </div>

        {/* Security Level Description */}
        <div className="mb-4 p-3 rounded-lg" style={{ background: "var(--bg-elevated)" }}>
          {level === "normal" ? (
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
              <strong style={{ color: "var(--accent)" }}>Normal:</strong> Standard
              Auto-Lock (10 min), moderate Memory-Wiping-Intervalle (30-120s).
            </p>
          ) : (
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
              <strong style={{ color: "#ef4444" }}>Extrem:</strong> Aggressives
              Memory-Wiping (15-60s), sofortiges Wiping bei Tab-Wechsel.
            </p>
          )}
        </div>

        {/* Manual Actions */}
        <div className="space-y-2">
          <button
            type="button"
            onClick={handleImmediateWipe}
            className="w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ 
              background: "var(--bg-elevated)", 
              color: "var(--text-secondary)" 
            }}
          >
            Jetzt Memory wischen
          </button>
          
          <button
            type="button"
            onClick={handleResetReplayProtection}
            className="w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ 
              background: "var(--bg-elevated)", 
              color: "var(--text-secondary)" 
            }}
          >
            Replay-Schutz zuruecksetzen
          </button>
        </div>

        {/* Status Info */}
        <div className="mt-4 pt-4 border-t" style={{ borderColor: "var(--border)" }}>
          <h3 className="text-sm font-medium mb-2" style={{ color: "var(--text-secondary)" }}>
            Status
          </h3>
          <div className="text-xs space-y-1" style={{ color: "var(--text-muted)" }}>
            <p>Replay-Protection: {replayStats.stored} Nachrichten gespeichert</p>
            <p>Zeitfenster: {(replayStats.windowMs / 60000).toFixed(0)} Minuten</p>
          </div>
        </div>

        {/* Warning for Extreme Mode */}
        {level === "extreme" && (
          <div className="mt-4 p-3 rounded-lg" style={{ 
            background: "rgba(127, 29, 29, 0.3)", 
            border: "1px solid rgba(127, 29, 29, 0.5)" 
          }}>
            <p className="text-xs" style={{ color: "#fca5a5" }}>
              <strong>Extrem-Modus</strong> kann die Performance beeinträchtigen,
              da der Speicher häufiger gewiped wird.
            </p>
          </div>
        )}
      </div>
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
