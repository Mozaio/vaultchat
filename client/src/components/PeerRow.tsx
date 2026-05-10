import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { userGradient } from "../lib/chatHelpers";
import { getPin, type PeerPin } from "../lib/trust";
import { IconPin } from "./Icons";

export function PeerRow({
  u,
  subtitle,
  metaRight,
  unread,
  isFavorite,
  isBlocked,
  isPinned,
  isOnline,
  isTyping,
  onTogglePin,
  selected,
  onSelect,
}: {
  u: api.ApiUser;
  subtitle?: string;
  metaRight?: string;
  unread?: number;
  isFavorite?: boolean;
  isBlocked?: boolean;
  isPinned?: boolean;
  isOnline?: boolean;
  isTyping?: boolean;
  onTogglePin?: () => void;
  selected: boolean;
  onSelect: () => void;
}) {
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
            className="contact-avatar !h-9 !w-9 !text-sm"
            style={{ background: userGradient(u.id) }}
          >
            {u.username.slice(0, 1).toUpperCase()}
          </div>
          {isOnline && <span className="peer-online-dot" aria-label="Online" />}
        </div>
        <div className="contact-info min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="contact-name">{u.username}</span>
            {isPinned && (
              <span className="row-badge row-badge-pin" title="An Anfang geheftet">
                <IconPin size={11} />
              </span>
            )}
            {isFavorite && (
              <span className="row-badge row-badge-fav" title="Favorit">
                ★
              </span>
            )}
            {isBlocked && (
              <span className="row-badge row-badge-warning" title="Blockiert">
                blockiert
              </span>
            )}
            {pin?.state === "mismatch" && (
              <span className="row-badge row-badge-danger" title="Schlüssel hat gewechselt">
                ⚠
              </span>
            )}
            {pin?.state === "verified" && (
              <span className="row-badge row-badge-verified" title="Verifiziert">
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
                schreibt
              </span>
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
          aria-label={isPinned ? "Pin entfernen" : "An Anfang heften"}
          title={isPinned ? "Pin entfernen" : "An Anfang heften"}
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
