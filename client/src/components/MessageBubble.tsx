import { useEffect, useMemo, useRef, useState } from "react";
import type { PlainPayload } from "../lib/crypto";
import { userGradient } from "../lib/chatHelpers";
import { safeMediaSrc } from "../lib/safeMedia";
import {
  formatFileSize,
  fmtDuration,
  isImagePayload,
  truncate,
} from "../lib/messagePreview";
import {
  IconBookmark,
  IconCheck,
  IconCheckCheck,
  IconCopy,
  IconDownload,
  IconEdit,
  IconFileText,
  IconForward,
  IconImage,
  IconLock,
  IconMessageSquare,
  IconPause,
  IconPin,
  IconPlay,
  IconReply,
  IconSmile,
  IconStar,
  IconTimer,
  IconTrash,
  IconX,
} from "./Icons";
import { EmojiPicker } from "./EmojiPicker";
import {
  renderInlineMarkdown,
  extractLinks,
  shortenUrl,
} from "../lib/inlineMarkdown";

export type ChatMsg = {
  id: string;
  fromMe: boolean;
  /** Server-Sender-ID für Gruppen (für Avatar/Username-Auflösung). */
  fromUserId?: string;
  plain: PlainPayload;
  at: number;
  expiresAt?: number;
  reactions?: Record<string, number>;
  myReaction?: string;
  deleted?: boolean;
  edited?: boolean;
  readByPeer?: boolean;
  deliveredToPeer?: boolean;
  /** Nur bei kind === "poll": votes pro Option-Index, gesammelt aus
   *  poll-vote frames. Letzter vote pro voter gewinnt. */
  pollVotes?: number[];
  /** Mein eigener Vote-Index, falls ich abgestimmt habe. */
  myPollVote?: number;
};

export const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

export { previewForPayload } from "../lib/messagePreview";

/** Deterministische, harmlos zufällige Wellenform aus dem Cid-String. */
function useWaveform(seed: string, bars = 28): number[] {
  return useMemo(() => {
    let h = 0;
    for (let i = 0; i < seed.length; i++) {
      h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
    }
    const out: number[] = [];
    for (let i = 0; i < bars; i++) {
      h = (Math.imul(1103515245, h) + 12345) | 0;
      const v = ((h >>> 8) & 0xff) / 255;
      out.push(0.25 + v * 0.75);
    }
    return out;
  }, [seed, bars]);
}

function VoiceCard({
  src,
  durationMs,
  cid,
}: {
  src: string;
  durationMs?: number;
  cid: string;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const bars = useWaveform(cid, 28);
  // Peer-controlled src must be a whitelisted audio data: URL.
  const safeSrc = safeMediaSrc(src, "audio");

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => {
      if (audio.duration > 0) setProgress(audio.currentTime / audio.duration);
    };
    const onEnd = () => {
      setPlaying(false);
      setProgress(0);
    };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("ended", onEnd);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("ended", onEnd);
    };
  }, []);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play();
      setPlaying(true);
    } else {
      audio.pause();
      setPlaying(false);
    }
  };

  return (
    <div className="voice-card">
      <button
        type="button"
        className="voice-play"
        onClick={toggle}
        aria-label={playing ? "Pausieren" : "Abspielen"}
      >
        {playing ? <IconPause size={14} /> : <IconPlay size={14} />}
      </button>
      <div className="voice-wave">
        {bars.map((h, i) => {
          const filled = i / bars.length <= progress;
          return (
            <span
              key={i}
              className={`voice-bar${filled ? " played" : ""}`}
              style={{ height: `${Math.round(h * 100)}%` }}
            />
          );
        })}
      </div>
      <span className="voice-duration">{fmtDuration(durationMs)}</span>
      <audio ref={audioRef} src={safeSrc} preload="metadata" hidden />
    </div>
  );
}

/** How long the recipient can look at a view-once message before it
 *  is removed from local storage. */
const VIEW_ONCE_REVEAL_MS = 10_000;

export function MessageBubble({
  msg,
  peerLabel,
  replyToPreview,
  isGrouped,
  isLastInGroup,
  isStarred,
  isHighlighted,
  isPinned,
  onReply,
  onReact,
  onEdit,
  onDelete,
  onCopy,
  onForward,
  onJumpToCid,
  onToggleStar,
  onTogglePin,
  onLocalDelete,
  onPollVote,
  threadReplyCount,
  threadUnreadCount,
  onOpenThread,
  groupAvatar,
}: {
  msg: ChatMsg;
  peerLabel: string;
  /** Group chats only: "show" renders the sender avatar + name at the start
   *  of a received run; "space" indents continuation bubbles to align. DMs
   *  pass nothing (kept clean). */
  groupAvatar?: "show" | "space";
  replyToPreview?: { author: string; text: string; cid?: string } | null;
  isGrouped?: boolean;
  isLastInGroup?: boolean;
  isStarred?: boolean;
  isHighlighted?: boolean;
  isPinned?: boolean;
  onReply: (m: ChatMsg) => void;
  onReact: (m: ChatMsg, emoji: string) => void;
  onEdit: (m: ChatMsg, newBody: string) => void;
  onDelete: (m: ChatMsg) => void;
  onCopy: (text: string) => void;
  onForward?: (m: ChatMsg) => void;
  onJumpToCid?: (cid: string) => void;
  onToggleStar?: (m: ChatMsg) => void;
  onTogglePin?: (m: ChatMsg) => void;
  /** Local-only delete (no network frame). Used for view-once reveal expiry. */
  onLocalDelete?: (m: ChatMsg) => void;
  /** Cast a vote on a poll message at the given option index. */
  onPollVote?: (m: ChatMsg, optionIndex: number) => void;
  /** Number of thread replies to this message (only shown on parents). */
  threadReplyCount?: number;
  /** Number of replies arrived after the user last opened this thread. */
  threadUnreadCount?: number;
  /** Click handler to open the thread side panel. */
  onOpenThread?: (m: ChatMsg) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [reactOpen, setReactOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(msg.plain.body ?? "");
  const [ttlLeft, setTtlLeft] = useState<string | null>(() =>
    computeTtlLeft(msg.expiresAt)
  );
  const [imageOpen, setImageOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [viewOnceLeftMs, setViewOnceLeftMs] = useState<number | null>(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const bubbleRef = useRef<HTMLDivElement>(null);

  // When opening menu/reaction popover, decide whether to flip
  // down (instead of up) if the bubble is near the top of the
  // viewport so the popover/menu does not go off-screen and never
  // covers the message above.
  useEffect(() => {
    if (!menuOpen && !reactOpen) return;
    const el = bubbleRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setFlipUp(rect.top < 220);
  }, [menuOpen, reactOpen]);

  useEffect(() => {
    if (!msg.expiresAt) return;
    const h = setInterval(
      () => setTtlLeft(computeTtlLeft(msg.expiresAt)),
      1000
    );
    return () => clearInterval(h);
  }, [msg.expiresAt]);

  // View-once countdown: once revealed, count down VIEW_ONCE_REVEAL_MS and
  // then trigger a local-only delete. Only runs for non-sender (recipient).
  useEffect(() => {
    if (!revealed || msg.fromMe || !msg.plain.viewOnce) return;
    const start = Date.now();
    setViewOnceLeftMs(VIEW_ONCE_REVEAL_MS);
    const tick = window.setInterval(() => {
      const left = VIEW_ONCE_REVEAL_MS - (Date.now() - start);
      if (left <= 0) {
        window.clearInterval(tick);
        setViewOnceLeftMs(0);
        onLocalDelete?.(msg);
      } else {
        setViewOnceLeftMs(left);
      }
    }, 250);
    return () => window.clearInterval(tick);
  }, [revealed, msg, onLocalDelete]);

  useEffect(() => {
    if (!menuOpen && !reactOpen) return;
    const onPointerDown = (ev: PointerEvent) => {
      if (bubbleRef.current?.contains(ev.target as Node)) return;
      setMenuOpen(false);
      setReactOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen, reactOpen]);

  const body = msg.plain.body ?? "";
  const reacts = msg.reactions ?? {};
  const reactEntries = Object.entries(reacts).filter(([, n]) => n > 0);
  // Peer-controlled body must be whitelisted before use as a src/href.
  // A blocked image src falls back to the file-card download path below.
  const imageSrc = isImagePayload(msg.plain) ? safeMediaSrc(body, "image") : "";
  const isImage = isImagePayload(msg.plain) && imageSrc !== "";
  const fileHref =
    msg.plain.kind === "file" ? safeMediaSrc(body, "file") : "";
  const isSystem = msg.plain.kind === "system";
  const isViewOnce = !!msg.plain.viewOnce && !msg.deleted;
  const showCover = isViewOnce && !msg.fromMe && !revealed;

  // System messages render as a centered, neutral notice — no avatar,
  // no reactions, no actions.
  if (isSystem) {
    return (
      <div className="system-message" data-cid={msg.plain.cid}>
        <span>{body}</span>
      </div>
    );
  }

  // Recipient view of a still-covered view-once message: just a tap target.
  if (showCover) {
    return (
      <div
        ref={bubbleRef}
        data-cid={msg.plain.cid}
        className={`message-wrapper group ${msg.fromMe ? "sent" : "received"}`}
      >
        <button
          type="button"
          className="view-once-cover"
          onClick={() => setRevealed(true)}
          aria-label="Einmal-Nachricht öffnen — verschwindet nach dem Anschauen"
        >
          <IconLock size={14} />
          <span>Einmal anzeigen — tippen zum Öffnen</span>
        </button>
      </div>
    );
  }

  function toggleReaction(emoji: string) {
    onReact(msg, msg.myReaction === emoji ? "" : emoji);
    setReactOpen(false);
    setMenuOpen(false);
  }

  // ARIA-Label für Screenreader: kurze Zusammenfassung der Bubble (Sender,
  // Inhaltsart, Vorschau). Den vollen Body lesen Screenreader ohnehin im
  // Inhalt, das Label ist für die Liste-Navigation gedacht.
  const ariaLabel = (() => {
    const who = msg.fromMe ? "Du" : peerLabel;
    if (msg.deleted) return `${who}: gelöschte Nachricht`;
    if (msg.plain.kind === "voice") return `${who}: Sprachnachricht`;
    if (msg.plain.kind === "file") return `${who}: Datei ${msg.plain.fileName ?? ""}`;
    const text = msg.plain.body ?? "";
    const trimmed = text.length > 80 ? text.slice(0, 80) + "…" : text;
    return `${who}: ${trimmed || "leere Nachricht"}`;
  })();

  return (
    <div
      ref={bubbleRef}
      data-cid={msg.plain.cid}
      role="article"
      aria-label={ariaLabel}
      className={`message-wrapper group ${msg.fromMe ? "sent" : "received"}${
        isHighlighted ? " highlighted" : ""
      }${groupAvatar ? " with-av" : ""}`}
    >
      {groupAvatar === "show" && (
        <div
          className="msg-avatar"
          style={{ background: userGradient(msg.fromUserId ?? peerLabel) }}
          aria-hidden="true"
        >
          {(peerLabel || "?").charAt(0).toUpperCase()}
        </div>
      )}
      {groupAvatar === "space" && (
        <div className="msg-avatar-spacer" aria-hidden="true" />
      )}
      <div
        className={`flex max-w-[min(85%,32rem)] flex-col ${
          msg.fromMe ? "items-end" : "items-start"
        }`}
      >
        {groupAvatar === "show" && (
          <span className="msg-sender-name">{peerLabel}</span>
        )}
        {replyToPreview && (
          <button
            type="button"
            className="reply-stripe"
            onClick={(e) => {
              e.stopPropagation();
              if (replyToPreview.cid) onJumpToCid?.(replyToPreview.cid);
            }}
            disabled={!replyToPreview.cid}
            title={replyToPreview.cid ? "Zur Nachricht springen" : undefined}
          >
            <span className="reply-stripe-author">{replyToPreview.author}</span>
            <span className="reply-stripe-text">
              {truncate(replyToPreview.text, 120)}
            </span>
          </button>
        )}

        <div
          className={`message-bubble relative ${
            msg.fromMe ? "sent" : "received"
          } max-w-full ${msg.deleted ? "is-deleted" : ""} ${
            isGrouped ? "grouped" : ""
          } ${isLastInGroup ? "tail" : ""} ${isImage ? "is-image" : ""}${
            flipUp ? " menu-flip-up" : ""
          }`}
          onDoubleClick={(e) => {
            if (!msg.deleted && msg.plain.kind === "text") {
              e.stopPropagation();
              onReact(msg, msg.myReaction === "👍" ? "" : "👍");
            }
          }}
        >
          {msg.deleted ? (
            <span className="bubble-deleted">
              <IconTrash size={12} aria-hidden /> Nachricht gelöscht
            </span>
          ) : editing ? (
            <div className="bubble-edit">
              <textarea
                className="bubble-edit-input"
                value={editValue}
                rows={1}
                ref={(el) => {
                  if (el) {
                    el.style.height = "auto";
                    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                  }
                }}
                onChange={(e) => {
                  setEditValue(e.target.value);
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                }}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !(e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    if (editValue.trim() && editValue.trim() !== body) {
                      onEdit(msg, editValue.trim());
                    }
                    setEditing(false);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setEditing(false);
                    setEditValue(body);
                  }
                }}
              />
              <button
                type="button"
                className="bubble-edit-cancel"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing(false);
                  setEditValue(body);
                }}
              >
                Esc
              </button>
            </div>
          ) : isImage ? (
            <button
              type="button"
              className="image-attachment"
              onClick={(e) => {
                e.stopPropagation();
                setImageOpen(true);
              }}
              aria-label="Bild öffnen"
            >
              <img
                src={imageSrc}
                alt={msg.plain.fileName ?? "Bild"}
                className="image-attachment-img"
                loading="lazy"
                draggable={false}
              />
              {msg.plain.fileName && (
                <span className="image-attachment-meta">
                  <IconImage size={12} aria-hidden />
                  {msg.plain.fileName}
                </span>
              )}
            </button>
          ) : msg.plain.kind === "file" ? (
            <div className="file-attachment-card">
              <div className="file-icon-wrapper">
                <IconFileText size={18} />
              </div>
              <div className="file-info">
                <div className="file-name">
                  {msg.plain.fileName ?? "Datei"}
                </div>
                <div className="file-size">
                  {formatFileSize(msg.plain.fileSize) || msg.plain.mime || ""}
                </div>
              </div>
              {fileHref ? (
                <a
                  href={fileHref}
                  download={msg.plain.fileName}
                  className="download-btn"
                  onClick={(e) => e.stopPropagation()}
                  aria-label="Herunterladen"
                >
                  <IconDownload size={14} />
                </a>
              ) : (
                <span
                  className="download-btn"
                  aria-label="Anhang blockiert"
                  title="Anhang aus Sicherheitsgründen blockiert (unsicherer Typ)"
                  style={{ opacity: 0.4, cursor: "not-allowed" }}
                >
                  <IconLock size={14} />
                </span>
              )}
            </div>
          ) : msg.plain.kind === "voice" ? (
            <VoiceCard
              src={body}
              durationMs={msg.plain.durationMs}
              cid={msg.plain.cid}
            />
          ) : msg.plain.kind === "poll" && msg.plain.pollOptions ? (
            (() => {
              const options = msg.plain.pollOptions;
              const counts = msg.pollVotes ?? new Array(options.length).fill(0);
              const total = counts.reduce((a, b) => a + b, 0);
              return (
                <div className="poll-card">
                  <p className="poll-question">
                    {msg.plain.pollQuestion ?? ""}
                  </p>
                  <div className="poll-options">
                    {options.map((opt, i) => {
                      const c = counts[i] ?? 0;
                      const pct = total > 0 ? Math.round((c / total) * 100) : 0;
                      const mine = msg.myPollVote === i;
                      return (
                        <button
                          key={i}
                          type="button"
                          className={`poll-option${mine ? " mine" : ""}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onPollVote?.(msg, i);
                          }}
                          aria-pressed={mine}
                        >
                          <span className="poll-option-fill" style={{ width: `${pct}%` }} />
                          <span className="poll-option-label">
                            <span>{opt}</span>
                            <span className="poll-option-count">
                              {pct}% · {c}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="poll-total">
                    {total === 1
                      ? "1 Stimme"
                      : `${total} Stimmen`}
                  </p>
                </div>
              );
            })()
          ) : (
            <>
              <p className="bubble-text">{renderInlineMarkdown(body)}</p>
              {(() => {
                if (msg.deleted || msg.plain.viewOnce) return null;
                const links = extractLinks(body, 2);
                if (links.length === 0) return null;
                return (
                  <div className="link-preview-stack">
                    {links.map((url) => {
                      const { host, path } = shortenUrl(url);
                      return (
                        <a
                          key={url}
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                          className="link-preview-card"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span className="link-preview-host">{host}</span>
                          {path && (
                            <span className="link-preview-path">{path}</span>
                          )}
                        </a>
                      );
                    })}
                  </div>
                );
              })()}
            </>
          )}

          <div className="bubble-meta">
            {isStarred && !msg.deleted && (
              <span className="meta-star" title="Markiert">
                <IconBookmark size={11} />
              </span>
            )}
            {isViewOnce && (
              <span
                className="disappearing-timer"
                title={
                  msg.fromMe
                    ? "Einmal-Nachricht — Empfänger sieht sie nur einmal"
                    : viewOnceLeftMs !== null
                      ? "Verschwindet beim Schließen"
                      : "Einmal anzeigen"
                }
              >
                <IconLock size={10} />
                {viewOnceLeftMs !== null
                  ? `${Math.max(0, Math.ceil(viewOnceLeftMs / 1000))}s`
                  : "1×"}
              </span>
            )}
            {ttlLeft && (
              <span className="disappearing-timer" title="Verschwindet bald">
                <IconTimer size={10} />
                {ttlLeft}
              </span>
            )}
            {msg.edited && !msg.deleted && (
              <span className="meta-edited">bearbeitet</span>
            )}
            <span
              className="meta-time"
              title={new Date(msg.at).toLocaleString(undefined, {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            >
              {new Date(msg.at).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            {msg.fromMe && !msg.deleted && (
              <span
                className="status-icon"
                title={
                  msg.readByPeer
                    ? "Gelesen"
                    : msg.deliveredToPeer
                      ? "Zugestellt"
                      : "Gesendet"
                }
              >
                {msg.readByPeer ? (
                  <IconCheckCheck size={13} className="read" />
                ) : msg.deliveredToPeer ? (
                  <IconCheckCheck size={13} className="delivered" />
                ) : (
                  <IconCheck size={13} />
                )}
              </span>
            )}
          </div>

          {!msg.deleted && !isViewOnce && (
            <div
              className={`message-actions ${
                msg.fromMe ? "from-me" : "from-peer"
              }`}
            >
              <button
                type="button"
                className="message-action-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setReactOpen((v) => !v);
                  setMenuOpen(false);
                }}
                aria-label="Reagieren"
                title="Reagieren"
              >
                <IconSmile size={14} />
              </button>
              <button
                type="button"
                className="message-action-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onReply(msg);
                }}
                aria-label="Antworten"
                title="Antworten"
              >
                <IconReply size={14} />
              </button>
              <button
                type="button"
                className="message-action-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen((v) => !v);
                  setReactOpen(false);
                }}
                aria-label="Mehr"
                title="Mehr"
              >
                ⋯
              </button>
            </div>
          )}

          {menuOpen && !msg.deleted && (
            <div
              className={`bubble-menu ${msg.fromMe ? "right" : "left"}`}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="bubble-menu-item"
                onClick={() => {
                  onReply(msg);
                  setMenuOpen(false);
                }}
              >
                <IconReply size={14} /> Antworten
              </button>
              {onOpenThread && !msg.plain.threadParentCid && (
                <button
                  type="button"
                  className="bubble-menu-item"
                  onClick={() => {
                    onOpenThread(msg);
                    setMenuOpen(false);
                  }}
                >
                  <IconMessageSquare size={14} /> Im Thread antworten
                </button>
              )}
              {onForward && msg.plain.kind !== "voice" && (
                <button
                  type="button"
                  className="bubble-menu-item"
                  onClick={() => {
                    onForward(msg);
                    setMenuOpen(false);
                  }}
                >
                  <IconForward size={14} /> Weiterleiten
                </button>
              )}
              {onToggleStar && msg.plain.kind === "text" && (
                <button
                  type="button"
                  className="bubble-menu-item"
                  onClick={() => {
                    onToggleStar(msg);
                    setMenuOpen(false);
                  }}
                >
                  {isStarred ? <IconBookmark size={14} /> : <IconStar size={14} />}
                  {isStarred ? "Markierung entfernen" : "Markieren"}
                </button>
              )}
              {onTogglePin && (
                <button
                  type="button"
                  className="bubble-menu-item"
                  onClick={() => {
                    onTogglePin(msg);
                    setMenuOpen(false);
                  }}
                >
                  <IconPin size={14} />
                  {isPinned ? "Pin entfernen" : "Anpinnen"}
                </button>
              )}
              {msg.plain.kind === "text" && body && (
                <button
                  type="button"
                  className="bubble-menu-item"
                  onClick={() => {
                    onCopy(body);
                    setMenuOpen(false);
                  }}
                >
                  <IconCopy size={14} /> Kopieren
                </button>
              )}
              {msg.fromMe && msg.plain.kind === "text" && (
                <button
                  type="button"
                  className="bubble-menu-item"
                  onClick={() => {
                    setEditing(true);
                    setMenuOpen(false);
                  }}
                >
                  <IconEdit size={14} /> Bearbeiten
                </button>
              )}
              {msg.fromMe && (
                <button
                  type="button"
                  className="bubble-menu-item danger"
                  onClick={() => {
                    onDelete(msg);
                    setMenuOpen(false);
                  }}
                >
                  <IconTrash size={14} /> Für alle löschen
                </button>
              )}
            </div>
          )}

          {reactOpen && !msg.deleted && (
            <div
              className={`reaction-popover ${msg.fromMe ? "right" : "left"}`}
              onClick={(e) => e.stopPropagation()}
            >
              {QUICK_EMOJIS.map((e) => {
                const isCustom = typeof e === "string" && e.startsWith("data:image/");
                return (
                  <button
                    key={e}
                    type="button"
                    className={`reaction-popover-btn${
                      msg.myReaction === e ? " active" : ""
                    }${isCustom ? " has-custom" : ""}`}
                    onClick={() => toggleReaction(e)}
                    aria-label="Reagieren"
                    aria-pressed={msg.myReaction === e}
                  >
                    {isCustom ? <img src={e} alt="" /> : e}
                  </button>
                );
              })}
              <button
                type="button"
                className="reaction-popover-btn"
                onClick={() => {
                  setReactOpen(false);
                  setEmojiPickerOpen(true);
                }}
                aria-label="Mehr Emojis"
                title="Mehr Emojis"
              >
                ＋
              </button>
            </div>
          )}
        </div>
        {emojiPickerOpen && (
          <div className="reaction-emoji-overlay" onClick={(e) => e.stopPropagation()}>
            <EmojiPicker
              onPick={(emoji) => {
                onReact(msg, msg.myReaction === emoji ? "" : emoji);
                setEmojiPickerOpen(false);
              }}
              onClose={() => setEmojiPickerOpen(false)}
            />
          </div>
        )}

        {reactEntries.length > 0 && (
          <div className={`reactions-row ${msg.fromMe ? "end" : "start"}`}>
            {reactEntries.map(([e, n]) => {
              const isCustom = typeof e === "string" && e.startsWith("data:image/");
              return (
                <button
                  key={e}
                  type="button"
                  onClick={() => toggleReaction(e)}
                  className={`reaction-chip${
                    msg.myReaction === e ? " mine" : ""
                  }${isCustom ? " has-custom" : ""}`}
                  title={peerLabel}
                  aria-pressed={msg.myReaction === e}
                >
                  {isCustom ? (
                    <img src={e} alt="" className="reaction-chip-img" />
                  ) : (
                    <span>{e}</span>
                  )}{" "}
                  <span>{n}</span>
                </button>
              );
            })}
          </div>
        )}

        {threadReplyCount && threadReplyCount > 0 && onOpenThread && (
          <button
            type="button"
            className={`thread-indicator ${msg.fromMe ? "end" : "start"}${
              threadUnreadCount && threadUnreadCount > 0 ? " has-unread" : ""
            }`}
            onClick={() => onOpenThread(msg)}
            aria-label={`Thread mit ${threadReplyCount} ${
              threadReplyCount === 1 ? "Antwort" : "Antworten"
            }${
              threadUnreadCount && threadUnreadCount > 0
                ? `, ${threadUnreadCount} neu`
                : ""
            } öffnen`}
          >
            <span className="thread-indicator-icon">
              <IconMessageSquare size={13} />
            </span>
            <span>
              {threadReplyCount}{" "}
              {threadReplyCount === 1 ? "Antwort" : "Antworten"}
            </span>
            {threadUnreadCount && threadUnreadCount > 0 && (
              <span className="thread-indicator-badge">{threadUnreadCount}</span>
            )}
            <span className="thread-indicator-arrow">→</span>
          </button>
        )}
      </div>

      {imageOpen && isImage && (
        <div
          className="image-lightbox"
          onClick={() => setImageOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            className="image-lightbox-close"
            onClick={(e) => {
              e.stopPropagation();
              setImageOpen(false);
            }}
            aria-label="Schließen"
          >
            <IconX size={20} />
          </button>
          <img
            src={imageSrc}
            alt={msg.plain.fileName ?? "Bild"}
            onClick={(e) => e.stopPropagation()}
          />
          {msg.plain.fileName && (
            <a
              href={imageSrc}
              download={msg.plain.fileName}
              className="image-lightbox-download"
              onClick={(e) => e.stopPropagation()}
            >
              <IconDownload size={14} /> {msg.plain.fileName}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function computeTtlLeft(expiresAt?: number): string | null {
  if (!expiresAt) return null;
  const left = expiresAt - Date.now();
  if (left <= 0) return "0s";
  const s = Math.ceil(left / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
