/**
 * Custom chat folders. Each folder has a name, an emoji-or-letter icon,
 * and a list of chatKeys ("dm:<userId>" or "group:<groupId>").
 *
 * Folders live in localStorage only — they're a per-device personal
 * organisation tool, not synced through the server. That keeps the
 * server out of the loop for what would otherwise be metadata.
 */

const STORAGE_KEY = "vaultchat.folders";
const CHANGED_EVENT = "vaultchat:foldersChanged";

export type ChatFolder = {
  id: string;
  name: string;
  /** Single emoji / character used as a tiny icon. Defaults to "📁". */
  icon: string;
  /** Members: "dm:<userId>" or "group:<groupId>". */
  chatKeys: string[];
};

function isValidFolder(x: unknown): x is ChatFolder {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    typeof o.icon === "string" &&
    Array.isArray(o.chatKeys) &&
    o.chatKeys.every((k) => typeof k === "string")
  );
}

export function loadFolders(): ChatFolder[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidFolder);
  } catch {
    return [];
  }
}

export function saveFolders(folders: ChatFolder[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(folders));
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: folders }));
  } catch {
    /* ignore */
  }
}

export function subscribeFolders(
  listener: (folders: ChatFolder[]) => void
): () => void {
  const handler = (ev: Event) => {
    const detail = (ev as CustomEvent<ChatFolder[]>).detail;
    if (Array.isArray(detail)) listener(detail);
  };
  window.addEventListener(CHANGED_EVENT, handler);
  return () => window.removeEventListener(CHANGED_EVENT, handler);
}

export function newFolderId(): string {
  return (
    (globalThis.crypto?.randomUUID?.() as string | undefined) ??
    `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  );
}

/**
 * Helper: returns true when the chatKey belongs to the folder. Use for
 * filtering visible peers/groups when a folder filter is active.
 */
export function folderContains(
  folder: ChatFolder,
  chatKey: string
): boolean {
  return folder.chatKeys.includes(chatKey);
}

/** Add or remove a chat from a folder, returns the new folder list. */
export function toggleChatInFolder(
  folders: ChatFolder[],
  folderId: string,
  chatKey: string
): ChatFolder[] {
  return folders.map((f) => {
    if (f.id !== folderId) return f;
    const has = f.chatKeys.includes(chatKey);
    return {
      ...f,
      chatKeys: has
        ? f.chatKeys.filter((k) => k !== chatKey)
        : [...f.chatKeys, chatKey],
    };
  });
}
