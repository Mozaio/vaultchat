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
  stopPeriodicWipe,
  immediateWipe,
  registerKeyForProtection,
  unregisterKeyForProtection,
  setSecurityMode,
} from "../lib/exfilProtection";
import {
  resetAllReplayProtection,
  getReplayStats,
} from "../lib/replayProtection";

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
  onExportBackup?: () => void;
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
  onExportBackup,
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
      // Normal Mode: Reduced wiping
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="app-surface rounded-2xl p-6 max-w-md w-full">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold" style={{ color: "var(--text)" }}>
            🔒 Sicherheitseinstellungen
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 hover:bg-[var(--bg-hover)]"
            style={{ color: "var(--text-muted)" }}
          >
            ✕
          </button>
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
            Backup (JSON) herunterladen
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
              🔥 Extrem
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
            🧹 Jetzt Memory wischen
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
            🔄 Replay-Schutz zurücksetzen
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
              ⚠️ <strong>Extrem-Modus</strong> kann die Performance beeinträchtigen,
              da der Speicher häufiger gewiped wird.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
