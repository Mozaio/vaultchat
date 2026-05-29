import * as api from "../lib/api";
import { saveStringSet, userGradient } from "../lib/chatHelpers";
import { safeMediaSrc } from "../lib/safeMedia";
import { t, useLocale } from "../lib/i18n";
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
  useLocale(); // re-render on language change
  const title = mode === "dm" ? peer?.username ?? t("chat.contactFallback") : group?.name ?? t("chat.groupFallback");
  const initials = (title.slice(0, 1) || "•").toUpperCase();
  const status =
    mode === "dm"
      ? t("info.online")
      : t("info.members", { n: group?.memberIds.length ?? 0 });
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
          {mode === "group" && safeMediaSrc(group?.avatar, "image") ? (
            <img
              src={safeMediaSrc(group?.avatar, "image")}
              alt={`${group?.name ?? t("chat.groupFallback")} Avatar`}
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
          title={isFavorite ? t("chat.unfavorite") : t("chat.favorite")}
          disabled={mode !== "dm"}
        >
          <IconPin size={18} />
          <span>{isFavorite ? t("info.favorited") : t("info.favorite")}</span>
        </button>
        <button
          type="button"
          className={`info-action-button ${isMuted ? "active-warning" : ""}`}
          onClick={toggleMute}
          title={isMuted ? t("chat.unmuteContact") : t("chat.muteContact")}
        >
          <IconBell size={18} />
          <span>
            {isMuted ? t("info.muted") : t("info.notifications")}
          </span>
        </button>
        <button
          type="button"
          className="info-action-button"
          onClick={onToggleBlocked}
          disabled={mode !== "dm"}
          title={isBlocked ? t("chat.unblock") : t("chat.block")}
        >
          <IconShieldCheck size={18} />
          <span>{isBlocked ? t("info.blocked") : t("info.block")}</span>
        </button>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-2">
        <button
          type="button"
          className="info-action-button !h-auto !py-3"
          onClick={onOpenSearch}
          title={t("common.search")}
        >
          <IconSearch size={18} />
          <span>{t("common.search")}</span>
        </button>
      </div>

      {mode === "dm" && peer && (
        <div className="info-section">
          <p className="info-section-title">{t("info.userInfo")}</p>
          <div className="rounded-xl border p-3" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
            <div className="flex items-center justify-between">
              <span className="text-sm" style={{ color: "var(--text-secondary)" }}>{t("auth.username")}</span>
              <span className="font-medium" style={{ color: "var(--text)" }}>@{peer.username}</span>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-sm" style={{ color: "var(--text-secondary)" }}>ID</span>
              <button
                type="button"
                className="group inline-flex items-center gap-1 font-mono text-xs"
                style={{ color: "var(--accent)" }}
                title={t("chat.copyId")}
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
        <p className="info-section-title">{t("info.security")}</p>
        <p className="text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          {t("info.e2eeBlurb")}
        </p>
      </div>

      {mode === "dm" && (
        <div className="info-section">
          <p className="info-section-title">{t("info.safetyNumber")}</p>
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
                {t("info.verify")}
              </span>
            </div>
          </button>
        </div>
      )}

      <div className="info-section">
        <p className="info-section-title">{t("info.sharedMedia")}</p>
        {sharedMediaItems.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            {t("info.noShared")}
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
        {t("info.clearChat")}
      </button>

      <p className="mt-auto pt-4 text-center text-[11px] app-muted">
        {t("info.localOnly")}
      </p>
    </div>
  );
}
