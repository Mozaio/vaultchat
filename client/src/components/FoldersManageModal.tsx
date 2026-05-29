import { useEffect, useState } from "react";
import type { ApiUser, ApiGroup } from "../lib/api";
import { type ChatFolder, newFolderId } from "../lib/chatFolders";
import { canAddFolder, getLimits } from "../lib/plan";
import { IconX, IconBookmark, IconUsers } from "./Icons";

type Props = {
  folders: ChatFolder[];
  users: ApiUser[];
  groups: ApiGroup[];
  /** Own userId — used to render Saved Messages as a selectable chat. */
  selfUserId: string;
  onClose: () => void;
  onSave: (next: ChatFolder[]) => void;
  editing: ChatFolder | null;
  setEditing: (folder: ChatFolder | null) => void;
};

const ICON_OPTIONS = [
  "📁", "📌", "⭐", "🔥", "💼",
  "🎯", "🏠", "💬", "🔒", "🚀",
  "📚", "🎨", "🎮", "🎵", "✈️",
];

export function FoldersManageModal({
  folders,
  users,
  groups,
  selfUserId,
  onClose,
  onSave,
  editing,
  setEditing,
}: Props) {
  const [draft, setDraft] = useState<ChatFolder | null>(editing);

  useEffect(() => {
    setDraft(editing);
  }, [editing]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (draft) setDraft(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, onClose]);

  function startNewFolder() {
    if (!canAddFolder(folders.length)) {
      const limit = getLimits().folderMax;
      window.alert(
        `Limit erreicht: ${limit} Ordner im aktuellen Plan. Upgrade auf Pro für mehr — siehe Einstellungen → Plan & Abo.`
      );
      return;
    }
    setDraft({
      id: newFolderId(),
      name: "",
      icon: "📁",
      chatKeys: [],
    });
  }

  function deleteFolder(id: string) {
    onSave(folders.filter((f) => f.id !== id));
    if (draft?.id === id) setDraft(null);
    if (editing?.id === id) setEditing(null);
  }

  function saveDraft() {
    if (!draft) return;
    if (!draft.name.trim()) return;
    const exists = folders.some((f) => f.id === draft.id);
    const next = exists
      ? folders.map((f) => (f.id === draft.id ? draft : f))
      : [...folders, draft];
    onSave(next);
    setDraft(null);
    setEditing(null);
  }

  function toggleChat(chatKey: string) {
    if (!draft) return;
    const has = draft.chatKeys.includes(chatKey);
    setDraft({
      ...draft,
      chatKeys: has
        ? draft.chatKeys.filter((k) => k !== chatKey)
        : [...draft.chatKeys, chatKey],
    });
  }

  return (
    <div
      className="u-modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="folders-modal-title"
    >
      <div
        className="app-surface u-modal-card w-full max-w-md rounded-2xl p-5"
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: "85vh", display: "flex", flexDirection: "column" }}
      >
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2
            id="folders-modal-title"
            className="text-lg font-semibold"
            style={{ color: "var(--text)" }}
          >
            {draft
              ? folders.some((f) => f.id === draft.id)
                ? "Ordner bearbeiten"
                : "Neuer Ordner"
              : "Ordner verwalten"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 hover:bg-[var(--bg-hover)]"
            style={{ color: "var(--text-muted)" }}
            aria-label="Schließen"
          >
            <IconX size={18} />
          </button>
        </div>

        {!draft ? (
          /* List view */
          <div className="flex-1 min-h-0 flex flex-col gap-3 overflow-hidden">
            {folders.length === 0 ? (
              <p
                className="py-6 text-center text-sm"
                style={{ color: "var(--text-muted)" }}
              >
                Noch keine Ordner. Erstelle einen, um Chats zu gruppieren.
              </p>
            ) : (
              <ul className="flex-1 space-y-1.5 overflow-y-auto">
                {folders.map((f) => (
                  <li
                    key={f.id}
                    className="flex items-center gap-2 rounded-lg border p-2"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <span aria-hidden style={{ fontSize: "1.1rem" }}>
                      {f.icon}
                    </span>
                    <span
                      className="flex-1 truncate text-sm font-medium"
                      style={{ color: "var(--text)" }}
                    >
                      {f.name}
                    </span>
                    <span
                      className="text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {f.chatKeys.length}
                    </span>
                    <button
                      type="button"
                      className="btn btn-secondary !px-2 !py-1 !text-xs"
                      onClick={() => setDraft(f)}
                    >
                      Bearbeiten
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger !px-2 !py-1 !text-xs"
                      onClick={() => deleteFolder(f.id)}
                    >
                      Löschen
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="btn btn-primary w-full"
              onClick={startNewFolder}
            >
              + Neuer Ordner
            </button>
          </div>
        ) : (
          /* Edit view */
          <div className="flex-1 min-h-0 flex flex-col gap-3 overflow-hidden">
            <div className="auth-input-group">
              <label htmlFor="folder-name">Name</label>
              <input
                id="folder-name"
                className="app-input"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="z.B. Familie, Arbeit, Privat"
                maxLength={40}
                autoFocus
              />
            </div>
            <div>
              <label
                className="mb-1.5 block text-xs font-medium"
                style={{ color: "var(--text-secondary)" }}
              >
                Icon
              </label>
              <div
                className="grid gap-1.5"
                style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}
              >
                {ICON_OPTIONS.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setDraft({ ...draft, icon: opt })}
                    className="grid place-items-center rounded-lg border text-lg transition"
                    style={{
                      aspectRatio: "1 / 1",
                      borderColor:
                        draft.icon === opt ? "var(--accent)" : "var(--border)",
                      background:
                        draft.icon === opt
                          ? "var(--accent-soft)"
                          : "transparent",
                      boxShadow:
                        draft.icon === opt
                          ? "0 0 0 1px var(--accent) inset"
                          : "none",
                    }}
                    aria-pressed={draft.icon === opt}
                    aria-label={`Icon ${opt}`}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 min-h-0 flex flex-col">
              <label
                className="mb-1.5 block text-xs font-medium"
                style={{ color: "var(--text-secondary)" }}
              >
                Chats in diesem Ordner ({draft.chatKeys.length})
              </label>
              <div
                className="flex-1 space-y-0.5 overflow-y-auto rounded-lg border p-1"
                style={{ borderColor: "var(--border)" }}
              >
                {(() => {
                  const selfKey = `dm:${selfUserId}`;
                  const selfChecked = draft.chatKeys.includes(selfKey);
                  return (
                    <label
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-[var(--bg-hover)]"
                      style={{ color: "var(--text)" }}
                    >
                      <input
                        type="checkbox"
                        checked={selfChecked}
                        onChange={() => toggleChat(selfKey)}
                      />
                      <IconBookmark size={14} />
                      <span className="truncate">Saved Messages</span>
                    </label>
                  );
                })()}
                {users.length === 0 && groups.length === 0 ? (
                  <p
                    className="py-3 text-center text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Saved Messages ist immer verfügbar. Füge Kontakte oder
                    Gruppen hinzu, um sie hier auszuwählen.
                  </p>
                ) : (
                  <>
                    {users.map((u) => {
                      const key = `dm:${u.id}`;
                      const checked = draft.chatKeys.includes(key);
                      return (
                        <label
                          key={key}
                          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-[var(--bg-hover)]"
                          style={{ color: "var(--text)" }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleChat(key)}
                          />
                          <IconBookmark size={14} />
                          <span className="truncate">{u.username}</span>
                        </label>
                      );
                    })}
                    {groups.map((g) => {
                      const key = `group:${g.id}`;
                      const checked = draft.chatKeys.includes(key);
                      return (
                        <label
                          key={key}
                          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-[var(--bg-hover)]"
                          style={{ color: "var(--text)" }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleChat(key)}
                          />
                          <IconUsers size={14} />
                          <span className="truncate">{g.name}</span>
                        </label>
                      );
                    })}
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                className="btn btn-secondary !px-3 !py-1.5 !text-xs"
                onClick={() => setDraft(null)}
              >
                Abbrechen
              </button>
              <button
                type="button"
                className="btn btn-primary !px-3 !py-1.5 !text-xs"
                onClick={saveDraft}
                disabled={!draft.name.trim()}
              >
                Speichern
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
