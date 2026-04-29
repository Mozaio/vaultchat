import { useEffect, useState, useRef } from "react";
import type { PlainPayload } from "../lib/crypto";
import {
  IconFileText,
  IconDownload,
  IconTimer,
  IconSmile,
  IconMoreVertical,
  IconMessageSquare,
  IconCheck,
  IconCheckCheck,
} from "./Icons";

export type ChatMsg = {
  id: string;
  fromMe: boolean;
  plain: PlainPayload;
  at: number;
  expiresAt?: number;
  /** Aggregierte Reaktionen: Emoji -> Anzahl. */
  reactions?: Record<string, number>;
  /** Enthält "mein Reaktions-Emoji" für Toggle-Anzeige. */
  myReaction?: string;
  /** True, wenn ein "delete"-Frame empfangen wurde. */
  deleted?: boolean;
  /** True, wenn ein "edit"-Frame den Body aktualisiert hat. */
  edited?: boolean;
  /** Lesebestätigung empfangen? */
  readByPeer?: boolean;
  /** Zustellung bestätigt? */
  deliveredToPeer?: boolean;
};

const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "🙏", "✅"];

function fmtDuration(ms?: number): string {
  if (!ms) return "";
  const s = Math.max(1, Math.round(ms / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${ss.toString().padStart(2, "0")}`;
}

function truncate(text: string, n = 64): string {
  if (!text) return "";
  return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

function formatFileSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function previewForPayload(p: PlainPayload): string {
  switch (p.kind) {
    case "text":
      return truncate(p.body ?? "");
    case "file":
      return `📎 ${p.fileName ?? "Datei"}`;
    case "voice":
      return `🎤 Sprachnachricht ${fmtDuration(p.durationMs)}`;
    default:
      return "";
  }
}

export function MessageBubble({
  msg,
  peerLabel,
  replyToPreview,
  isGrouped,
  isLastInGroup,
  onReply,
  onReact,
  onEdit,
  onDelete,
  onCopy,
}: {
  msg: ChatMsg;
  peerLabel: string;
  replyToPreview?: { author: string; text: string } | null;
  isGrouped?: boolean;
  isLastInGroup?: boolean;
  onReply: (m: ChatMsg) => void;
  onReact: (m: ChatMsg, emoji: string) => void;
  onEdit: (m: ChatMsg, newBody: string) => void;
  onDelete: (m: ChatMsg) => void;
  onCopy: (text: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [reactOpen, setReactOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(msg.plain.body ?? "");
  const [ttlLeft, setTtlLeft] = useState<string | null>(() =>
    computeTtlLeft(msg.expiresAt)
  );
  const bubbleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!msg.expiresAt) return;
    const h = setInterval(
      () => setTtlLeft(computeTtlLeft(msg.expiresAt)),
      1000
    );
    return () => clearInterval(h);
  }, [msg.expiresAt]);

  const body = msg.plain.body ?? "";
  const reacts = msg.reactions ?? {};
  const reactEntries = Object.entries(reacts).filter(([, n]) => n > 0);
  const canCopy = msg.plain.kind === "text" && Boolean(body);

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

  function toggleReaction(emoji: string) {
    onReact(msg, msg.myReaction === emoji ? "" : emoji);
    setReactOpen(false);
    setMenuOpen(false);
  }

  return (
    <div
      ref={bubbleRef}
      className={`message-wrapper group ${
        msg.fromMe ? "sent" : "received"
      }`}
    >
      <div
        className={`flex max-w-[min(85%,32rem)] flex-col ${
          msg.fromMe ? "items-end" : "items-start"
        }`}
      >
        {replyToPreview && (
          <div
            className="mb-1.5 max-w-full rounded-t-xl border-l-2 px-3 py-1.5 text-xs"
            style={{
              borderColor: "var(--accent)",
              background: "var(--bg-elevated)",
              color: "var(--text-secondary)",
            }}
          >
            <span style={{ color: "var(--accent)" }}>
              {replyToPreview.author}:{" "}
            </span>
            {truncate(replyToPreview.text, 120)}
          </div>
        )}

        <div
          className={`message-bubble relative ${
            msg.fromMe ? "sent" : "received"
          } max-w-full ${msg.deleted ? "italic opacity-60" : ""} ${
            isGrouped ? "grouped" : ""
          } ${isLastInGroup ? "last-in-group" : ""
          }`}
        >
          {msg.deleted ? (
            <span className="italic">Nachricht gelöscht</span>
          ) : editing ? (
            <div className="flex items-center gap-2">
              <input
                className="app-input w-full rounded-md border border-[color:var(--border)] px-2 py-1"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (editValue.trim() && editValue.trim() !== body) {
                      onEdit(msg, editValue.trim());
                    }
                    setEditing(false);
                  } else if (e.key === "Escape") {
                    setEditing(false);
                    setEditValue(body);
                  }
                }}
              />
              <button
                type="button"
                className="text-xs app-muted hover:app-fg"
                onClick={() => {
                  setEditing(false);
                  setEditValue(body);
                }}
              >
                Esc
              </button>
            </div>
          ) : msg.plain.kind === "file" ? (
            <div className="file-attachment-card">
              <div className="file-icon-wrapper">
                <IconFileText size={18} />
              </div>
              <div className="file-info">
                <div className="file-name">{msg.plain.fileName ?? "Datei"}</div>
                <div className="file-size">{formatFileSize(msg.plain.fileSize)}</div>
              </div>
              <a
                href={body}
                download={msg.plain.fileName}
                className="download-btn"
                onClick={(e) => e.stopPropagation()}
              >
                <IconDownload size={14} />
              </a>
            </div>
          ) : msg.plain.kind === "voice" ? (
            <div className="voice-message">
              <div className="play-btn">▶</div>
              <audio controls src={body} className="h-8 flex-1 max-w-[180px]" />
              <span className="text-xs opacity-70">{fmtDuration(msg.plain.durationMs)}</span>
            </div>
          ) : (
            <p className="whitespace-pre-wrap break-words">{body}</p>
          )}

          {/* Timestamp and status */}
          <div className="bubble-meta">
            {ttlLeft && (
              <span className="disappearing-timer">
                <IconTimer size={10} />
                {ttlLeft}
              </span>
            )}
            <span>
              {new Date(msg.at).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            {msg.edited && !msg.deleted && <span>(bearbeitet)</span>}
            {msg.fromMe && !msg.deleted && (
              <span className="status-icon" title={msg.readByPeer ? "Gelesen" : msg.deliveredToPeer ? "Zugestellt" : "Gesendet"}>
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

          {/* Menu button */}
          {!msg.deleted && (
            <div
              className={`message-action-bar ${
                msg.fromMe ? "from-me" : "from-peer"
              }`}
            >
              <button
                type="button"
                aria-label="Reagieren"
                title="Reagieren"
                onClick={(e) => {
                  e.stopPropagation();
                  setReactOpen((v) => !v);
                  setMenuOpen(false);
                }}
                className="message-action-button"
              >
                <IconSmile size={15} />
              </button>
              <button
                type="button"
                aria-label="Antworten"
                title="Antworten"
                onClick={(e) => {
                  e.stopPropagation();
                  onReply(msg);
                  setMenuOpen(false);
                  setReactOpen(false);
                }}
                className="message-action-button"
              >
                <IconMessageSquare size={15} />
              </button>
              <button
                type="button"
                aria-label="Mehr"
                title="Mehr"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen((v) => !v);
                  setReactOpen(false);
                }}
                className="message-action-button"
              >
                <IconMoreVertical size={15} />
              </button>
            </div>
          )}

          {menuOpen && !msg.deleted && (
            <div
              className={`message-context-menu ${
                msg.fromMe ? "-right-2" : "-left-2"
              }`}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="message-context-item"
                onClick={() => {
                  onReply(msg);
                  setMenuOpen(false);
                }}
              >
                <IconSmile size={14} /> Antworten
              </button>
              <button
                type="button"
                className="message-context-item"
                onClick={() => {
                  setReactOpen(true);
                  setMenuOpen(false);
                }}
              >
                😊 Reagieren
              </button>
              {canCopy && (
                <button
                  type="button"
                  className="message-context-item"
                  onClick={() => {
                    onCopy(body);
                    setMenuOpen(false);
                  }}
                >
                  Kopieren
                </button>
              )}
              {msg.fromMe && msg.plain.kind === "text" && (
                <button
                  type="button"
                  className="message-context-item"
                  onClick={() => {
                    setEditing(true);
                    setMenuOpen(false);
                  }}
                >
                  Bearbeiten
                </button>
              )}
              {msg.fromMe && (
                <button
                  type="button"
                  className="message-context-item danger"
                  onClick={() => {
                    onDelete(msg);
                    setMenuOpen(false);
                  }}
                >
                  Für alle löschen
                </button>
              )}
            </div>
          )}

          {reactOpen && !msg.deleted && (
            <div
              className={`reaction-popover ${
                msg.fromMe ? "right-0" : "left-0"
              }`}
              onClick={(e) => e.stopPropagation()}
            >
              {QUICK_EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  className={`reaction-button ${msg.myReaction === e ? "active" : ""}`}
                  aria-pressed={msg.myReaction === e}
                  title={msg.myReaction === e ? "Reaktion entfernen" : `Mit ${e} reagieren`}
                  onClick={() => toggleReaction(e)}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>

        {reactEntries.length > 0 && (
          <div className={`mt-1 flex gap-1 ${msg.fromMe ? "justify-end" : "justify-start"}`}>
            {reactEntries.map(([e, n]) => (
              <button
                key={e}
                type="button"
                onClick={() => toggleReaction(e)}
                className={`reaction-chip ${msg.myReaction === e ? "active" : ""}`}
                aria-pressed={msg.myReaction === e}
                title={peerLabel}
              >
                {e} {n}
              </button>
            ))}
          </div>
        )}
      </div>
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
