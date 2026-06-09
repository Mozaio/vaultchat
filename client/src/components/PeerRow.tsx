import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { userGradient } from "../lib/chatHelpers";
import { getPin, type PeerPin } from "../lib/trust";
import { IconPin, IconVolumeMute } from "./Icons";
import { t, useLocale } from "../lib/i18n";

export function PeerRow({
  u,
  subtitle,
  draftText,
  metaRight,
  unread,
  isFavorite,
  isBlocked,
  isPinned,
  isMuted,
  isOnline,
  isTyping,
  isRequest,
  blurAvatar,
  onTogglePin,
  selected,
  onSelect,
}: {
  u: api.ApiUser;
  subtitle?: string;
  /** Ungesendeter Composer-Text — zeigt "Entwurf: …" statt der letzten Nachricht. */
  draftText?: string;
  metaRight?: string;
  unread?: number;
  isFavorite?: boolean;
  isBlocked?: boolean;
  isPinned?: boolean;
  isMuted?: boolean;
  isOnline?: boolean;
  isTyping?: boolean;
  /** Pending message request from a not-yet-accepted sender. */
  isRequest?: boolean;
  /** Pixelate/blur the avatar (unknown, not-yet-accepted sender). */
  blurAvatar?: boolean;
  onTogglePin?: () => void;
  selected: boolean;
  onSelect: () => void;
}) {
  useLocale();
  const [pin, setPin] = useState<PeerPin | null>(null);
  useEffect(() => {
    void getPin(u.id).then(setPin);
  }, [u.id, u.publicKey]);
  return (
    <div className="peer-row-wrap">
      <button
        type="button"
        onClick={onSelect}
        className={`contact-item w-full ${
          selected ? "active" : ""
        } !mx-0 items-center justify-between`}
      >
        <div className="peer-avatar-wrap">
          <div
            className={`contact-avatar !h-9 !w-9 !text-sm${
              blurAvatar ? " avatar-blurred" : ""
            }`}
            style={{ background: userGradient(u.id) }}
            aria-label={blurAvatar ? t("requests.unknownSender") : undefined}
          >
            {u.username.slice(0, 1).toUpperCase()}
          </div>
          {isOnline && !blurAvatar && (
            <span className="peer-online-dot" aria-label={t("chat.online")} />
          )}
        </div>
        <div className="contact-info min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="contact-name">{u.username}</span>
            {isRequest && (
              <span className="row-badge row-badge-request" title={t("requests.rowBadge")}>
                {t("requests.rowBadge")}
              </span>
            )}
            {isPinned && (
              <span className="row-badge row-badge-pin" title={t("chat.pinnedToTop")}>
                <IconPin size={11} />
              </span>
            )}
            {isFavorite && (
              <span className="row-badge row-badge-fav" title={t("chat.favoriteShort")}>
                ★
              </span>
            )}
            {isMuted && (
              <span className="row-badge row-badge-muted" title={t("chat.muted")}>
                <IconVolumeMute size={11} />
              </span>
            )}
            {isBlocked && (
              <span className="row-badge row-badge-warning" title={t("chat.blockedShort")}>
                {t("chat.blockedShort").toLowerCase()}
              </span>
            )}
            {pin?.state === "mismatch" && (
              <span className="row-badge row-badge-danger" title={t("chat.keyChangedShort")}>
                ⚠
              </span>
            )}
            {pin?.state === "verified" && (
              <span className="row-badge row-badge-verified" title={t("trust.verified")}>
                ✓
              </span>
            )}
          </div>
          <p
            className={`contact-preview${isTyping ? " typing" : ""}`}
          >
            {isTyping ? (
              <span className="typing-indicator">
                <span></span>
                <span></span>
                <span></span>
                {t("chat.typing")}
              </span>
            ) : draftText ? (
              <>
                <span className="draft-prefix">{t("chat.draftLabel")}</span>{" "}
                {draftText}
              </>
            ) : (
              subtitle ?? ""
            )}
          </p>
        </div>
        <div className="contact-meta">
          <span className="contact-time">{metaRight ?? ""}</span>
          {unread && unread > 0 ? (
            <span className="unread-badge">
              {unread > 99 ? "99+" : unread}
            </span>
          ) : null}
        </div>
      </button>
      {onTogglePin && (
        <button
          type="button"
          className={`peer-pin-toggle${isPinned ? " active" : ""}`}
          aria-label={isPinned ? t("chat.unpinChat") : t("chat.pinChat")}
          title={isPinned ? t("chat.unpinChat") : t("chat.pinChat")}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin();
          }}
        >
          <IconPin size={12} />
        </button>
      )}
    </div>
  );
}
