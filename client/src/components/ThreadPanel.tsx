import { useEffect, useRef, useState } from "react";
import type { ChatMsg } from "../lib/incomingDm";
import { previewForPayload } from "../lib/messagePreview";
import { markThreadSeen } from "../lib/threadState";
import { IconX, IconSend, IconMessageSquare } from "./Icons";
import { MessageBubble } from "./MessageBubble";
import { t, useLocale } from "../lib/i18n";

export function ThreadPanel({
  parent,
  replies,
  resolveAuthor,
  onClose,
  onSend,
  onReact,
  onEdit,
  onDelete,
  onLocalDelete,
  onCopy,
  onForward,
  onJumpToCid,
}: {
  parent: ChatMsg;
  replies: ChatMsg[];
  resolveAuthor: (m: ChatMsg) => string;
  onClose: () => void;
  onSend: (text: string) => Promise<void>;
  onReact: (m: ChatMsg, emoji: string) => void;
  onEdit: (m: ChatMsg, body: string) => void;
  onDelete: (m: ChatMsg) => void;
  onLocalDelete: (m: ChatMsg) => void;
  onCopy: (text: string) => void;
  onForward: (m: ChatMsg) => void;
  onJumpToCid?: (cid: string) => void;
}) {
  useLocale();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
    // Mark this thread as seen up to the most recent reply timestamp.
    const cid = parent.plain.cid;
    if (cid) {
      const latest = replies.reduce((acc, r) => Math.max(acc, r.at), 0);
      markThreadSeen(cid, latest > 0 ? latest : Date.now());
    }
  }, [replies.length, parent.plain.cid, replies]);

  async function handleSend() {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await onSend(value);
      setText("");
      const el = inputRef.current;
      if (el) {
        el.style.height = "auto";
      }
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  const parentAuthor = resolveAuthor(parent);
  const parentPreview = previewForPayload(parent.plain);

  return (
    <aside
      className="thread-panel"
      role="complementary"
      aria-label="Thread"
    >
      <header className="thread-panel-header">
        <div className="thread-panel-title">
          <IconMessageSquare size={16} />
          <div>
            <p className="thread-panel-title-main">Thread</p>
            <p className="thread-panel-title-sub">
              {replies.length}{" "}
              {replies.length === 1 ? t("msg.replyCount1") : t("msg.replyCountN")}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="thread-panel-close"
          onClick={onClose}
          aria-label={t("chat.closeThread")}
        >
          <IconX size={18} />
        </button>
      </header>

      <div className="thread-panel-parent">
        <p className="thread-panel-parent-author">{parentAuthor}</p>
        <p className="thread-panel-parent-text">{parentPreview}</p>
      </div>

      <div className="thread-panel-body" data-thread-cid={parent.plain.cid}>
        {replies.length === 0 ? (
          <div className="thread-panel-empty">
            <IconMessageSquare
              size={28}
              aria-hidden
              style={{ opacity: 0.45, marginBottom: 8 }}
            />
            <p style={{ margin: 0 }}>
              {t("chat.threadEmpty")}
            </p>
          </div>
        ) : (
          replies.map((m, i) => {
            const isGrouped =
              i > 0 &&
              replies[i - 1].fromUserId === m.fromUserId &&
              replies[i - 1].fromMe === m.fromMe;
            const isLastInGroup =
              i === replies.length - 1 ||
              replies[i + 1].fromUserId !== m.fromUserId;
            return (
              <MessageBubble
                key={m.plain.cid ?? m.id}
                msg={m}
                isGrouped={isGrouped}
                isLastInGroup={isLastInGroup}
                peerLabel={resolveAuthor(m)}
                onReply={() => {
                  inputRef.current?.focus();
                }}
                onReact={onReact}
                onEdit={onEdit}
                onDelete={onDelete}
                onLocalDelete={onLocalDelete}
                onCopy={onCopy}
                onForward={onForward}
                onJumpToCid={onJumpToCid}
              />
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      <footer className="thread-panel-composer">
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              autoResize(e.currentTarget);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !(e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder={
              parent.fromMe
                ? t("chat.replyInThread")
                : t("chat.replyToName", { name: parentAuthor })
            }
            rows={1}
            maxLength={4000}
            autoFocus
          />
          {text.length > 3600 && (
            <span
              aria-live="polite"
              style={{
                fontSize: "0.7rem",
                color:
                  text.length > 3900 ? "var(--danger)" : "var(--text-muted)",
                alignSelf: "flex-end",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {text.length} / 4000
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={busy || !text.trim()}
          className="thread-panel-send"
          aria-label={t("chat.sendReply")}
          title={t("chat.sendReply")}
        >
          <IconSend size={16} />
        </button>
      </footer>
    </aside>
  );
}
