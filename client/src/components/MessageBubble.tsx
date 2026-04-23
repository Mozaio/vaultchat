import { useEffect, useState } from "react";
import type { PlainPayload } from "../lib/crypto";

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

const QUICK_EMOJIS = ["👍", "❤️", "😂", "🎉", "😮", "😢", "🙏", "🔥"];

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
  onReply,
  onReact,
  onEdit,
  onDelete,
  onCopy,
}: {
  msg: ChatMsg;
  peerLabel: string;
  replyToPreview?: { author: string; text: string } | null;
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

  return (
    <div
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
          } max-w-full ${msg.deleted ? "italic app-muted-2" : ""}`}
        >
          {msg.deleted ? (
            <span>Nachricht gelöscht</span>
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
            <a
              className="underline"
              style={{
                color: msg.fromMe ? "inherit" : "var(--accent)",
              }}
              href={body}
              download={msg.plain.fileName}
            >
              📎 {msg.plain.fileName ?? "Datei"}
            </a>
          ) : msg.plain.kind === "voice" ? (
            <div className="flex items-center gap-2">
              <span
                className="text-xs"
                style={{ color: msg.fromMe ? "inherit" : "var(--accent)" }}
              >
                🎤 {fmtDuration(msg.plain.durationMs)}
              </span>
              <audio controls src={body} className="h-8 max-w-[220px]" />
            </div>
          ) : (
            <p className="whitespace-pre-wrap break-words">{body}</p>
          )}

            <div className="mt-1 flex items-center gap-2 text-[10px] app-muted">
            <span>
              {new Date(msg.at).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            {msg.edited && !msg.deleted && <span>(bearbeitet)</span>}
            {ttlLeft && <span>⏳ {ttlLeft}</span>}
            {msg.fromMe && !msg.deleted && (
              <span title={msg.readByPeer ? "Gelesen" : msg.deliveredToPeer ? "Zugestellt" : "Gesendet"}>
                {msg.readByPeer ? "✓✓" : msg.deliveredToPeer ? "✓✓" : "✓"}
              </span>
            )}
          </div>

          {!msg.deleted && (
            <button
              type="button"
              aria-label="Menü"
              onClick={() => {
                setMenuOpen((v) => !v);
                setReactOpen(false);
              }}
              className={`absolute -top-2 ${
                msg.fromMe ? "-right-8" : "-left-8"
              } hidden rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 group-hover:block`}
            >
              ⋯
            </button>
          )}

          {menuOpen && !msg.deleted && (
            <div
              className={`absolute top-8 z-10 w-40 rounded-lg border border-zinc-700 bg-zinc-900 p-1 text-xs shadow-xl ${
                msg.fromMe ? "right-0" : "left-0"
              }`}
            >
              <button
                type="button"
                className="block w-full rounded px-2 py-1.5 text-left text-zinc-200 hover:bg-zinc-800"
                onClick={() => {
                  onReply(msg);
                  setMenuOpen(false);
                }}
              >
                Antworten
              </button>
              <button
                type="button"
                className="block w-full rounded px-2 py-1.5 text-left text-zinc-200 hover:bg-zinc-800"
                onClick={() => {
                  setReactOpen(true);
                }}
              >
                Reagieren
              </button>
              {msg.plain.kind === "text" && body && (
                <button
                  type="button"
                  className="block w-full rounded px-2 py-1.5 text-left text-zinc-200 hover:bg-zinc-800"
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
                  className="block w-full rounded px-2 py-1.5 text-left text-zinc-200 hover:bg-zinc-800"
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
                  className="block w-full rounded px-2 py-1.5 text-left text-red-300 hover:bg-red-950/50"
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
              className={`absolute top-8 z-10 flex gap-1 rounded-lg border border-zinc-700 bg-zinc-900 p-1 text-lg shadow-xl ${
                msg.fromMe ? "right-0" : "left-0"
              }`}
            >
              {QUICK_EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  className={`rounded px-1 hover:bg-zinc-800 ${
                    msg.myReaction === e ? "bg-emerald-900/60" : ""
                  }`}
                  onClick={() => {
                    onReact(msg, msg.myReaction === e ? "" : e);
                    setReactOpen(false);
                    setMenuOpen(false);
                  }}
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
                onClick={() => onReact(msg, msg.myReaction === e ? "" : e)}
                className={`rounded-full border px-2 py-0.5 text-xs ${
                  msg.myReaction === e
                    ? "border-emerald-500/50 bg-emerald-900/40 text-emerald-100"
                    : "border-zinc-700 bg-zinc-900 text-zinc-300"
                }`}
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
