import { useEffect, useMemo, useRef, useState } from "react";
import type { PlainPayload } from "../lib/crypto";
import { userGradient } from "../lib/chatHelpers";
import { safeMediaSrc } from "../lib/safeMedia";
import { t, useLocale } from "../lib/i18n";
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
  IconLink,
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
import { useFocusTrap } from "../lib/useFocusTrap";
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
  /** Gruppen: IDs der Mitglieder, die diese Nachricht gelesen haben (für
   *  "Gelesen von N/M"). Bei DMs ungenutzt (dort zählt readByPeer). */
  readByUserIds?: string[];
  /** Nur bei kind === "poll": votes pro Option-Index, gesammelt aus
   *  poll-vote frames. Letzter vote pro voter gewinnt. */
  pollVotes?: number[];
  /** Mein eigener Vote-Index, falls ich abgestimmt habe. */
  myPollVote?: number;
};

export const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

export { previewForPayload } from "../lib/messagePreview";

const EMOJI_PICTO_RE = /\p{Extended_Pictographic}/u;

/**
 * Discord/iMessage-Style "jumbo emoji": eine Nachricht, die nur aus wenigen
 * Emojis besteht, wird größer gerendert. Liefert ein Größen-Level (0 = normal,
 * 3 = am größten). Gemischter Text (Buchstaben/Ziffern) oder >6 Emojis ⇒ 0.
 */
function jumboEmojiLevel(text: string): 0 | 1 | 2 | 3 {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 80) return 0;
  if (!EMOJI_PICTO_RE.test(trimmed)) return 0;
  let clusters: string[];
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    clusters = Array.from(seg.segment(trimmed), (s) => s.segment);
  } catch {
    clusters = Array.from(trimmed);
  }
  let emoji = 0;
  for (const c of clusters) {
    if (/^\s+$/u.test(c)) continue;
    if (EMOJI_PICTO_RE.test(c)) {
      emoji++;
      continue;
    }
    // A visible, non-emoji cluster (letter, digit, punctuation) ⇒ not emoji-only.
    return 0;
  }
  if (emoji === 0) return 0;
  if (emoji <= 2) return 3;
  if (emoji <= 4) return 2;
  if (emoji <= 6) return 1;
  return 0;
}

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
        aria-label={playing ? t("msg.pause") : t("msg.play")}
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
  onReveal,
  onPollVote,
  threadReplyCount,
  threadUnreadCount,
  onOpenThread,
  groupAvatar,
  groupReadTotal,
  groupReadNames,
}: {
  msg: ChatMsg;
  peerLabel: string;
  /** Group chats only: "show" renders the sender avatar + name at the start
   *  of a received run; "space" indents continuation bubbles to align. DMs
   *  pass nothing (kept clean). */
  groupAvatar?: "show" | "space";
  /** Group chats only: number of OTHER members (memberIds minus self). When
   *  set on a sent message, the meta shows "Gelesen N/M" instead of the
   *  single read tick. */
  groupReadTotal?: number;
  /** Group chats only: display names of members who have read this message
   *  (for the hover tooltip on the read indicator). */
  groupReadNames?: string[];
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
  /** Fired the moment a view-once message is revealed, so the caller can
   *  durably purge the stored copy (IndexedDB) immediately — the in-memory
   *  copy stays visible for the brief reveal window. Prevents a reload from
   *  resurrecting an already-viewed message. */
  onReveal?: (m: ChatMsg) => void;
  /** Cast a vote on a poll message at the given option index. */
  onPollVote?: (m: ChatMsg, optionIndex: number) => void;
  /** Number of thread replies to this message (only shown on parents). */
  threadReplyCount?: number;
  /** Number of replies arrived after the user last opened this thread. */
  threadUnreadCount?: number;
  /** Click handler to open the thread side panel. */
  onOpenThread?: (m: ChatMsg) => void;
}) {
  useLocale(); // re-render on language change
  const [menuOpen, setMenuOpen] = useState(false);
  const [reactOpen, setReactOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(msg.plain.body ?? "");
  const [ttlLeft, setTtlLeft] = useState<string | null>(() =>
    computeTtlLeft(msg.expiresAt)
  );
  const [imageOpen, setImageOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
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
    const h = setInterval(() => {
      const next = computeTtlLeft(msg.expiresAt);
      setTtlLeft(next);
      // Nach Ablauf liefert computeTtlLeft dauerhaft "0s" — Interval stoppen,
      // sonst re-rendert jede abgelaufene Bubble bis zum Parent-Unmount sekündlich.
      if (next === null || next === "0s") clearInterval(h);
    }, 1000);
    return () => clearInterval(h);
  }, [msg.expiresAt]);

  // View-once countdown: once revealed, count down VIEW_ONCE_REVEAL_MS and
  // then trigger a local-only delete. Only runs for non-sender (recipient).
  // msg/onLocalDelete laufen über Refs statt über die Dependencies: die
  // Callback-Props sind Inline-Arrows aus ChatShell (neue Identität bei
  // jedem Parent-Render) — stünden sie in den Deps, würde jeder Render
  // (Tippen, Typing-Indicator, …) den 10s-Timer auf Anfang zurücksetzen
  // und die Nachricht löschte sich nie. msg.deleted bleibt in den Deps:
  // Menü-Löschung während des Countdowns → Effekt-Neustart → Guard greift.
  const onLocalDeleteRef = useRef(onLocalDelete);
  onLocalDeleteRef.current = onLocalDelete;
  const msgRef = useRef(msg);
  msgRef.current = msg;
  useEffect(() => {
    const m = msgRef.current;
    if (!revealed || m.fromMe || !m.plain.viewOnce || m.deleted) return;
    const start = Date.now();
    setViewOnceLeftMs(VIEW_ONCE_REVEAL_MS);
    const tick = window.setInterval(() => {
      const left = VIEW_ONCE_REVEAL_MS - (Date.now() - start);
      if (left <= 0) {
        window.clearInterval(tick);
        setViewOnceLeftMs(0);
        onLocalDeleteRef.current?.(msgRef.current);
      } else {
        setViewOnceLeftMs(left);
      }
    }, 250);
    return () => window.clearInterval(tick);
  }, [revealed, msg.id, msg.deleted]);

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
  // Inline preview prefers the small, sealed thumbnail (Phase 4.3) so the
  // bubble paints instantly without decoding the full-size image; the
  // lightbox still opens the full `imageSrc`. Peer-controlled, so sanitize.
  const thumbSrc =
    isImage && msg.plain.thumb
      ? safeMediaSrc(msg.plain.thumb, "image")
      : "";
  const previewSrc = thumbSrc || imageSrc;
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
          onClick={() => {
            // Purge the durable copy the instant it's revealed so a reload
            // can't resurrect it; the in-memory copy stays for the countdown.
            onReveal?.(msg);
            setRevealed(true);
          }}
          aria-label={t("msg.viewOnceOpen")}
        >
          <IconLock size={14} />
          <span>{t("msg.viewOnceTapOpen")}</span>
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
    const who = msg.fromMe ? t("chat.you") : peerLabel;
    if (msg.deleted) return `${who}: ${t("msg.ariaDeleted")}`;
    if (msg.plain.kind === "voice") return `${who}: ${t("chat.voiceMessage")}`;
    if (msg.plain.kind === "file")
      return `${who}: ${t("msg.ariaFile", { name: msg.plain.fileName ?? "" })}`;
    const text = msg.plain.body ?? "";
    const trimmed = text.length > 80 ? text.slice(0, 80) + "…" : text;
    return `${who}: ${trimmed || t("msg.ariaEmpty")}`;
  })();

  return (
    <div
      ref={bubbleRef}
      data-cid={msg.plain.cid}
      role="article"
      aria-label={ariaLabel}
      className={`message-wrapper group ${msg.fromMe ? "sent" : "received"}${
        isHighlighted ? " highlighted" : ""
      }${groupAvatar ? " with-av" : ""}${isGrouped ? " grouped" : ""}`}
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
            title={replyToPreview.cid ? t("msg.jumpTo") : undefined}
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
            msg.plain.kind === "text" && !msg.deleted && !editing
              ? " is-text"
              : ""
          }${flipUp ? " menu-flip-up" : ""}`}
          onDoubleClick={(e) => {
            if (!msg.deleted && msg.plain.kind === "text") {
              e.stopPropagation();
              onReact(msg, msg.myReaction === "👍" ? "" : "👍");
            }
          }}
        >
          {msg.deleted ? (
            <span className="bubble-deleted">
              <IconTrash size={12} aria-hidden /> {t("msg.deleted")}
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
              aria-label={t("msg.openImage")}
            >
              <img
                src={previewSrc}
                alt={msg.plain.fileName ?? t("msg.imageFallback")}
                className="image-attachment-img"
                loading="lazy"
                draggable={false}
                {...(msg.plain.width && msg.plain.height
                  ? { width: msg.plain.width, height: msg.plain.height }
                  : {})}
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
                  {msg.plain.fileName ?? t("chat.fileFallback")}
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
                  aria-label={t("msg.download")}
                >
                  <IconDownload size={14} />
                </a>
              ) : (
                <span
                  className="download-btn"
                  aria-label={t("msg.attachBlocked")}
                  title={t("msg.attachBlockedTitle")}
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
                            // Clicking your current choice again withdraws the
                            // vote (-1 sentinel); otherwise (re)cast for `i`.
                            onPollVote?.(msg, mine ? -1 : i);
                          }}
                          aria-pressed={mine}
                          title={mine ? t("msg.withdrawVote") : undefined}
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
                    {total === 1 ? t("msg.vote1") : t("msg.voteN", { n: total })}
                  </p>
                </div>
              );
            })()
          ) : (
            <>
              {(() => {
                const jumbo = msg.deleted ? 0 : jumboEmojiLevel(body);
                // Collapse walls of text (Discord-style) so they don't dominate
                // the thread. Long = many chars or many lines.
                const isLong =
                  !msg.deleted &&
                  !jumbo &&
                  (body.length > 700 || body.split("\n").length > 18);
                return (
                  <>
                    <p
                      className={`bubble-text${
                        jumbo ? ` emoji-jumbo emoji-jumbo-${jumbo}` : ""
                      }${isLong && !expanded ? " clamped" : ""}`}
                    >
                      {renderInlineMarkdown(body)}
                    </p>
                    {isLong && (
                      <button
                        type="button"
                        className="bubble-expand-toggle"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpanded((v) => !v);
                        }}
                      >
                        {expanded ? t("msg.showLess") : t("msg.showMore")}
                      </button>
                    )}
                  </>
                );
              })()}
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
                          <span className="link-preview-host">
                            <IconLink size={11} aria-hidden /> {host}
                          </span>
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
              <span className="meta-star" title={t("msg.starred")}>
                <IconBookmark size={11} />
              </span>
            )}
            {isViewOnce && (
              <span
                className="disappearing-timer"
                title={
                  msg.fromMe
                    ? t("msg.viewOnceRecipient")
                    : viewOnceLeftMs !== null
                      ? t("msg.disappearsOnClose")
                      : t("msg.viewOnceShort")
                }
              >
                <IconLock size={10} />
                {viewOnceLeftMs !== null
                  ? `${Math.max(0, Math.ceil(viewOnceLeftMs / 1000))}s`
                  : "1×"}
              </span>
            )}
            {ttlLeft && (
              <span className="disappearing-timer" title={t("msg.disappearsSoon")}>
                <IconTimer size={10} />
                {ttlLeft}
              </span>
            )}
            {msg.edited && !msg.deleted && (
              <span className="meta-edited">{t("msg.edited")}</span>
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
            {msg.fromMe && !msg.deleted && groupReadTotal === undefined && (
              <span
                className="status-icon"
                title={
                  msg.readByPeer
                    ? t("msg.read")
                    : msg.deliveredToPeer
                      ? t("msg.delivered")
                      : t("msg.sent")
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
            {msg.fromMe &&
              !msg.deleted &&
              groupReadTotal !== undefined &&
              (() => {
                // Gruppen-Lese-Status: "Gelesen N/M" (Signal MessageDetail-lite).
                const readCount = msg.readByUserIds?.length ?? 0;
                const allRead = groupReadTotal > 0 && readCount >= groupReadTotal;
                return (
                  <span
                    className="status-icon"
                    title={
                      groupReadNames && groupReadNames.length > 0
                        ? `${t("msg.read")}: ${groupReadNames.join(", ")}`
                        : t("msg.groupReadTitle", {
                            n: String(readCount),
                            total: String(groupReadTotal),
                          })
                    }
                  >
                    <IconCheckCheck
                      size={13}
                      className={allRead ? "read" : "delivered"}
                    />
                    {groupReadTotal > 0 && (
                      <span className="group-read-count">
                        {readCount}/{groupReadTotal}
                      </span>
                    )}
                  </span>
                );
              })()}
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
                aria-label={t("msg.react")}
                title={t("msg.react")}
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
                aria-label={t("msg.reply")}
                title={t("msg.reply")}
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
                aria-label={t("chat.more")}
                title={t("chat.more")}
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
                <IconReply size={14} /> {t("msg.reply")}
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
                  <IconMessageSquare size={14} /> {t("msg.replyThread")}
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
                  <IconForward size={14} /> {t("msg.forward")}
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
                  {isStarred ? t("msg.unstar") : t("msg.star")}
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
                  {isPinned ? t("msg.unpin") : t("msg.pin")}
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
                  <IconCopy size={14} /> {t("msg.copy")}
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
                  <IconEdit size={14} /> {t("msg.edit")}
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
                  <IconTrash size={14} /> {t("msg.deleteForAll")}
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
                    aria-label={t("msg.react")}
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
                aria-label={t("msg.moreEmojis")}
                title={t("msg.moreEmojis")}
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
            aria-label={t("msg.threadAria", {
              count: threadReplyCount ?? 0,
              replies:
                threadReplyCount === 1
                  ? t("msg.replyCount1")
                  : t("msg.replyCountN"),
              unread:
                threadUnreadCount && threadUnreadCount > 0
                  ? t("msg.threadNew", { n: threadUnreadCount })
                  : "",
            })}
          >
            <span className="thread-indicator-icon">
              <IconMessageSquare size={13} />
            </span>
            <span>
              {threadReplyCount}{" "}
              {threadReplyCount === 1 ? t("msg.replyCount1") : t("msg.replyCountN")}
            </span>
            {threadUnreadCount && threadUnreadCount > 0 && (
              <span className="thread-indicator-badge">{threadUnreadCount}</span>
            )}
            <span className="thread-indicator-arrow">→</span>
          </button>
        )}
      </div>

      {imageOpen && isImage && (
        <ImageLightbox
          src={imageSrc}
          fileName={msg.plain.fileName}
          onClose={() => setImageOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Vollbild-Lightbox für Bilder. Eigene Komponente, damit die Fokus-Falle
 * sauber mit dem geöffneten Dialog mountet/unmountet (statt einen Ref pro
 * Bubble dauerhaft zu halten). Schließt per Klick auf den Hintergrund, per
 * Schließen-Button und per Escape; Tab-Fokus bleibt im Dialog.
 */
function ImageLightbox({
  src,
  fileName,
  onClose,
}: {
  src: string;
  fileName?: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="image-lightbox"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={fileName ?? t("msg.imageFallback")}
    >
      <button
        type="button"
        className="image-lightbox-close"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label={t("common.close")}
      >
        <IconX size={20} />
      </button>
      <img
        src={src}
        alt={fileName ?? t("msg.imageFallback")}
        onClick={(e) => e.stopPropagation()}
      />
      {fileName && (
        <a
          href={src}
          download={fileName}
          className="image-lightbox-download"
          onClick={(e) => e.stopPropagation()}
        >
          <IconDownload size={14} /> {fileName}
        </a>
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
