import * as api from "../lib/api";
import { saveStringSet, userGradient } from "../lib/chatHelpers";
import {
  IconBell,
  IconFileText,
  IconMic,
  IconPin,
  IconSearch,
  IconShieldCheck,
} from "./Icons";

export type SharedMediaItem = {
  id: string;
  kind: "file" | "voice";
  name: string;
  href: string;
  at: number;
};

export function InfoPanel({
  mode,
  peer,
  group,
  peerFp,
  onSafety,
  onOpenSearch,
  onClearChat,
  mutedPeers,
  setMutedPeers,
  mutedGroups,
  setMutedGroups,
  isFavorite,
  onToggleFavorite,
  isBlocked,
  onToggleBlocked,
  sharedMediaItems,
}: {
  mode: "dm" | "group";
  peer: api.ApiUser | null;
  group: api.ApiGroup | null;
  peerFp: string | null;
  onSafety: () => void;
  onOpenSearch: () => void;
  onClearChat: () => void | Promise<void>;
  mutedPeers: Set<string>;
  setMutedPeers: React.Dispatch<React.SetStateAction<Set<string>>>;
  mutedGroups: Set<string>;
  setMutedGroups: React.Dispatch<React.SetStateAction<Set<string>>>;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  isBlocked: boolean;
  onToggleBlocked: () => void;
  sharedMediaItems: SharedMediaItem[];
}) {
  const title = mode === "dm" ? peer?.username ?? "Kontakt" : group?.name ?? "Gruppe";
  const initials = (title.slice(0, 1) || "•").toUpperCase();
  const status = mode === "dm" ? "Online" : `${group?.memberIds.length ?? 0} Mitglieder`;
  const isMuted =
    mode === "dm" && peer
      ? mutedPeers.has(peer.id)
      : mode === "group" && group
        ? mutedGroups.has(group.id)
        : false;
  const groupedSafetyNumber = peerFp
    ? peerFp.replace(/\s+/g, "").match(/.{1,4}/g)?.join(" ") ?? peerFp
    : "…";

  const toggleMute = () => {
    if (mode === "dm" && peer) {
      setMutedPeers((prev) => {
        const next = new Set(prev);
        if (next.has(peer.id)) next.delete(peer.id);
        else next.add(peer.id);
        return next;
      });
      return;
    }
    if (mode === "group" && group) {
      setMutedGroups((prev) => {
        const next = new Set(prev);
        if (next.has(group.id)) next.delete(group.id);
        else next.add(group.id);
        saveStringSet("vaultchat.muted.groups", next);
        return next;
      });
    }
  };

  return (
    <div className="info-panel">
      {/* Profile Avatar */}
      <div className="flex flex-col items-center">
        <div className="relative">
          {mode === "group" && group?.avatar ? (
            <img
              src={group.avatar}
              alt={`${group.name} Avatar`}
              className="info-avatar-large"
              style={{ objectFit: "cover" }}
            />
          ) : (
            <div
              className="info-avatar-large"
              style={{
                background: userGradient(
                  (mode === "dm" ? peer?.id : group?.id) ?? title
                ),
              }}
            >
              {initials}
            </div>
          )}
          {mode === "dm" && <span className="online-dot" />}
        </div>
        <p className="text-center text-lg font-bold" style={{ color: "var(--text)" }}>
          {title}
        </p>
        <p className="mb-3 text-center text-sm" style={{ color: "var(--text-muted)" }}>
          {status}
        </p>
      </div>

      {/* Quick Actions Grid */}
      <div className="mb-4 grid grid-cols-3 gap-2">
        <button
          type="button"
          className={`info-action-button ${isFavorite ? "active" : ""}`}
          onClick={onToggleFavorite}
          title={isFavorite ? "Aus Favoriten entfernen" : "Als Favorit markieren"}
          disabled={mode !== "dm"}
        >
          <IconPin size={18} />
          <span>{isFavorite ? "Favorit" : "Favorit"}</span>
        </button>
        <button
          type="button"
          className={`info-action-button ${isMuted ? "active-warning" : ""}`}
          onClick={toggleMute}
          title={isMuted ? "Stummschaltung aufheben" : "Stummschalten"}
        >
          <IconBell size={18} />
          <span>
            {isMuted ? "Stumm" : "Benachrichtigungen"}
          </span>
        </button>
        <button
          type="button"
          className="info-action-button"
          onClick={onToggleBlocked}
          disabled={mode !== "dm"}
          title={isBlocked ? "Kontakt entsperren" : "Kontakt blockieren"}
        >
          <IconShieldCheck size={18} />
          <span>{isBlocked ? "Blockiert" : "Blockieren"}</span>
        </button>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-2">
        <button
          type="button"
          className="info-action-button !h-auto !py-3"
          onClick={onOpenSearch}
          title="Suchen"
        >
          <IconSearch size={18} />
          <span>Suchen</span>
        </button>
      </div>

      {mode === "dm" && peer && (
        <div className="info-section">
          <p className="info-section-title">Benutzerinfo</p>
          <div className="rounded-xl border p-3" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
            <div className="flex items-center justify-between">
              <span className="text-sm" style={{ color: "var(--text-secondary)" }}>Username</span>
              <span className="font-medium" style={{ color: "var(--text)" }}>@{peer.username}</span>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-sm" style={{ color: "var(--text-secondary)" }}>ID</span>
              <button
                type="button"
                className="group inline-flex items-center gap-1 font-mono text-xs"
                style={{ color: "var(--accent)" }}
                title="ID kopieren"
                onClick={() => void navigator.clipboard?.writeText(peer.id)}
              >
                {peer.id.slice(0, 16)}...
                <span className="opacity-0 transition group-hover:opacity-100">⧉</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="info-section !border-0 !pb-0">
        <p className="info-section-title">Sicherheit</p>
        <p className="text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          Nachrichten und Anrufe sind Ende-zu-Ende verschlüsselt. Der Server
          leitet nur versiegelte Daten. Perfect Forward Secrecy aktiv.
        </p>
      </div>

      {mode === "dm" && (
        <div className="info-section">
          <p className="info-section-title">Sicherheitsnummer</p>
          <button
            type="button"
            onClick={onSafety}
            className="w-full rounded-xl border p-3 text-left transition hover:opacity-95"
            style={{
              borderColor: "var(--border)",
              background: "var(--bg-elevated)",
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <p
                className="font-mono text-[13px] leading-relaxed tracking-wider"
                style={{ color: "var(--accent)" }}
              >
                {groupedSafetyNumber}
              </p>
              <span className="btn btn-secondary !px-2 !py-1 !text-[11px]">
                <IconShieldCheck size={14} />
                Verifizieren
              </span>
            </div>
          </button>
        </div>
      )}

      <div className="info-section">
        <p className="info-section-title">Geteilte Inhalte</p>
        {sharedMediaItems.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            Noch keine Dateien oder Sprachnotizen in diesem Chat.
          </p>
        ) : (
          <div className="space-y-2">
            {sharedMediaItems.slice(0, 8).map((item) => (
              <a
                key={item.id}
                href={item.href}
                download={item.kind === "file" ? item.name : undefined}
                className="flex items-center gap-3 rounded-xl border p-2 text-sm transition hover:opacity-90"
                style={{ borderColor: "var(--border)", background: "var(--bg-elevated)", color: "var(--text)" }}
              >
                {item.kind === "file" ? <IconFileText size={16} /> : <IconMic size={16} />}
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                  {new Date(item.at).toLocaleDateString()}
                </span>
              </a>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => void onClearChat()}
        className="btn btn-danger w-full"
      >
        Chat-Verlauf leeren
      </button>

      <p className="mt-auto pt-4 text-center text-[11px] app-muted">
        Verlauf nur lokal, verschlüsselt (IndexedDB).
      </p>
    </div>
  );
}
