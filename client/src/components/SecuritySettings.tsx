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
  isOpen: boolean;
  onClose: () => void;
  session: {
    secretKey: Uint8Array;
  };
}

/**
 * Security Settings Panel Component
 */
export function SecuritySettings({
  isOpen,
  onClose,
  session,
}: SecuritySettingsProps) {
  const [level, setLevel] = useState<SecurityLevel>(loadSecurityLevel);
  const [replayStats, setReplayStats] = useState(getReplayStats());
  const [wipeActive, setWipeActive] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    setWipeActive(true);
    return () => {
      // Cleanup handled by parent
    };
  }, []);

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

    if (newLevel === "extreme") {
      // Extreme Mode: Register key and start aggressive wiping
      registerKeyForProtection(session.secretKey);
      startPeriodicWipe();
    } else {
      // Normal Mode: Reduced wiping
      stopPeriodicWipe();
      unregisterKeyForProtection();
    }
  };

  const handleImmediateWipe = async () => {
    await immediateWipe();
  };

  const handleResetReplayProtection = () => {
    resetAllReplayProtection();
    setReplayStats(getReplayStats());
  };

  if (!isOpen) return null;

  return (
    <div className="app-surface rounded-2xl p-4 max-w-md mx-auto mt-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">🔒 Sicherheitseinstellungen</h2>
        <button
          type="button"
          onClick={onClose}
          className="text-zinc-400 hover:text-white"
        >
          ✕
        </button>
      </div>

      {/* Security Level Toggle */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-zinc-300 mb-2">
          Sicherheitsstufe
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => handleLevelChange("normal")}
            className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              level === "normal"
                ? "bg-emerald-600 text-white"
                : "bg-zinc-700 text-zinc-300 hover:bg-zinc-600"
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
                : "bg-zinc-700 text-zinc-300 hover:bg-zinc-600"
            }`}
          >
            🔥 Extrem
          </button>
        </div>
      </div>

      {/* Security Level Description */}
      <div className="mb-4 p-3 rounded-lg bg-zinc-800/50 text-xs">
        {level === "normal" ? (
          <p className="text-zinc-400">
            <strong className="text-emerald-400">Normal:</strong> Standard
            Auto-Lock (10 min),moderate Memory-Wiping-Intervalle.
          </p>
        ) : (
          <p className="text-zinc-400">
            <strong className="text-red-400">Extrem:</strong> Aggressives
            Memory-Wiping (15-60s), sofortiges Wiping bei Tab-Wechsel, kürzerer
            Auto-Lock (2 min).
          </p>
        )}
      </div>

      {/* Manual Actions */}
      <div className="space-y-2">
        <button
          type="button"
          onClick={handleImmediateWipe}
          className="w-full px-3 py-2 rounded-lg text-sm font-medium bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors"
        >
          🧹 Jetzt Memory wischen
        </button>
        
        <button
          type="button"
          onClick={handleResetReplayProtection}
          className="w-full px-3 py-2 rounded-lg text-sm font-medium bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors"
        >
          🔄 Replay-Schutz zurücksetzen
        </button>
      </div>

      {/* Status Info */}
      <div className="mt-4 pt-4 border-t border-zinc-700">
        <h3 className="text-sm font-medium text-zinc-300 mb-2">Status</h3>
        <div className="text-xs text-zinc-500 space-y-1">
          <p>Replay-Protection: {replayStats.stored} Nachrichten gespeichert</p>
          <p>Zeitfenster: {(replayStats.windowMs / 60000).toFixed(0)} Minuten</p>
          <p>Memory-Wipe: {wipeActive ? "Aktiv" : "Inaktiv"}</p>
        </div>
      </div>

      {/* Warning for Extreme Mode */}
      {level === "extreme" && (
        <div className="mt-4 p-3 rounded-lg bg-red-900/30 border border-red-800">
          <p className="text-xs text-red-300">
            ⚠️ <strong>Extrem-Modus</strong> kann die Performance beeinträchtigen,
            da der Speicher häufiger gelöscht wird. Dieser Modus ist für Situationen
            mit erhöhtem Risiko gedacht.
          </p>
        </div>
      )}
    </div>
  );
}
