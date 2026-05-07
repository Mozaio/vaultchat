import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "../lib/sessionHelpers";
import * as api from "../lib/api";
import { decryptIncomingSealedDmWithReplayCheck } from "../lib/incomingDm";
import { drEncryptJsonForDm } from "../lib/drSession";
import { getWsUrl } from "../lib/wsUrl";
import {
  fingerprintFromPublicKeyB64,
  type PlainPayload,
} from "../lib/crypto";
import { base64FromUint8, uint8FromBase64 } from "../lib/b64";
import {
  idbDeleteDm,
  idbDeleteGroupMsg,
  idbListDm,
  idbListGroup,
  idbPutDm,
  idbPutGroupMsg,
  idbPurgeExpired,
  metaGet,
  metaSet,
} from "../lib/idb";
import {
  decryptGroupPayload,
  encryptGroupPayload,
  getGroupKeyState,
  initGroupKeyState,
  randomGroupKey,
  setGroupKey,
} from "../lib/groupCrypto";
import { acceptCall, startCall, type RtcPayload } from "../lib/webrtc";
import { sealSender } from "../lib/sealedSender";
import { startCoverTraffic } from "../lib/coverTraffic";
import {
  outboxAdd,
  outboxList,
  outboxGetMeta,
  outboxRemove,
  outboxAttempt,
} from "../lib/outbox";
import { observePeerKey, getPin, type PeerPin } from "../lib/trust";
import { isGroupMessageDuplicate } from "../lib/replayProtection";
import {
  generateKeyMaterial,
  loadKeyMaterial,
  replenishOneTimePreKeys,
  saveKeyMaterial,
  toUploadBody,
} from "../lib/keyStore";
import { encryptIdentityBackup } from "../lib/backup";
import { loadLocalIdentity } from "../lib/localIdentity";
import { previewForPayload } from "../lib/messagePreview";
import {
  MessageBubble,
  type ChatMsg,
} from "./MessageBubble";
import {
  authoredFromDm,
  authoredFromGroup,
  reduceChatMessages,
} from "../lib/chatReducer";
import { SafetyNumberDialog } from "./SafetyNumberDialog";
import { useVoiceRecorder } from "../lib/useVoiceRecorder";
import { ThemeToggle } from "./ThemeToggle";
import { useShortcuts } from "../lib/shortcuts";
import { loadDefaultTtl } from "../lib/disappearingDefault";
import {
  loadFolders,
  saveFolders,
  subscribeFolders,
  newFolderId,
  type ChatFolder,
} from "../lib/chatFolders";
import { SearchPanel } from "./SearchPanel";
import { AddContactModal } from "./AddContactModal";
import {
  SecuritySettings,
  NOTIFY_PREVIEW_STORAGE_KEY,
  NOTIFY_STORAGE_KEY,
} from "./SecuritySettings";
import { ChatEmptyState } from "./ChatEmptyState";
import { ThreadPanel } from "./ThreadPanel";
import { EmojiPicker } from "./EmojiPicker";
import { OnboardingOverlay, readOnboardingPending } from "./OnboardingOverlay";
import { ToastRegion } from "./ToastRegion";
import { VaultChatLogo } from "./Logo";
import { FoldersManageModal } from "./FoldersManageModal";
import { ShortcutsHelpModal } from "./ShortcutsHelpModal";
import { pushToast } from "../lib/toastBus";
import {
  IconArrowDown,
  IconBan,
  IconBarChart,
  IconBell,
  IconBookmark,
  IconCopy,
  IconFileText,
  IconForward,
  IconImage,
  IconInfo,
  IconHelpCircle,
  IconLock,
  IconMic,
  IconMoreVertical,
  IconPaperclip,
  IconPin,
  IconPlus,
  IconPhone,
  IconRefreshCw,
  IconSearch,
  IconSend,
  IconSettings,
  IconShield,
  IconShieldCheck,
  IconSmile,
  IconStar,
  IconUserPlus,
  IconUsers,
  IconVolumeMute,
  IconWifiOff,
  IconX,
} from "./Icons";

type Tab = "dm" | "group";
type SidebarFilter =
  | "all"
  | "dm"
  | "group"
  | "fav"
  | "unread"
  | "star"
  | `folder:${string}`;
type CallStatus = "idle" | "ringing" | "connecting" | "connected" | "failed" | "ended";
type SharedMediaItem = {
  id: string;
  kind: "file" | "voice";
  name: string;
  href: string;
  at: number;
};

function loadStringSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveStringSet(key: string, value: Set<string>) {
  localStorage.setItem(key, JSON.stringify(Array.from(value)));
}

function isBackupReminderDismissed(): boolean {
  try {
    return localStorage.getItem("vaultchat.backupReminder.dismissed") === "1";
  } catch {
    return true;
  }
}

type ReplyTarget = {
  cid: string;
  author: string;
  text: string;
  expiresAt?: number;
} | null;

const TTL_OPTIONS: { label: string; ms: number }[] = [
  { label: "Aus", ms: 0 },
  { label: "30 s", ms: 30_000 },
  { label: "5 min", ms: 5 * 60_000 },
  { label: "1 h", ms: 60 * 60_000 },
  { label: "1 Tag", ms: 24 * 60 * 60_000 },
  { label: "7 Tage", ms: 7 * 24 * 60 * 60_000 },
];

function newCid(): string {
  return (
    (globalThis.crypto?.randomUUID?.() as string | undefined) ??
    Math.random().toString(36).slice(2)
  );
}

/** Weiterleitung als neuer DM-Frame (nur Text/Datei). */
function buildForwardPayloadForSend(
  m: ChatMsg,
  sessionUserId: string,
  dmPeerId: string | null
): PlainPayload | null {
  const p = m.plain;
  if (p.kind !== "text" && p.kind !== "file") return null;
  const origin = m.fromMe
    ? sessionUserId
    : (m.fromUserId ?? dmPeerId ?? "");
  return {
    v: 2,
    cid: newCid(),
    kind: p.kind,
    body: p.body,
    ...(p.kind === "file"
      ? { fileName: p.fileName, mime: p.mime, fileSize: p.fileSize }
      : {}),
    ...(origin ? { forwardedFromUserId: origin } : {}),
  };
}

/** Discord-like deterministic avatar color from user ID */
function userColor(userId: string): string {
  const colors = [
    "#ef4444", "#f97316", "#f59e0b", "#84cc16", "#10b981",
    "#06b6d4", "#3b82f6", "#6366f1", "#8b5cf6", "#d946ef",
    "#f43f5e", "#14b8a6", "#0ea5e9", "#a855f7", "#ec4899",
  ];
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const idx = Math.abs(hash) % colors.length;
  return colors[idx];
}

function userGradient(userId: string): string {
  const base = userColor(userId);
  // Create a slightly darker variant for gradient
  return `linear-gradient(135deg, ${base} 0%, ${base}dd 100%)`;
}

/** WhatsApp/Telegram style date separator label */
function fmtDateLabel(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (msgDay.getTime() === today.getTime()) return "Heute";
  if (msgDay.getTime() === yesterday.getTime()) return "Gestern";
  return d.toLocaleDateString("de-DE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

/**
 * Liest ein Bild und gibt ein quadratisch zugeschnittenes, JPEG-komprimiertes
 * data-URL zurück. Ziel: ~50 KB für 256x256 — passt in das 100 KB
 * Server-Limit für Gruppen-Avatare.
 */
async function resizeImageToDataUrl(
  file: File,
  size = 256,
  quality = 0.85
): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("file_read_failed"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onerror = () => reject(new Error("image_decode_failed"));
    i.onload = () => resolve(i);
    i.src = dataUrl;
  });
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const minSide = Math.min(w, h);
  const sx = (w - minSide) / 2;
  const sy = (h - minSide) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas_unavailable");
  ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);
  return canvas.toDataURL("image/jpeg", quality);
}

export function ChatShell({
  session,
  onLogout,
  onLock,
}: {
  session: Session;
  onLogout: () => void;
  onLock: () => void;
}) {
  const [users, setUsers] = useState<api.ApiUser[]>([]);
  const [groups, setGroups] = useState<api.ApiGroup[]>([]);
  const [tab, setTab] = useState<Tab>("dm");
  const [peer, setPeer] = useState<api.ApiUser | null>(null);
  const [group, setGroup] = useState<api.ApiGroup | null>(null);
  const [text, setText] = useState("");
  const [groupText, setGroupText] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [groupMessages, setGroupMessages] = useState<ChatMsg[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [hasEverConnected, setHasEverConnected] = useState(false);
  const [wsHadError, setWsHadError] = useState(false);
  const [backupReminderVisible, setBackupReminderVisible] = useState(
    () => !isBackupReminderDismissed()
  );
  const [onboardingOpen, setOnboardingOpen] = useState(readOnboardingPending);
  const [typing, setTyping] = useState(false);
  /** groupId → User-IDs die gerade tippen */
  const [groupTypingMap, setGroupTypingMap] = useState<
    Map<string, Set<string>>
  >(() => new Map());
  const [myFp, setMyFp] = useState<string | null>(null);
  const [peerFp, setPeerFp] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupMembers, setNewGroupMembers] = useState<string[]>([]);
  const [newGroupDescription, setNewGroupDescription] = useState("");
  const [newGroupAvatar, setNewGroupAvatar] = useState<string>("");
  const [incomingOffer, setIncomingOffer] = useState<{
    from: api.ApiUser;
    sdp: string;
  } | null>(null);
  const [callRemote, setCallRemote] = useState<MediaStream | null>(null);
  const [callStatus, setCallStatus] = useState<CallStatus>("idle");
  const [replyDm, setReplyDm] = useState<ReplyTarget>(null);
  // Contact add modal
  const [showAddContact, setShowAddContact] = useState(false);
  // Notification settings per chat
  const [mutedPeers, setMutedPeers] = useState<Set<string>>(new Set());
  const [mutedGroups, setMutedGroups] = useState<Set<string>>(() =>
    loadStringSet("vaultchat.muted.groups")
  );
  const [favoritePeers, setFavoritePeers] = useState<Set<string>>(
    () => loadStringSet("vaultchat.favorites.peers")
  );
  const [blockedPeers, setBlockedPeers] = useState<Set<string>>(
    () => loadStringSet("vaultchat.blocked.peers")
  );
  // Online status tracking
  const [onlinePeers, setOnlinePeers] = useState<Set<string>>(new Set());
  const [replyGroup, setReplyGroup] = useState<ReplyTarget>(null);
  const [ttlDm, setTtlDm] = useState<number>(0);
  const [ttlGroup, setTtlGroup] = useState<number>(0);
  const [viewOnceDm, setViewOnceDm] = useState<boolean>(false);
  const [viewOnceGroup, setViewOnceGroup] = useState<boolean>(false);
  type PollDraft = { question: string; options: string[] };
  const [pollDm, setPollDm] = useState<PollDraft | null>(null);
  const [pollGroup, setPollGroup] = useState<PollDraft | null>(null);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [peerPin, setPeerPin] = useState<PeerPin | null>(null);
  const [relayOnly, setRelayOnly] = useState(false);
  const [addMemberId, setAddMemberId] = useState<string>("");
  const [groupPanelOpen, setGroupPanelOpen] = useState(false);
  const [groupEditMode, setGroupEditMode] = useState(false);
  const [groupEditName, setGroupEditName] = useState("");
  const [groupEditDescription, setGroupEditDescription] = useState("");
  const [groupEditAvatar, setGroupEditAvatar] = useState<string>("");
  const [groupEditAvatarRemoved, setGroupEditAvatarRemoved] = useState(false);
  const [groupEditBusy, setGroupEditBusy] = useState(false);
  const [groupInvites, setGroupInvites] = useState<api.GroupInvite[]>([]);
  const [groupInvitesLoading, setGroupInvitesLoading] = useState(false);
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [notifyPromptOpen, setNotifyPromptOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [isMobile, setIsMobile] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sidebarFilter, setSidebarFilter] = useState<SidebarFilter>("all");
  const [folders, setFolders] = useState<ChatFolder[]>(() => loadFolders());
  const [foldersManageOpen, setFoldersManageOpen] = useState(false);
  const [openThreadCid, setOpenThreadCid] = useState<string | null>(null);
  const [folderEdit, setFolderEdit] = useState<ChatFolder | null>(null);
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);

  useEffect(() => subscribeFolders(setFolders), []);
  const [unreadByPeer, setUnreadByPeer] = useState<Record<string, number>>({});
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [groupEmojiOpen, setGroupEmojiOpen] = useState(false);
  const [groupDragOver, setGroupDragOver] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionStart, setMentionStart] = useState<number>(-1);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [jumpHighlightCid, setJumpHighlightCid] = useState<string | null>(null);
  const [forwardTarget, setForwardTarget] = useState<ChatMsg | null>(null);
  const [forwardPick, setForwardPick] = useState<Set<string>>(() => new Set());
  const [starredCids, setStarredCids] = useState<Set<string>>(
    () => loadStringSet("vaultchat.starred.cids")
  );
  const [pinnedPeers, setPinnedPeers] = useState<Set<string>>(
    () => loadStringSet("vaultchat.pinned.peers")
  );
  const [pinnedMessageByPeer, setPinnedMessageByPeer] = useState<
    Record<string, string[]>
  >(() => {
    try {
      const raw = localStorage.getItem("vaultchat.pinned.messages");
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, string | string[]>;
      // Migrate older single-string format -> array. Once written, the
      // new format takes over via togglePinMessage.
      const out: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === "string");
        else if (typeof v === "string" && v) out[k] = [v];
      }
      return out;
    } catch {
      return {};
    }
  });
  const [pinnedBannerIdxByPeer, setPinnedBannerIdxByPeer] = useState<
    Record<string, number>
  >({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [newDmMessageWaiting, setNewDmMessageWaiting] = useState(false);
  const [newGroupMessageWaiting, setNewGroupMessageWaiting] = useState(false);
  const [dmScrollUnread, setDmScrollUnread] = useState(0);
  const [groupScrollUnread, setGroupScrollUnread] = useState(0);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [dmMenuOpen, setDmMenuOpen] = useState(false);
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [sendTypingIndicators, setSendTypingIndicators] = useState(
    () => localStorage.getItem("vaultchat.privacy.typing") !== "off"
  );
  const [sendReadReceipts, setSendReadReceipts] = useState(
    () => localStorage.getItem("vaultchat.privacy.receipts") !== "off"
  );

  const callRef = useRef<{
    close: () => void;
    handleRemote?: (p: RtcPayload) => void | Promise<void>;
    addIce?: (c: RTCIceCandidateInit) => void | Promise<void>;
  } | null>(null);
  const pendingRtcRef = useRef<Map<string, RtcPayload[]>>(new Map());

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const peerRef = useRef<api.ApiUser | null>(null);
  const groupRef = useRef<api.ApiGroup | null>(null);
  const usersRef = useRef<api.ApiUser[]>([]);
  const groupsRef = useRef<api.ApiGroup[]>([]);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const groupTypingClearTimers = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
  const seen = useRef(new Set<string>());
  const dmScrollRef = useRef<HTMLDivElement | null>(null);
  const groupScrollRef = useRef<HTMLDivElement | null>(null);
  const dmInputRef = useRef<HTMLTextAreaElement | null>(null);
  const groupInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [dmScrolledUp, setDmScrolledUp] = useState(false);
  const [groupScrolledUp, setGroupScrolledUp] = useState(false);
  const rawDmRef = useRef<Map<string, ReturnType<typeof authoredFromDm>>>(
    new Map()
  );
  const rawGroupRef = useRef<Map<string, ReturnType<typeof authoredFromGroup>>>(
    new Map()
  );
  const tokenRef = useRef(session.token);
  const coverRef = useRef<ReturnType<typeof startCoverTraffic> | null>(null);
  peerRef.current = peer;
  groupRef.current = group;
  usersRef.current = users;
  groupsRef.current = groups;
  tokenRef.current = session.token;

  useEffect(() => {
    if (forwardTarget) setForwardPick(new Set());
  }, [forwardTarget]);

  // Reset group edit form when switching groups or closing the panel.
  useEffect(() => {
    setGroupEditMode(false);
    setGroupEditAvatar("");
    setGroupEditAvatarRemoved(false);
  }, [group?.id, groupPanelOpen]);

  // Load invites whenever the group panel opens for a group I created.
  useEffect(() => {
    if (
      !group ||
      !groupPanelOpen ||
      group.createdByUserId !== session.user.id
    ) {
      setGroupInvites([]);
      return;
    }
    let cancelled = false;
    setGroupInvitesLoading(true);
    void api
      .listGroupInvites(session.token, group.id)
      .then(({ invites }) => {
        if (!cancelled) setGroupInvites(invites);
      })
      .catch(() => {
        if (!cancelled) setGroupInvites([]);
      })
      .finally(() => {
        if (!cancelled) setGroupInvitesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [group, groupPanelOpen, session.user.id, session.token]);

  useShortcuts({
    onSearch: () => setSearchOpen(true),
    onEscape: () => {
      setSearchOpen(false);
      setEmojiOpen(false);
      setGroupEmojiOpen(false);
      setSafetyOpen(false);
      setInfoOpen(false);
      setGroupPanelOpen(false);
      setDmMenuOpen(false);
      setGroupMenuOpen(false);
      setUserMenuOpen(false);
      setForwardTarget(null);
      setForwardPick(new Set());
      setMentionOpen(false);
      setShowAddContact(false);
      setShortcutsHelpOpen(false);
    },
    onLock: () => onLock(),
    onHelp: () => setShortcutsHelpOpen(true),
    onSend: () => {
      if (tab === "dm" && peer && text.trim()) {
        void sendDmText();
        return true;
      }
      if (tab === "group" && group && groupText.trim()) {
        void sendGroupText();
        return true;
      }
      return false;
    },
  });

  const voice = useVoiceRecorder();
  const groupVoice = useVoiceRecorder();

  useEffect(() => {
    const mq = window.matchMedia?.("(max-width: 768px)");
    if (!mq) return;
    const apply = () => setIsMobile(Boolean(mq.matches));
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);

  useEffect(() => {
    if (!incomingOffer) return;
    const t = window.setTimeout(() => {
      setIncomingOffer(null);
      setCallStatus("ended");
    }, 30_000);
    return () => window.clearTimeout(t);
  }, [incomingOffer]);

  const maybeNotify = useCallback((title: string, body: string) => {
    try {
      if (localStorage.getItem(NOTIFY_STORAGE_KEY) === "off") return;
    } catch {
      /* ignore */
    }
    let showPreview = true;
    try {
      showPreview = localStorage.getItem(NOTIFY_PREVIEW_STORAGE_KEY) !== "off";
    } catch {
      /* ignore */
    }
    const displayBody = showPreview ? body : "Neue Nachricht";
    if (!("Notification" in window) || document.visibilityState === "visible") return;
    if (Notification.permission === "granted") {
      new Notification(title, { body: displayBody, tag: "vaultchat-message" });
      return;
    }
    if (Notification.permission === "default") {
      // Don't pop the native browser prompt unannounced — show a friendly
      // in-app banner instead and let the user opt in deliberately.
      let dismissed = false;
      try {
        dismissed =
          localStorage.getItem("vaultchat.notify.promptDismissed") === "1";
      } catch {
        /* ignore */
      }
      if (!dismissed) setNotifyPromptOpen(true);
    }
  }, []);

  const handleEnableNotifications = useCallback(async () => {
    if (!("Notification" in window)) {
      setNotifyPromptOpen(false);
      return;
    }
    try {
      await Notification.requestPermission();
    } catch {
      /* ignore */
    }
    try {
      localStorage.setItem("vaultchat.notify.promptDismissed", "1");
    } catch {
      /* ignore */
    }
    setNotifyPromptOpen(false);
  }, []);

  const handleDismissNotifyPrompt = useCallback(() => {
    try {
      localStorage.setItem("vaultchat.notify.promptDismissed", "1");
    } catch {
      /* ignore */
    }
    setNotifyPromptOpen(false);
  }, []);

  const showConversation = tab === "dm" ? Boolean(peer) : Boolean(group);
  const showSidebar = !isMobile || !showConversation;
  const showInfo = !isMobile && showConversation && infoOpen;

  const resolveUser = useCallback(
    async (userId: string): Promise<api.ApiUser | null> => {
      const local = usersRef.current.find((u) => u.id === userId);
      if (local) return local;
      try {
        const { users: list } = await api.listUsers(session.token, [userId]);
        // Only add to local list if we actually need this user (for decryption)
        // Don't replace the entire users list - this prevents showing ALL users
        const found = list.find((u) => u.id === userId);
        if (found) {
          setUsers((prev) => {
            if (prev.find((u) => u.id === found.id)) return prev;
            return [...prev, found];
          });
          return found;
        }
        return null;
      } catch {
        return null;
      }
    },
    [session.token, session.user.id]
  );

  // Don't load all users on start - only search on demand
  const searchUserByUsername = useCallback(async (username: string): Promise<api.ApiUser | null> => {
    try {
      const { users: list } = await api.searchUsers(session.token, username);
      const found = list.find(
        (u) => u.username.toLowerCase() === username.toLowerCase() && u.id !== session.user.id
      );
      if (found) {
        await observePeerKey(found.id, found.publicKey);
        return found;
      }
      return null;
    } catch {
      return null;
    }
  }, [session.token, session.user.id]);

  // Load only contacts from local messages (not from server)
  const loadContacts = useCallback(async () => {
    // Only show contacts we've exchanged messages with (from local storage)
    const contactIds = Array.from(rawDmRef.current.keys());
    const { users: list } = await api.listUsers(session.token, contactIds);
    const contacts = list.filter((u) => contactIds.includes(u.id));
    setUsers(contacts);
    
    // Also observe peer keys for contacts
    for (const u of contacts) {
      try {
        await observePeerKey(u.id, u.publicKey);
      } catch {
        /* ignore */
      }
    }
  }, [session.token]);

  const loadGroups = useCallback(async () => {
    const { groups: g } = await api.listGroups(session.token);
    setGroups(g);
  }, [session.token]);

  const refreshPendingCount = useCallback(async () => {
    try {
      const rows = await outboxList();
      setPendingCount(rows.length);
    } catch {
      setPendingCount(0);
    }
  }, []);

  useEffect(() => {
    void loadContacts();
    void loadGroups();
    void idbPurgeExpired().catch(() => {});
    void refreshPendingCount();
  }, [loadContacts, loadGroups, refreshPendingCount]);

  /** Title-bar badge: shows total unread count when the tab is in the
   *  background, e.g. "(3) VaultChat". Reverts to plain "VaultChat"
   *  on unmount or when there is nothing unread. */
  useEffect(() => {
    const total = Object.values(unreadByPeer).reduce(
      (s, n) => s + (n || 0),
      0
    );
    const base = "VaultChat";
    document.title =
      total > 0 ? `(${total > 99 ? "99+" : total}) ${base}` : base;
    return () => {
      document.title = base;
    };
  }, [unreadByPeer]);

  /** Pre-Key-Bundle auf den Server hochladen (X3DH-API, kompatibel mit eurer Konto-Identität). */
  useEffect(() => {
    void (async () => {
      try {
        let km = await loadKeyMaterial();
        if (!km) {
          km = await generateKeyMaterial(session.secretKey);
          await saveKeyMaterial(km);
        }
        const replenished = await replenishOneTimePreKeys(km);
        if (replenished !== km) {
          km = replenished;
          await saveKeyMaterial(km);
        }
        await api.uploadPreKeys(session.token, toUploadBody(km));
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[vaultchat] prekey upload", e);
      }
    })();
  }, [session.token, session.secretKey]);

  useEffect(() => {
    void (async () => {
      setMyFp(await fingerprintFromPublicKeyB64(session.user.publicKey));
    })();
  }, [session.user.publicKey]);

  useEffect(() => {
    void (async () => {
      if (!peer) {
        setPeerFp(null);
        setPeerPin(null);
        return;
      }
      setPeerFp(await fingerprintFromPublicKeyB64(peer.publicKey));
      // Saved Messages / self-chat: there's no MITM threat against
      // your own identity key, so always treat as verified and skip
      // the TOFU lookup entirely.
      if (peer.id === session.user.id) {
        setPeerPin({
          publicKey: peer.publicKey,
          state: "verified",
          firstSeen: Date.now(),
          verifiedAt: Date.now(),
        });
        return;
      }
      setPeerPin(await getPin(peer.id));
    })();
  }, [peer, session.user.id]);

  const rebuildDm = useCallback((peerId: string) => {
    const raw = rawDmRef.current.get(peerId) ?? [];
    setMessages(reduceChatMessages(raw));
  }, []);

  const rebuildGroup = useCallback((groupId: string) => {
    const raw = rawGroupRef.current.get(groupId) ?? [];
    setGroupMessages(reduceChatMessages(raw));
  }, []);

  // Purge expired messages continuously so they disappear "live".
  useEffect(() => {
    const h = setInterval(() => {
      void (async () => {
        await idbPurgeExpired().catch(() => {});
        const now = Date.now();
        if (peerRef.current) {
          const pid = peerRef.current.id;
          const arr = rawDmRef.current.get(pid) ?? [];
          const next = arr.filter((m) => !m.expiresAt || m.expiresAt > now);
          if (next.length !== arr.length) {
            rawDmRef.current.set(pid, next);
            rebuildDm(pid);
          }
        }
        if (groupRef.current) {
          const gid = groupRef.current.id;
          const arr = rawGroupRef.current.get(gid) ?? [];
          const next = arr.filter((m) => !m.expiresAt || m.expiresAt > now);
          if (next.length !== arr.length) {
            rawGroupRef.current.set(gid, next);
            rebuildGroup(gid);
          }
        }
      })();
    }, 1000);
    return () => clearInterval(h);
  }, [rebuildDm, rebuildGroup]);

  const loadDmLocal = useCallback(
    async (p: api.ApiUser) => {
      const rows = await idbListDm(p.id);
      const authored = authoredFromDm(rows);
      rawDmRef.current.set(p.id, authored);
      rebuildDm(p.id);
      const savedTtl = await metaGet(`ttl:dm:${p.id}`);
      if (savedTtl) {
        setTtlDm(Number(savedTtl) || 0);
      } else {
        setTtlDm(loadDefaultTtl());
      }
    },
    [rebuildDm]
  );

  const loadGroupLocal = useCallback(
    async (g: api.ApiGroup) => {
      const rows = await idbListGroup(g.id);
      const authored = authoredFromGroup(rows, session.user.id);
      rawGroupRef.current.set(g.id, authored);
      rebuildGroup(g.id);
      const savedTtl = await metaGet(`ttl:g:${g.id}`);
      if (savedTtl) {
        setTtlGroup(Number(savedTtl) || 0);
      } else {
        setTtlGroup(loadDefaultTtl());
      }
    },
    [rebuildGroup, session.user.id]
  );

  useEffect(() => {
    if (!peer) {
      setMessages([]);
      setReplyDm(null);
      return;
    }
    seen.current = new Set();
    void (async () => {
      await loadDmLocal(peer);
      await metaSet(`seen:dm:${peer.id}`, String(Date.now())).catch(() => {});
      setUnreadByPeer((m) => ({ ...m, [peer.id]: 0 }));
    })();
  }, [peer, session.secretKey, loadDmLocal]);

  useEffect(() => {
    if (!group) {
      setGroupMessages([]);
      setReplyGroup(null);
      return;
    }
    void loadGroupLocal(group);
  }, [group, loadGroupLocal]);

  // Auto-scroll: nur wenn der User bereits unten war ODER neue Nachricht reinkommt
  // Mit smooth scrolling und verbesserter Bottom-Erkennung
  useEffect(() => {
    const el = dmScrollRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (isNearBottom) {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: 'smooth'
      });
      setDmScrolledUp(false);
      setDmScrollUnread(0);
    } else {
      setDmScrolledUp(true);
      setNewDmMessageWaiting(true);
      setDmScrollUnread((c) => c + 1);
    }
  }, [messages]);

  // Auto-scroll für Gruppen
  useEffect(() => {
    const el = groupScrollRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (isNearBottom) {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: 'smooth'
      });
      setGroupScrolledUp(false);
      setGroupScrollUnread(0);
    } else {
      setGroupScrolledUp(true);
      setNewGroupMessageWaiting(true);
      setGroupScrollUnread((c) => c + 1);
    }
  }, [groupMessages]);

  // Reset unread counters when chat changes
  useEffect(() => {
    setDmScrollUnread(0);
  }, [peer?.id]);
  useEffect(() => {
    setGroupScrollUnread(0);
  }, [group?.id]);

  // Scroll event handler für DM
  const handleDmScroll = useCallback(() => {
    const el = dmScrollRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setDmScrolledUp(!isNearBottom);
    if (isNearBottom) {
      setNewDmMessageWaiting(false);
      setDmScrollUnread(0);
    }
  }, []);

  // Scroll event handler für Gruppen
  const handleGroupScroll = useCallback(() => {
    const el = groupScrollRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setGroupScrolledUp(!isNearBottom);
    if (isNearBottom) {
      setNewGroupMessageWaiting(false);
      setGroupScrollUnread(0);
    }
  }, []);

  // Scroll to bottom function
  const scrollToBottom = useCallback((ref: React.RefObject<HTMLDivElement | null>) => {
    ref.current?.scrollTo({
      top: ref.current.scrollHeight,
      behavior: 'smooth'
    });
  }, []);

  const sendRtc = useCallback((toUserId: string, payload: RtcPayload) => {
    wsRef.current?.send(JSON.stringify({ type: "rtc", toUserId, payload }));
  }, []);

  /**
   * Kernroutine fürs Senden: DR-Verschlüsselung → Sealed-Sender-Envelope →
   * WebSocket. Wenn kein Socket oder `delivered=0`, wird die Nachricht in der
   * Outbox geparkt und bei Reconnect/periodic erneut versendet.
   */
  const sendDmWire = useCallback(
    async (
      toUser: api.ApiUser,
      payload: PlainPayload,
      suppressLocal = false
    ): Promise<string | null> => {
      if (blockedPeers.has(toUser.id)) {
        setError("Kontakt ist blockiert. Hebe die Blockierung auf, um zu senden.");
        return null;
      }
      const encrypted = await drEncryptJsonForDm(
        session.secretKey,
        toUser.id,
        toUser.publicKey,
        JSON.stringify(payload),
        tokenRef.current
      );
      const envelope = await sealSender(
        session.user.id,
        encrypted.innerB64,
        toUser.publicKey
      );
      if (encrypted.mode === "legacy") {
        setError("Legacy-DH-Fallback genutzt: Prekey-Bundle des Kontakts nicht verfügbar.");
      }
      const cid = newCid();

      const at = Date.now();
      const tmpId = `local-${newCid()}`;
      const ttl = payload.ttlMs ?? 0;
      if (!suppressLocal) {
        await idbPutDm({
          id: tmpId,
          peerId: toUser.id,
          fromMe: true,
          plainJson: JSON.stringify(payload),
          at,
          ...(ttl ? { expiresAt: at + ttl } : {}),
        });
        const arr = rawDmRef.current.get(toUser.id) ?? [];
        arr.push({
          id: tmpId,
          fromMe: true,
          plainJson: JSON.stringify(payload),
          at,
          ...(ttl ? { expiresAt: at + ttl } : {}),
        });
        rawDmRef.current.set(toUser.id, arr);
        if (peerRef.current?.id === toUser.id) rebuildDm(toUser.id);
      }

      await outboxAdd(cid, toUser.id, envelope);
      await refreshPendingCount();

      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({ type: "dm", toUserId: toUser.id, envelope, cid })
        );
      }
      coverRef.current?.markRealActivity();
      return tmpId;
    },
    [session.secretKey, session.user.id, rebuildDm, refreshPendingCount, blockedPeers]
  );

  const commitForward = useCallback(async () => {
    const src = forwardTarget;
    if (!src) return;
    const dmPeerId = tab === "dm" && peer ? peer.id : null;
    if (forwardPick.size === 0) {
      setError("Bitte mindestens einen Kontakt auswählen.");
      return;
    }
    if (src.plain.kind !== "text" && src.plain.kind !== "file") {
      setError("Nur Text und Dateien können weitergeleitet werden.");
      setForwardTarget(null);
      setForwardPick(new Set());
      return;
    }
    setError(null);
    let sent = 0;
    for (const uid of forwardPick) {
      const u = usersRef.current.find((x) => x.id === uid);
      if (!u || blockedPeers.has(u.id)) continue;
      const payload = buildForwardPayloadForSend(src, session.user.id, dmPeerId);
      if (payload) {
        await sendDmWire(u, payload);
        sent += 1;
      }
    }
    if (sent > 0) {
      pushToast(
        sent === 1 ? "Nachricht weitergeleitet" : `Weitergeleitet an ${sent} Kontakte`,
        "success"
      );
    }
    setForwardTarget(null);
    setForwardPick(new Set());
  }, [
    forwardTarget,
    forwardPick,
    tab,
    peer,
    session.user.id,
    sendDmWire,
    blockedPeers,
  ]);

  const sendGroupWire = useCallback(
    async (
      g: api.ApiGroup,
      payload: PlainPayload,
      suppressLocal = false,
      quiet = false
    ) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (!quiet) setError("Keine Verbindung.");
        return null;
      }
      const p: PlainPayload = { ...payload, senderUserId: session.user.id };
      const ciphertext = await encryptGroupPayload(g.id, p);
      const at = Date.now();
      const tmpId = `local-g-${newCid()}`;
      const ttl = p.ttlMs ?? 0;
      if (!suppressLocal) {
        await idbPutGroupMsg({
          id: tmpId,
          groupId: g.id,
          fromUserId: session.user.id,
          plainJson: JSON.stringify(p),
          at,
          ...(ttl ? { expiresAt: at + ttl } : {}),
        });
        const arr = rawGroupRef.current.get(g.id) ?? [];
        arr.push({
          id: tmpId,
          fromMe: true,
          fromUserId: session.user.id,
          plainJson: JSON.stringify(p),
          at,
          ...(ttl ? { expiresAt: at + ttl } : {}),
        });
        rawGroupRef.current.set(g.id, arr);
        if (groupRef.current?.id === g.id) rebuildGroup(g.id);
      }
      ws.send(JSON.stringify({ type: "group", groupId: g.id, ciphertext }));
      coverRef.current?.markRealActivity();
      return tmpId;
    },
    [rebuildGroup, session.user.id]
  );

  /** Flush pending envelopes from outbox. Called on reconnect + periodically. */
  const flushOutbox = useCallback(async () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const pending = await outboxList();
    for (const row of pending) {
      const meta = await outboxGetMeta(row.cid).catch(() => null);
      if (meta?.nextAttemptAt && Date.now() < meta.nextAttemptAt) continue;
      const { shouldRetry, attempts } = await outboxAttempt(row.cid);
      if (!shouldRetry) {
        // Give up: message permanently failed.
        // Keep UI simple; it disappears from outbox.
        // eslint-disable-next-line no-console
        console.error(`[vaultchat] Message ${row.cid} failed after ${attempts} attempts`);
        continue;
      }
      ws.send(
        JSON.stringify({
          type: "dm",
          toUserId: row.toUserId,
          envelope: row.envelopeB64,
          cid: row.cid,
        })
      );
    }
    await refreshPendingCount();
  }, [refreshPendingCount]);

  useEffect(() => {
    const url = getWsUrl();
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => {
      const activeWs = wsRef.current;
      if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
      activeWs.send(JSON.stringify({ type: "auth", token: tokenRef.current }));
      setHasEverConnected(true);
      setWsHadError(false);
      setConnected(true);
      void flushOutbox();

      // Starte Cover Traffic (Dummy-Envelopes bei Inaktivität)
      const peerList = usersRef.current.map((u) => ({
        id: u.id,
        publicKey: u.publicKey,
      }));
      if (peerList.length > 0) {
        coverRef.current = startCoverTraffic(activeWs, peerList, () => {
          return activeWs.readyState === WebSocket.OPEN && session !== null;
        });
      }
    };
    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      // Stop cover traffic
      if (coverRef.current) {
        coverRef.current.stop();
        coverRef.current = null;
      }
      // Auto-reconnect with exponential backoff (max 30 seconds)
      const attempts = reconnectAttempts.current;
      const delay = Math.min(1000 * Math.pow(2, attempts), 30000);
      reconnectAttempts.current = attempts + 1;
      reconnectTimer.current = setTimeout(() => {
        // Force effect remount by creating a new WebSocket
        const url = getWsUrl();
        const newWs = new WebSocket(url);
        wsRef.current = newWs;
        newWs.onopen = ws.onopen;
        newWs.onclose = ws.onclose;
        newWs.onerror = ws.onerror;
        newWs.onmessage = ws.onmessage;
      }, delay);
    };
    ws.onerror = () => {
      setWsHadError(true);
      setError("WebSocket-Fehler");
    };
    ws.onmessage = (ev) => {
      void (async () => {
        try {
          const data = JSON.parse(String(ev.data)) as Record<string, unknown>;

          if (data.type === "auth_ok") {
            reconnectAttempts.current = 0;
            return;
          }
          if (data.type === "dm_ack") {
            const cid = typeof data.cid === "string" ? data.cid : null;
            const delivered = Number(data.delivered ?? 0);
            const id = typeof data.id === "string" ? data.id : null;
            if (id) seen.current.add(id);
            if (cid) {
              if (delivered > 0) {
                await outboxRemove(cid);
              }
              await refreshPendingCount();
            }
            return;
          }
          if (data.type === "group_ack" && typeof data.id === "string") {
            seen.current.add(data.id);
            return;
          }
          if (data.type === "pong") return;
          if (data.type === "rtc" && data.payload && data.fromUserId) {
            const fromId = String(data.fromUserId);
            const u = usersRef.current.find((x) => x.id === fromId);
            const payload = data.payload as RtcPayload;
            if (payload.type === "offer" && u) {
              setIncomingOffer({ from: u, sdp: payload.sdp });
              setCallStatus("ringing");
              return;
            }
            const activeCall = callRef.current;
            if (!activeCall) {
              const queued = pendingRtcRef.current.get(fromId) ?? [];
              queued.push(payload);
              pendingRtcRef.current.set(fromId, queued);
              return;
            }
            if (activeCall.handleRemote) {
              await activeCall.handleRemote(payload);
              if (payload.type === "answer") setCallStatus("connecting");
            }
            return;
          }
          if (data.type === "typing") {
            const fromId =
              typeof data.fromUserId === "string" ? data.fromUserId : "";
            if (!fromId || fromId === session.user.id) return;
            const state = data.state === "stop" ? "stop" : "start";
            if (typeof data.groupId === "string") {
              const gid = data.groupId;
              const tk = `${gid}:${fromId}`;
              if (state === "stop") {
                const ex = groupTypingClearTimers.current.get(tk);
                if (ex) clearTimeout(ex);
                groupTypingClearTimers.current.delete(tk);
                setGroupTypingMap((prev) => {
                  const next = new Map(prev);
                  const set = new Set(next.get(gid) ?? []);
                  set.delete(fromId);
                  if (set.size === 0) next.delete(gid);
                  else next.set(gid, set);
                  return next;
                });
              } else {
                setGroupTypingMap((prev) => {
                  const next = new Map(prev);
                  const set = new Set(next.get(gid) ?? []);
                  set.add(fromId);
                  next.set(gid, set);
                  return next;
                });
                const ex = groupTypingClearTimers.current.get(tk);
                if (ex) clearTimeout(ex);
                const t = window.setTimeout(() => {
                  setGroupTypingMap((prev) => {
                    const next = new Map(prev);
                    const set = new Set(next.get(gid) ?? []);
                    set.delete(fromId);
                    if (set.size === 0) next.delete(gid);
                    else next.set(gid, set);
                    return next;
                  });
                  groupTypingClearTimers.current.delete(tk);
                }, 2800);
                groupTypingClearTimers.current.set(tk, t);
              }
              return;
            }
            const cur = peerRef.current;
            if (cur && fromId === cur.id) {
              setTyping(true);
              if (typingTimer.current) clearTimeout(typingTimer.current);
              typingTimer.current = setTimeout(() => setTyping(false), 2800);
            }
            return;
          }
          if (data.type === "group_member_added" && typeof data.groupId === "string") {
            const gid = data.groupId;
            const newMemberId =
              typeof data.memberId === "string" ? data.memberId : null;
            // Refresh the group list so the new member appears.
            const { groups: latest } = await api.listGroups(session.token);
            setGroups(latest);
            // If I created this group, rotate the group key and re-distribute
            // it. The joiner is now in the server-side member list but does
            // not yet have the symmetric key.
            const updatedGroup = latest.find((x) => x.id === gid);
            if (
              updatedGroup &&
              updatedGroup.createdByUserId === session.user.id
            ) {
              await rotateGroupKey(updatedGroup, updatedGroup.memberIds);
              if (newMemberId) {
                const memberLabel =
                  usersRef.current.find((u) => u.id === newMemberId)?.username ??
                  "Mitglied";
                await sendGroupSystemMessage(
                  updatedGroup,
                  `${memberLabel} ist via Einladungslink beigetreten`
                );
              }
            }
            return;
          }
          if (
            data.type === "dm" &&
            typeof data.id === "string" &&
            typeof data.envelope === "string"
          ) {
            const id = data.id;
            if (seen.current.has(id)) return;
            const createdAt = Number(data.createdAt ?? Date.now());
            const dec = await decryptIncomingSealedDmWithReplayCheck(
              data.envelope,
              session,
              resolveUser
            );
            if (!dec) return;
            if (blockedPeers.has(dec.senderUserId)) return;
            seen.current.add(id);
            const peerUser =
              usersRef.current.find((u) => u.id === dec.senderUserId) ??
              (await resolveUser(dec.senderUserId));
            if (!peerUser) return;

            const plain = dec.plain;
            if (plain.kind === "group_key" && plain.groupId && plain.keyB64) {
              const keyBytes = uint8FromBase64(plain.keyB64);
              await setGroupKey(plain.groupId, keyBytes);
              // Auch PFS-Key-State initialisieren, damit encryptGroupPayload
              // den PFS-Pfad (GC2) nutzen kann statt Legacy (GC1)
              const existingState = await getGroupKeyState(plain.groupId);
              if (!existingState) {
                const peers = usersRef.current.map(u => u.id);
                await initGroupKeyState(plain.groupId, peers, session.user.id, session.secretKey);
              }
              await loadGroups();
              return;
            }

            const ttl = plain.ttlMs ?? 0;
            await idbPutDm({
              id,
              peerId: peerUser.id,
              fromMe: false,
              plainJson: JSON.stringify(plain),
              at: createdAt,
              ...(ttl ? { expiresAt: createdAt + ttl } : {}),
            });
            const arr = rawDmRef.current.get(peerUser.id) ?? [];
            arr.push({
              id,
              fromMe: false,
              plainJson: JSON.stringify(plain),
              at: createdAt,
              ...(ttl ? { expiresAt: createdAt + ttl } : {}),
            });
            rawDmRef.current.set(peerUser.id, arr);
            if (peerRef.current?.id === peerUser.id) rebuildDm(peerUser.id);
            // Update unread (if chat not currently open).
            if (peerRef.current?.id !== peerUser.id) {
              if (!mutedPeers.has(peerUser.id)) {
                maybeNotify(peerUser.username, previewForPayload(plain));
              }
              void (async () => {
                const seenRaw = await metaGet(`seen:dm:${peerUser.id}`).catch(
                  () => null
                );
                const seenAt = seenRaw ? Number(seenRaw) || 0 : 0;
                if (createdAt > seenAt) {
                  setUnreadByPeer((m) => ({
                    ...m,
                    [peerUser.id]: (m[peerUser.id] ?? 0) + 1,
                  }));
                }
              })();
            }

            if (sendReadReceipts && plain.kind !== "receipt" && plain.cid) {
              const receipt: PlainPayload = {
                v: 2,
                cid: newCid(),
                kind: "receipt",
                receiptKind:
                  peerRef.current?.id === peerUser.id ? "read" : "delivered",
                refCid: plain.cid,
              };
              void sendDmWire(peerUser, receipt, true);
            }
          }
          if (data.type === "group" && typeof data.id === "string") {
            const id = String(data.id);
            const gid = String(data.groupId);
            if (seen.current.has(id)) return;
            const ct = String(data.ciphertext);
            let plain: PlainPayload;
            try {
              plain = await decryptGroupPayload(gid, ct);
            } catch {
              return;
            }
            if (
              typeof plain.cid === "string" &&
              plain.cid.length > 0 &&
              isGroupMessageDuplicate(gid, plain.cid)
            ) {
              return;
            }
            seen.current.add(id);
            const fromUserId = plain.senderUserId ?? "";
            const at = Number(data.createdAt);
            const ttl = plain.ttlMs ?? 0;
            await idbPutGroupMsg({
              id,
              groupId: gid,
              fromUserId,
              plainJson: JSON.stringify(plain),
              at,
              ...(ttl ? { expiresAt: at + ttl } : {}),
            });
            const arr = rawGroupRef.current.get(gid) ?? [];
            arr.push({
              id,
              fromMe: fromUserId === session.user.id,
              fromUserId,
              plainJson: JSON.stringify(plain),
              at,
              ...(ttl ? { expiresAt: at + ttl } : {}),
            });
            rawGroupRef.current.set(gid, arr);
            if (groupRef.current?.id === gid) rebuildGroup(gid);
            if (groupRef.current?.id !== gid && !mutedGroups.has(gid)) {
              const groupName = groupsRef.current.find((x) => x.id === gid)?.name ?? "Gruppe";
              maybeNotify(groupName, previewForPayload(plain));
            }
            if (
              sendReadReceipts &&
              fromUserId &&
              fromUserId !== session.user.id &&
              plain.kind !== "receipt" &&
              plain.cid &&
              (plain.kind === "text" ||
                plain.kind === "file" ||
                plain.kind === "voice" ||
                plain.kind === "system")
            ) {
              const receipt: PlainPayload = {
                v: 2,
                cid: newCid(),
                kind: "receipt",
                receiptKind:
                  groupRef.current?.id === gid ? "read" : "delivered",
                refCid: plain.cid,
              };
              const gMeta = groupsRef.current.find((x) => x.id === gid);
              if (gMeta) void sendGroupWire(gMeta, receipt, true, true);
            }
          }
        } catch {
          /* ignore malformed frames */
        }
      })();
    };
    const interval = setInterval(() => {
      void flushOutbox();
    }, 15_000);
    return () => {
      ws.close();
      clearInterval(interval);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      for (const t of groupTypingClearTimers.current.values()) clearTimeout(t);
      groupTypingClearTimers.current.clear();
    };
  }, [
    session,
    loadGroups,
    sendDmWire,
    sendGroupWire,
    rebuildDm,
    rebuildGroup,
    resolveUser,
    flushOutbox,
    refreshPendingCount,
    mutedPeers,
    mutedGroups,
    blockedPeers,
    maybeNotify,
    sendReadReceipts,
  ]);

  async function sendDmText() {
    if (!peer || !text.trim()) return;
    const isSelf = peer.id === session.user.id;
    if (!isSelf && peerPin?.state === "mismatch") {
      setError("Schlüssel dieses Peers hat gewechselt. Bitte zuerst Sicherheitsnummer prüfen.");
      return;
    }
    setError(null);
    const cid = newCid();
    const payload: PlainPayload = {
      v: 2,
      cid,
      kind: "text",
      body: text.trim(),
      ...(replyDm
        ? {
            replyToCid: replyDm.cid,
            ...(!replyDm.expiresAt
              ? { replyPreview: `${replyDm.author}: ${replyDm.text}` }
              : {}),
          }
        : {}),
      ...(ttlDm ? { ttlMs: ttlDm } : {}),
      ...(viewOnceDm ? { viewOnce: true } : {}),
    };
    if (isSelf) {
      await appendSelfMessage(payload);
    } else {
      await sendDmWire(peer, payload);
    }
    setText("");
    resetTextarea(dmInputRef.current);
    setReplyDm(null);
    setViewOnceDm(false);
  }

  async function sendDmFile(file: File) {
    if (!peer) return;
    /**
     * Ziel: echte Dateien bis ca. 128 MiB. Data-URL, JSON, Padding,
     * Double-Ratchet-Wire und Sealed-Sender-Envelope wachsen deutlich darüber;
     * der Serverrahmen ist deshalb standardmäßig auf 320 MiB gesetzt.
     */
    const maxFile = 128 * 1024 * 1024;
    if (file.size > maxFile) {
      setError(
        `Datei zu groß: Bitte Dateien bis etwa ${Math.floor(maxFile / (1024 * 1024))} MB senden.`
      );
      return;
    }
    const body = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const payload: PlainPayload = {
      v: 2,
      cid: newCid(),
      kind: "file",
      body,
      fileName: file.name,
      mime: file.type,
      fileSize: file.size,
      ...(ttlDm ? { ttlMs: ttlDm } : {}),
      ...(viewOnceDm ? { viewOnce: true } : {}),
    };
    if (peer.id === session.user.id) {
      await appendSelfMessage(payload);
    } else {
      await sendDmWire(peer, payload);
    }
    setViewOnceDm(false);
  }

  async function sendDmVoice() {
    if (!peer) return;
    if (voice.recording) {
      const rec = await voice.stop();
      if (!rec) return;
      const payload: PlainPayload = {
        v: 2,
        cid: newCid(),
        kind: "voice",
        body: rec.dataUrl,
        mime: rec.mime,
        durationMs: rec.durationMs,
        ...(ttlDm ? { ttlMs: ttlDm } : {}),
        ...(viewOnceDm ? { viewOnce: true } : {}),
      };
      if (peer.id === session.user.id) {
        await appendSelfMessage(payload);
      } else {
        await sendDmWire(peer, payload);
      }
      setViewOnceDm(false);
    } else {
      const ok = await voice.start();
      if (!ok) setError("Mikrofon-Zugriff verweigert.");
    }
  }

  async function sendGroupText() {
    if (!group || !groupText.trim()) return;
    setError(null);
    const payload: PlainPayload = {
      v: 2,
      cid: newCid(),
      kind: "text",
      body: groupText.trim(),
      ...(replyGroup
        ? {
            replyToCid: replyGroup.cid,
            ...(!replyGroup.expiresAt
              ? { replyPreview: `${replyGroup.author}: ${replyGroup.text}` }
              : {}),
          }
        : {}),
      ...(ttlGroup ? { ttlMs: ttlGroup } : {}),
      ...(viewOnceGroup ? { viewOnce: true } : {}),
    };
    await sendGroupWire(group, payload);
    setGroupText("");
    resetTextarea(groupInputRef.current);
    setReplyGroup(null);
    setViewOnceGroup(false);
  }

  async function sendGroupFile(file: File) {
    if (!group) return;
    const maxFile = 128 * 1024 * 1024;
    if (file.size > maxFile) {
      setError(
        `Datei zu groß: Bitte Dateien bis etwa ${Math.floor(maxFile / (1024 * 1024))} MB senden.`
      );
      return;
    }
    setError(null);
    const body = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const payload: PlainPayload = {
      v: 2,
      cid: newCid(),
      kind: "file",
      body,
      fileName: file.name,
      mime: file.type,
      fileSize: file.size,
      ...(ttlGroup ? { ttlMs: ttlGroup } : {}),
      ...(viewOnceGroup ? { viewOnce: true } : {}),
    };
    await sendGroupWire(group, payload);
    setViewOnceGroup(false);
  }

  async function sendGroupVoice() {
    if (!group) return;
    if (groupVoice.recording) {
      const rec = await groupVoice.stop();
      if (!rec) return;
      const payload: PlainPayload = {
        v: 2,
        cid: newCid(),
        kind: "voice",
        body: rec.dataUrl,
        mime: rec.mime,
        durationMs: rec.durationMs,
        ...(ttlGroup ? { ttlMs: ttlGroup } : {}),
        ...(viewOnceGroup ? { viewOnce: true } : {}),
      };
      await sendGroupWire(group, payload);
      setViewOnceGroup(false);
    } else {
      const ok = await groupVoice.start();
      if (!ok) setError("Mikrofon-Zugriff verweigert.");
    }
  }

  async function reactDm(m: ChatMsg, emoji: string) {
    if (!peer) return;
    const refCid = m.plain.cid;
    if (!refCid) return;
    const payload: PlainPayload = {
      v: 2,
      cid: newCid(),
      kind: "reaction",
      refCid,
      emoji,
    };
    if (peer.id === session.user.id) {
      await appendSelfMessage(payload);
    } else {
      await sendDmWire(peer, payload);
    }
  }

  async function reactGroup(m: ChatMsg, emoji: string) {
    if (!group) return;
    const refCid = m.plain.cid;
    if (!refCid) return;
    const payload: PlainPayload = {
      v: 2,
      cid: newCid(),
      kind: "reaction",
      refCid,
      emoji,
    };
    await sendGroupWire(group, payload);
  }

  async function editDm(m: ChatMsg, body: string) {
    if (!peer) return;
    const refCid = m.plain.cid;
    if (!refCid) return;
    const payload: PlainPayload = {
      v: 2,
      cid: newCid(),
      kind: "edit",
      refCid,
      body,
    };
    if (peer.id === session.user.id) {
      await appendSelfMessage(payload);
    } else {
      await sendDmWire(peer, payload);
    }
  }

  async function editGroup(m: ChatMsg, body: string) {
    if (!group) return;
    const refCid = m.plain.cid;
    if (!refCid) return;
    const payload: PlainPayload = {
      v: 2,
      cid: newCid(),
      kind: "edit",
      refCid,
      body,
    };
    await sendGroupWire(group, payload);
  }

  async function deleteDm(m: ChatMsg) {
    if (!peer) return;
    const refCid = m.plain.cid;
    if (!refCid) return;
    const payload: PlainPayload = {
      v: 2,
      cid: newCid(),
      kind: "delete",
      refCid,
    };
    if (peer.id === session.user.id) {
      await appendSelfMessage(payload);
    } else {
      await sendDmWire(peer, payload);
    }
    await idbDeleteDm(m.id);
    const arr = (rawDmRef.current.get(peer.id) ?? []).filter(
      (x) => x.id !== m.id
    );
    rawDmRef.current.set(peer.id, arr);
    rebuildDm(peer.id);
  }

  /** Remove a DM message from local IDB and the rendered list without
   *  emitting a delete frame. Used for view-once expiry on the recipient. */
  async function localDeleteDm(m: ChatMsg) {
    if (!peer) return;
    await idbDeleteDm(m.id);
    const arr = (rawDmRef.current.get(peer.id) ?? []).filter(
      (x) => x.id !== m.id
    );
    rawDmRef.current.set(peer.id, arr);
    rebuildDm(peer.id);
  }

  async function deleteGroup(m: ChatMsg) {
    if (!group) return;
    const refCid = m.plain.cid;
    if (!refCid) return;
    const payload: PlainPayload = {
      v: 2,
      cid: newCid(),
      kind: "delete",
      refCid,
    };
    await sendGroupWire(group, payload);
    await idbDeleteGroupMsg(m.id);
    const arr = (rawGroupRef.current.get(group.id) ?? []).filter(
      (x) => x.id !== m.id
    );
    rawGroupRef.current.set(group.id, arr);
    rebuildGroup(group.id);
  }

  /** Remove a group message from local IDB and the rendered list without
   *  emitting a delete frame. Used for view-once expiry on the recipient. */
  async function localDeleteGroupMsg(m: ChatMsg) {
    if (!group) return;
    await idbDeleteGroupMsg(m.id);
    const arr = (rawGroupRef.current.get(group.id) ?? []).filter(
      (x) => x.id !== m.id
    );
    rawGroupRef.current.set(group.id, arr);
    rebuildGroup(group.id);
  }

  function copyText(t: string) {
    if (!t) return;
    void navigator.clipboard
      ?.writeText(t)
      .then(() => pushToast("In Zwischenablage kopiert", "success"))
      .catch(() => pushToast("Kopieren fehlgeschlagen", "danger"));
  }

  async function distributeGroupKey(g: api.ApiGroup, memberIds: string[], keyB64: string) {
    for (const mid of memberIds) {
      if (mid === session.user.id) continue;
      const u = usersRef.current.find((x) => x.id === mid);
      if (!u) continue;
      const p: PlainPayload = {
        v: 2,
        cid: newCid(),
        kind: "group_key",
        groupId: g.id,
        keyB64,
      };
      await sendDmWire(u, p, true);
    }
  }

  async function createGroup() {
    if (!newGroupName.trim() || newGroupMembers.length === 0) {
      setError("Gruppe: Name und mindestens ein Mitglied.");
      return;
    }
    setError(null);
    const memberIds = [...new Set([...newGroupMembers, session.user.id])];
    const description = newGroupDescription.trim();
    const { group: g } = await api.createGroup(session.token, {
      name: newGroupName.trim(),
      memberIds,
      ...(description ? { description } : {}),
      ...(newGroupAvatar ? { avatar: newGroupAvatar } : {}),
    });
    const key = await randomGroupKey();
    await setGroupKey(g.id, key);
    await loadGroups();
    await distributeGroupKey(g, memberIds, base64FromUint8(key));
    setNewGroupName("");
    setNewGroupMembers([]);
    setNewGroupDescription("");
    setNewGroupAvatar("");
    setGroup(g);
    setTab("group");
    // Refresh group list immediately
    await loadGroups();
  }

  async function sendDmPoll() {
    if (!peer || !pollDm) return;
    const question = pollDm.question.trim();
    const options = pollDm.options.map((o) => o.trim()).filter(Boolean);
    if (!question || options.length < 2) {
      setError("Bitte Frage und mindestens zwei Optionen angeben.");
      return;
    }
    const payload: PlainPayload = {
      v: 2,
      cid: newCid(),
      kind: "poll",
      pollQuestion: question,
      pollOptions: options.slice(0, 12),
      ...(ttlDm ? { ttlMs: ttlDm } : {}),
    };
    if (peer.id === session.user.id) {
      await appendSelfMessage(payload);
    } else {
      await sendDmWire(peer, payload);
    }
    setPollDm(null);
  }

  async function sendGroupPoll() {
    if (!group || !pollGroup) return;
    const question = pollGroup.question.trim();
    const options = pollGroup.options.map((o) => o.trim()).filter(Boolean);
    if (!question || options.length < 2) {
      setError("Bitte Frage und mindestens zwei Optionen angeben.");
      return;
    }
    const payload: PlainPayload = {
      v: 2,
      cid: newCid(),
      kind: "poll",
      pollQuestion: question,
      pollOptions: options.slice(0, 12),
      ...(ttlGroup ? { ttlMs: ttlGroup } : {}),
    };
    await sendGroupWire(group, payload);
    setPollGroup(null);
  }

  async function votePollDm(m: ChatMsg, optionIndex: number) {
    if (!peer || !m.plain.cid) return;
    const payload: PlainPayload = {
      v: 2,
      cid: newCid(),
      kind: "poll-vote",
      refCid: m.plain.cid,
      pollVoteIndex: optionIndex,
    };
    if (peer.id === session.user.id) {
      await appendSelfMessage(payload);
    } else {
      await sendDmWire(peer, payload);
    }
  }

  async function votePollGroup(m: ChatMsg, optionIndex: number) {
    if (!group || !m.plain.cid) return;
    const payload: PlainPayload = {
      v: 2,
      cid: newCid(),
      kind: "poll-vote",
      refCid: m.plain.cid,
      pollVoteIndex: optionIndex,
    };
    await sendGroupWire(group, payload);
  }

  /**
   * Persist a payload directly into the local DM history for the current
   * user (Saved Messages / self-chat). No wire frame is sent — Saved
   * Messages stay on this device.
   */
  async function appendSelfMessage(payload: PlainPayload) {
    const selfId = session.user.id;
    const id = `self:${newCid()}`;
    const at = Date.now();
    const ttl = payload.ttlMs ?? 0;
    const stored = {
      id,
      peerId: selfId,
      fromMe: true,
      plainJson: JSON.stringify(payload),
      at,
      ...(ttl ? { expiresAt: at + ttl } : {}),
    };
    await idbPutDm(stored);
    const arr = rawDmRef.current.get(selfId) ?? [];
    arr.push({
      id,
      fromMe: true,
      plainJson: stored.plainJson,
      at,
      ...(ttl ? { expiresAt: at + ttl } : {}),
    });
    rawDmRef.current.set(selfId, arr);
    if (peerRef.current?.id === selfId) rebuildDm(selfId);
  }

  async function rotateGroupKey(g: api.ApiGroup, newMembers: string[]) {
    const key = await randomGroupKey();
    await setGroupKey(g.id, key);
    await distributeGroupKey(g, newMembers, base64FromUint8(key));
  }

  function buildInviteUrl(token: string): string {
    return `${location.origin}/?invite=${encodeURIComponent(token)}`;
  }

  async function handleCreateInvite() {
    if (!group) return;
    setCreatingInvite(true);
    try {
      const { invite } = await api.createGroupInvite(session.token, group.id, {
        ttlMs: 7 * 24 * 60 * 60 * 1000,
      });
      setGroupInvites((prev) => [...prev, invite]);
      try {
        await navigator.clipboard?.writeText(buildInviteUrl(invite.token));
        pushToast("Einladungslink erstellt und kopiert.", "success");
      } catch {
        pushToast("Einladungslink erstellt.", "success");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "create_failed";
      pushToast(`Erstellen fehlgeschlagen: ${msg}`, "danger");
    } finally {
      setCreatingInvite(false);
    }
  }

  async function handleRevokeInvite(inviteToken: string) {
    if (!group) return;
    try {
      await api.revokeGroupInvite(session.token, inviteToken);
      setGroupInvites((prev) => prev.filter((i) => i.token !== inviteToken));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "revoke_failed";
      pushToast(`Widerrufen fehlgeschlagen: ${msg}`, "danger");
    }
  }

  // Redeem an invite token from the URL (?invite=…) once the session is
  // active. Strip it from the URL afterwards so a refresh does not retry.
  const inviteRedeemedRef = useRef(false);
  useEffect(() => {
    if (inviteRedeemedRef.current) return;
    const url = new URL(location.href);
    const token = url.searchParams.get("invite");
    if (!token) return;
    inviteRedeemedRef.current = true;
    url.searchParams.delete("invite");
    window.history.replaceState({}, "", url.toString());
    void (async () => {
      try {
        const { groupId } = await api.redeemGroupInvite(session.token, token);
        const { groups: latest } = await api.listGroups(session.token);
        setGroups(latest);
        const target = latest.find((g) => g.id === groupId);
        if (target) {
          setTab("group");
          setPeer(null);
          setGroup(target);
          pushToast(
            `Beigetreten zu „${target.name}". Warte einen Moment auf den Gruppenschlüssel.`,
            "success"
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "join_failed";
        const friendly =
          msg === "expired"
            ? "Der Einladungslink ist abgelaufen."
            : msg === "exhausted"
              ? "Der Einladungslink wurde bereits maximal oft verwendet."
              : msg === "already_member"
                ? "Du bist bereits Mitglied dieser Gruppe."
                : msg === "unknown_token"
                  ? "Der Einladungslink ist ungültig."
                  : `Beitritt fehlgeschlagen: ${msg}`;
        pushToast(friendly, "danger");
      }
    })();
  }, [session.token]);

  async function sendGroupSystemMessage(g: api.ApiGroup, body: string) {
    try {
      const payload: PlainPayload = {
        v: 2,
        cid: newCid(),
        kind: "system",
        body,
      };
      await sendGroupWire(g, payload);
    } catch {
      /* system messages are best-effort; never block the underlying action */
    }
  }

  async function saveGroupProfile() {
    if (!group) return;
    const trimmedName = groupEditName.trim();
    const trimmedDesc = groupEditDescription.trim();
    if (!trimmedName) {
      pushToast("Gruppenname darf nicht leer sein.", "danger");
      return;
    }
    setGroupEditBusy(true);
    try {
      const previousName = group.name;
      const previousDesc = group.description ?? "";
      const previousAvatar = !!group.avatar;
      const avatarUpdate = groupEditAvatarRemoved
        ? ""
        : groupEditAvatar || undefined;
      const { group: updated } = await api.updateGroupProfile(
        session.token,
        group.id,
        {
          name: trimmedName,
          description: trimmedDesc,
          ...(avatarUpdate !== undefined ? { avatar: avatarUpdate } : {}),
        }
      );
      setGroup((prev) => (prev && prev.id === updated.id ? updated : prev));
      await loadGroups();
      setGroupEditMode(false);
      setGroupEditAvatar("");
      setGroupEditAvatarRemoved(false);
      pushToast("Gruppe aktualisiert.", "success");
      const changes: string[] = [];
      if (previousName !== trimmedName) {
        changes.push(`Name auf „${trimmedName}"`);
      }
      if (previousDesc !== trimmedDesc) {
        changes.push(trimmedDesc ? "Beschreibung" : "Beschreibung entfernt");
      }
      if (avatarUpdate !== undefined) {
        const newAvatarPresent = avatarUpdate !== "";
        if (previousAvatar !== newAvatarPresent) {
          changes.push(newAvatarPresent ? "Bild" : "Bild entfernt");
        } else if (newAvatarPresent) {
          changes.push("Bild");
        }
      }
      if (changes.length > 0) {
        await sendGroupSystemMessage(
          updated,
          `${session.user.username} hat ${changes.join(" und ")} geändert`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown_error";
      pushToast(
        msg === "cannot_update"
          ? "Nur der Ersteller darf die Gruppe bearbeiten."
          : `Aktualisierung fehlgeschlagen: ${msg}`,
        "danger"
      );
    } finally {
      setGroupEditBusy(false);
    }
  }

  async function addMember() {
    if (!group || !addMemberId) return;
    const memberLabel =
      users.find((u) => u.id === addMemberId)?.username ?? "Mitglied";
    try {
      const { group: g2 } = await api.addGroupMember(
        session.token,
        group.id,
        addMemberId
      );
      setGroup(g2);
      await loadGroups();
      await rotateGroupKey(g2, g2.memberIds);
      setAddMemberId("");
      await sendGroupSystemMessage(
        g2,
        `${session.user.username} hat ${memberLabel} hinzugefügt`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "add_failed");
    }
  }

  async function removeMember(memberId: string) {
    if (!group) return;
    const memberLabel =
      users.find((u) => u.id === memberId)?.username ?? "Mitglied";
    try {
      const { group: g2 } = await api.removeGroupMember(
        session.token,
        group.id,
        memberId
      );
      setGroup(g2);
      await loadGroups();
      await rotateGroupKey(g2, g2.memberIds);
      await sendGroupSystemMessage(
        g2,
        `${session.user.username} hat ${memberLabel} entfernt`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "remove_failed");
    }
  }

  async function leaveCurrentGroup() {
    if (!group) return;
    try {
      // Send the system message BEFORE leaving so the rest of the group
      // sees it; once we leave we can't send into that group any more.
      await sendGroupSystemMessage(
        group,
        `${session.user.username} hat die Gruppe verlassen`
      );
      await api.leaveGroup(session.token, group.id);
      setGroup(null);
      await loadGroups();
    } catch (e) {
      setError(e instanceof Error ? e.message : "leave_failed");
    }
  }

  async function beginCall() {
    if (!peer) return;
    setCallStatus("connecting");
    try {
      const ctrl = await startCall(
        peer,
        tokenRef.current,
        relayOnly,
        sendRtc,
        (s) => {
          setCallRemote(s);
          setCallStatus("connected");
        },
        () => {
          setCallRemote(null);
          callRef.current = null;
          setCallStatus("ended");
        }
      );
      callRef.current = ctrl;
      const queued = pendingRtcRef.current.get(peer.id) ?? [];
      pendingRtcRef.current.delete(peer.id);
      for (const payload of queued) {
        await ctrl.handleRemote?.(payload);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "call_failed");
      setCallStatus("failed");
    }
  }

  async function acceptIncoming() {
    if (!incomingOffer) return;
    setCallStatus("connecting");
    try {
      const ctrl = await acceptCall(
        incomingOffer.from,
        incomingOffer.sdp,
        tokenRef.current,
        relayOnly,
        sendRtc,
        (s) => {
          setCallRemote(s);
          setCallStatus("connected");
        },
        () => {
          setCallRemote(null);
          callRef.current = null;
          setCallStatus("ended");
        }
      );
      callRef.current = ctrl;
      const queued = pendingRtcRef.current.get(incomingOffer.from.id) ?? [];
      pendingRtcRef.current.delete(incomingOffer.from.id);
      for (const payload of queued) {
        await ctrl.handleRemote?.(payload);
      }
      setIncomingOffer(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "call_failed");
      setCallStatus("failed");
      setIncomingOffer(null);
    }
  }

  async function onChangeTtlDm(ms: number) {
    setTtlDm(ms);
    if (peer) await metaSet(`ttl:dm:${peer.id}`, String(ms));
  }

  async function onChangeTtlGroup(ms: number) {
    setTtlGroup(ms);
    if (group) await metaSet(`ttl:g:${group.id}`, String(ms));
  }

  function findReplyPreview(
    list: ChatMsg[],
    cid: string | undefined
  ): { author: string; text: string; cid?: string } | null {
    if (!cid) return null;
    const m = list.find((x) => x.plain.cid === cid);
    if (!m) return null;
    return {
      author: m.fromMe ? "Du" : peer?.username ?? "Peer",
      text: previewForPayload(m.plain),
      cid,
    };
  }

  function replyPreviewForMessage(
    list: ChatMsg[],
    msg: ChatMsg,
    fallbackAuthor: string
  ): { author: string; text: string; cid?: string } | null {
    if (msg.plain.replyToCid) {
      const found = findReplyPreview(list, msg.plain.replyToCid);
      if (found) return found;
      // referenced message gone (expired/deleted) -> use stored preview if any
      if (msg.plain.replyPreview) {
        return {
          author:
            msg.plain.replyPreview.split(":")[0] ?? fallbackAuthor,
          text: msg.plain.replyPreview
            .split(":")
            .slice(1)
            .join(":")
            .trim(),
          cid: msg.plain.replyToCid,
        };
      }
      return null;
    }
    if (!msg.plain.replyPreview) return null;
    return {
      author: msg.plain.replyPreview.split(":")[0] ?? fallbackAuthor,
      text: msg.plain.replyPreview
        .split(":")
        .slice(1)
        .join(":")
        .trim(),
    };
  }

  const jumpClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jumpToCid = useCallback(
    (cid: string, scrollEl: HTMLDivElement | null) => {
      const el = scrollEl?.querySelector<HTMLElement>(
        `[data-cid="${CSS.escape(cid)}"]`
      );
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setJumpHighlightCid(cid);
      if (jumpClearTimer.current) window.clearTimeout(jumpClearTimer.current);
      jumpClearTimer.current = window.setTimeout(() => {
        setJumpHighlightCid(null);
      }, 1700);
    },
    []
  );

  const toggleStar = useCallback((m: ChatMsg) => {
    const cid = m.plain.cid;
    if (!cid) return;
    setStarredCids((prev) => {
      const next = new Set(prev);
      if (next.has(cid)) {
        next.delete(cid);
      } else {
        next.add(cid);
      }
      saveStringSet("vaultchat.starred.cids", next);
      return next;
    });
  }, []);

  const togglePinPeer = useCallback((peerId: string) => {
    setPinnedPeers((prev) => {
      const next = new Set(prev);
      if (next.has(peerId)) {
        next.delete(peerId);
      } else {
        next.add(peerId);
      }
      saveStringSet("vaultchat.pinned.peers", next);
      return next;
    });
  }, []);

  const togglePinMessage = useCallback(
    (chatKey: string | null, m: ChatMsg) => {
      if (!chatKey || !m.plain.cid) return;
      const cid = m.plain.cid;
      setPinnedMessageByPeer((prev) => {
        const next = { ...prev };
        const current = next[chatKey] ?? [];
        if (current.includes(cid)) {
          const filtered = current.filter((x) => x !== cid);
          if (filtered.length === 0) delete next[chatKey];
          else next[chatKey] = filtered;
        } else {
          next[chatKey] = [...current, cid];
        }
        try {
          localStorage.setItem(
            "vaultchat.pinned.messages",
            JSON.stringify(next)
          );
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    []
  );

  const dmPinnedCids = peer ? pinnedMessageByPeer[`dm:${peer.id}`] ?? [] : [];
  const groupPinnedCids = group
    ? pinnedMessageByPeer[`group:${group.id}`] ?? []
    : [];

  const dmPinnedSet = useMemo(() => new Set(dmPinnedCids), [dmPinnedCids]);
  const groupPinnedSet = useMemo(
    () => new Set(groupPinnedCids),
    [groupPinnedCids]
  );

  type PinSummary = { cid: string; preview: string };

  /** Resolve cid -> {preview, cid} pairs by walking messages first, then the
   *  raw IDB-backed buffer. Keeps the original pin order. */
  function resolvePinned(
    cids: string[],
    visible: ChatMsg[],
    raw: { plainJson: string }[]
  ): PinSummary[] {
    if (cids.length === 0) return [];
    const lookup = new Map<string, string>();
    for (const m of visible) {
      if (m.plain.cid) lookup.set(m.plain.cid, previewForPayload(m.plain));
    }
    if (cids.some((c) => !lookup.has(c))) {
      for (const r of raw) {
        try {
          const p = JSON.parse(r.plainJson) as PlainPayload;
          if (p.cid && !lookup.has(p.cid) && cids.includes(p.cid)) {
            lookup.set(p.cid, previewForPayload(p));
          }
        } catch {
          /* ignore */
        }
      }
    }
    return cids.map((cid) => ({
      cid,
      preview: lookup.get(cid) ?? "Angeheftete Nachricht",
    }));
  }

  const pinnedDmList: PinSummary[] = useMemo(() => {
    if (!peer || dmPinnedCids.length === 0) return [];
    const raw = rawDmRef.current.get(peer.id) ?? [];
    return resolvePinned(dmPinnedCids, messages, raw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peer, dmPinnedCids, messages]);

  const pinnedGroupList: PinSummary[] = useMemo(() => {
    if (!group || groupPinnedCids.length === 0) return [];
    const raw = rawGroupRef.current.get(group.id) ?? [];
    return resolvePinned(groupPinnedCids, groupMessages, raw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, groupPinnedCids, groupMessages]);

  const dmBannerKey = peer ? `dm:${peer.id}` : null;
  const groupBannerKey = group ? `group:${group.id}` : null;

  const dmBannerIdx = dmBannerKey
    ? Math.min(
        pinnedBannerIdxByPeer[dmBannerKey] ?? 0,
        Math.max(0, pinnedDmList.length - 1)
      )
    : 0;
  const groupBannerIdx = groupBannerKey
    ? Math.min(
        pinnedBannerIdxByPeer[groupBannerKey] ?? 0,
        Math.max(0, pinnedGroupList.length - 1)
      )
    : 0;

  const pinnedDmBanner =
    pinnedDmList.length > 0 ? pinnedDmList[dmBannerIdx] : null;
  const pinnedGroupBanner =
    pinnedGroupList.length > 0 ? pinnedGroupList[groupBannerIdx] : null;

  const cyclePinnedBanner = useCallback(
    (chatKey: string, total: number) => {
      if (total <= 1) return;
      setPinnedBannerIdxByPeer((prev) => {
        const cur = prev[chatKey] ?? 0;
        return { ...prev, [chatKey]: (cur + 1) % total };
      });
    },
    []
  );

  const lastDmPreviewByPeer = useMemo(() => {
    const out = new Map<string, { text: string; at: number; fromMe: boolean }>();
    for (const [pid, msgs] of rawDmRef.current.entries()) {
      // find last non-meta frame for the preview
      const last = [...msgs]
        .reverse()
        .find((r) => {
          try {
            const p = JSON.parse(r.plainJson) as PlainPayload;
            return (
              p.kind === "text" ||
              p.kind === "file" ||
              p.kind === "voice" ||
              p.kind === "system"
            );
          } catch {
            return false;
          }
        });
      if (!last) continue;
      let text = "";
      try {
        const p = JSON.parse(last.plainJson) as PlainPayload;
        text = previewForPayload(p);
      } catch {
        text = "";
      }
      out.set(pid, { text, at: last.at, fromMe: last.fromMe });
    }
    return out;
  }, [messages.length, users.length, peer?.id]);

  const fmtListTime = useCallback((at?: number) => {
    if (!at) return "";
    const d = new Date(at);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) {
      return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    }
    // Weekday short
    return d.toLocaleDateString(undefined, { weekday: "short" });
  }, []);

  const resizeTextarea = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  const resetTextarea = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "44px";
  }, []);

  const refreshLists = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([loadContacts(), loadGroups()]);
    } finally {
      window.setTimeout(() => setRefreshing(false), 300);
    }
  }, [loadContacts, loadGroups]);

  const filteredUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => u.username.toLowerCase().includes(q));
  }, [users, query]);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => g.name.toLowerCase().includes(q));
  }, [groups, query]);

  const peersWithStars = useMemo(() => {
    const out = new Set<string>();
    for (const [pid, rows] of rawDmRef.current.entries()) {
      for (const r of rows) {
        try {
          const p = JSON.parse(r.plainJson) as PlainPayload;
          if (p.cid && starredCids.has(p.cid)) {
            out.add(pid);
            break;
          }
        } catch {
          /* ignore */
        }
      }
    }
    return out;
  }, [starredCids, messages.length, users.length]);

  const groupsWithStars = useMemo(() => {
    const out = new Set<string>();
    for (const [gid, rows] of rawGroupRef.current.entries()) {
      for (const r of rows) {
        try {
          const p = JSON.parse(r.plainJson) as PlainPayload;
          if (p.cid && starredCids.has(p.cid)) {
            out.add(gid);
            break;
          }
        } catch {
          /* ignore */
        }
      }
    }
    return out;
  }, [starredCids, groupMessages.length, groups.length]);

  const activeFolder = useMemo<ChatFolder | null>(() => {
    if (typeof sidebarFilter !== "string") return null;
    if (!sidebarFilter.startsWith("folder:")) return null;
    const id = sidebarFilter.slice("folder:".length);
    return folders.find((f) => f.id === id) ?? null;
  }, [sidebarFilter, folders]);

  const visibleUsers = useMemo(() => {
    let arr: api.ApiUser[];
    if (sidebarFilter === "group") return [];
    if (sidebarFilter === "fav") {
      arr = filteredUsers.filter((u) => favoritePeers.has(u.id));
    } else if (sidebarFilter === "unread") {
      arr = filteredUsers.filter((u) => (unreadByPeer[u.id] ?? 0) > 0);
    } else if (sidebarFilter === "star") {
      arr = filteredUsers.filter((u) => peersWithStars.has(u.id));
    } else if (activeFolder) {
      const keys = new Set(activeFolder.chatKeys);
      arr = filteredUsers.filter((u) => keys.has(`dm:${u.id}`));
    } else {
      arr = filteredUsers;
    }
    // sort: pinned first, then by recency
    return [...arr].sort((a, b) => {
      const pa = pinnedPeers.has(a.id) ? 1 : 0;
      const pb = pinnedPeers.has(b.id) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      const ta = lastDmPreviewByPeer.get(a.id)?.at ?? 0;
      const tb = lastDmPreviewByPeer.get(b.id)?.at ?? 0;
      return tb - ta;
    });
  }, [
    filteredUsers,
    sidebarFilter,
    unreadByPeer,
    favoritePeers,
    pinnedPeers,
    lastDmPreviewByPeer,
    peersWithStars,
    activeFolder,
  ]);

  const visibleGroups = useMemo(() => {
    if (sidebarFilter === "dm" || sidebarFilter === "unread" || sidebarFilter === "fav")
      return [];
    if (sidebarFilter === "star")
      return filteredGroups.filter((g) => groupsWithStars.has(g.id));
    if (activeFolder) {
      const keys = new Set(activeFolder.chatKeys);
      return filteredGroups.filter((g) => keys.has(`group:${g.id}`));
    }
    return filteredGroups;
  }, [filteredGroups, sidebarFilter, groupsWithStars, activeFolder]);

  const sharedMediaItems = useMemo<SharedMediaItem[]>(() => {
    const rows =
      tab === "dm" && peer
        ? rawDmRef.current.get(peer.id) ?? []
        : tab === "group" && group
          ? rawGroupRef.current.get(group.id) ?? []
          : [];
    return rows
      .flatMap((row) => {
        try {
          const plain = JSON.parse(row.plainJson) as PlainPayload;
          if (plain.kind === "file") {
            return [
              {
                id: row.id,
                kind: "file" as const,
                name: plain.fileName ?? "Datei",
                href: plain.body ?? "#",
                at: row.at,
              },
            ];
          }
          if (plain.kind === "voice") {
            return [
              {
                id: row.id,
                kind: "voice" as const,
                name: "Sprachnachricht",
                href: plain.body ?? "#",
                at: row.at,
              },
            ];
          }
        } catch {
          /* ignore malformed local rows */
        }
        return [];
      })
      .sort((a, b) => b.at - a.at);
  }, [tab, peer, group, messages.length, groupMessages.length]);

  const peerList = useMemo(() => {
    return visibleUsers.map((u) => {
      const prev = lastDmPreviewByPeer.get(u.id);
      const subtitle =
        peer?.id === u.id && typing
          ? "schreibt…"
          : prev
            ? prev.fromMe
              ? `Du: ${prev.text}`
              : prev.text
            : "Keine Nachrichten";
      return (
        <PeerRow
          key={u.id}
          u={u}
          subtitle={subtitle}
          isTyping={peer?.id === u.id && typing}
          metaRight={fmtListTime(prev?.at)}
          unread={unreadByPeer[u.id] ?? 0}
          isFavorite={favoritePeers.has(u.id)}
          isBlocked={blockedPeers.has(u.id)}
          isPinned={pinnedPeers.has(u.id)}
          isOnline={onlinePeers.has(u.id)}
          onTogglePin={() => togglePinPeer(u.id)}
          selected={peer?.id === u.id && tab === "dm"}
          onSelect={() => {
            setTab("dm");
            setPeer(u);
            setGroup(null);
            setInfoOpen(false);
          }}
        />
      );
    });
  }, [
    visibleUsers,
    peer,
    typing,
    tab,
    lastDmPreviewByPeer,
    unreadByPeer,
    favoritePeers,
    blockedPeers,
    pinnedPeers,
    onlinePeers,
    togglePinPeer,
    fmtListTime,
  ]);

  const groupList = useMemo(
    () =>
      visibleGroups.map((g) => {
        const gTyping = groupTypingMap.get(g.id);
        const showGTyping = Boolean(gTyping && gTyping.size > 0);
        return (
          <button
            key={g.id}
            type="button"
            onClick={() => {
              setTab("group");
              setGroup(g);
              setPeer(null);
              setInfoOpen(false);
            }}
            className={`contact-item w-full !mx-0 ${
              group?.id === g.id && tab === "group"
                ? "active"
                : ""
            }`}
          >
            {g.avatar ? (
              <img
                src={g.avatar}
                alt={`${g.name} Avatar`}
                className="contact-avatar !h-9 !w-9 object-cover"
              />
            ) : (
              <div className="contact-avatar !h-9 !w-9 !text-sm">
                {g.name.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="contact-info min-w-0">
              <span className="contact-name">{g.name}</span>
              <p
                className={`contact-preview${showGTyping ? " typing" : ""}`}
              >
                {showGTyping ? (
                  <span className="typing-indicator">
                    <span></span>
                    <span></span>
                    <span></span>
                    schreibt
                  </span>
                ) : (
                  `${g.memberIds.length} Mitglieder`
                )}
              </p>
            </div>
          </button>
        );
      }),
    [visibleGroups, group, tab, groupTypingMap]
  );

  return (
    <div className="flex h-full w-full flex-col bg-[var(--bg)] p-0 md:p-4">
      {notifyPromptOpen && (
        <div className="notify-prompt-banner" role="status">
          <span className="notify-prompt-icon" aria-hidden>
            <IconBell size={16} />
          </span>
          <div className="notify-prompt-text">
            <strong>Benachrichtigungen aktivieren?</strong>
            <span>VaultChat zeigt dir neue Nachrichten an, wenn das Fenster im Hintergrund ist.</span>
          </div>
          <div className="notify-prompt-actions">
            <button
              type="button"
              className="btn btn-secondary !px-3 !py-1 !text-xs"
              onClick={handleDismissNotifyPrompt}
            >
              Nicht jetzt
            </button>
            <button
              type="button"
              className="btn btn-primary !px-3 !py-1 !text-xs"
              onClick={() => void handleEnableNotifications()}
            >
              Erlauben
            </button>
          </div>
        </div>
      )}
      {shortcutsHelpOpen && (
        <ShortcutsHelpModal onClose={() => setShortcutsHelpOpen(false)} />
      )}
      {foldersManageOpen && (
        <FoldersManageModal
          folders={folders}
          users={users}
          groups={groups}
          selfUserId={session.user.id}
          onClose={() => {
            setFoldersManageOpen(false);
            setFolderEdit(null);
          }}
          onSave={(next) => {
            setFolders(next);
            saveFolders(next);
          }}
          editing={folderEdit}
          setEditing={setFolderEdit}
        />
      )}
      {searchOpen && (
        <SearchPanel
          users={users.map((u) => ({ id: u.id, username: u.username }))}
          groups={groups.map((g) => ({ id: g.id, name: g.name }))}
          onClose={() => setSearchOpen(false)}
          onSelect={(type, id) => {
            if (type === "dm") {
              const u = usersRef.current.find((x) => x.id === id) ?? null;
              setTab("dm");
              setGroup(null);
              setPeer(u);
            } else {
              const g = groups.find((x) => x.id === id) ?? null;
              setTab("group");
              setPeer(null);
              setGroup(g);
            }
            setSearchOpen(false);
          }}
        />
      )}
      {safetyOpen && peer && (
        <SafetyNumberDialog
          peerId={peer.id}
          myPublicKey={session.user.publicKey}
          peerPublicKey={peer.publicKey}
          peerLabel={peer.username}
          onClose={() => setSafetyOpen(false)}
          onTrustChanged={(pin) => setPeerPin(pin)}
        />
      )}
      {securityOpen && (
        <SecuritySettings
          onClose={() => setSecurityOpen(false)}
          relayOnly={relayOnly}
          onRelayOnlyChange={setRelayOnly}
          myFingerprint={myFp}
          sendTypingIndicators={sendTypingIndicators}
          onSendTypingIndicatorsChange={(value) => {
            setSendTypingIndicators(value);
            localStorage.setItem("vaultchat.privacy.typing", value ? "on" : "off");
          }}
          sendReadReceipts={sendReadReceipts}
          onSendReadReceiptsChange={(value) => {
            setSendReadReceipts(value);
            localStorage.setItem("vaultchat.privacy.receipts", value ? "on" : "off");
          }}
          onExportBackup={async () => {
            const local = loadLocalIdentity();
            if (!local) return;
            const passphrase = window.prompt(
              "Passphrase für das verschlüsselte Backup eingeben"
            );
            if (!passphrase) return;
            const backup = await encryptIdentityBackup(local, passphrase);
            const blob = new Blob([JSON.stringify(backup, null, 2)], {
              type: "application/json",
            });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `vaultchat-backup-${local.username}-encrypted.json`;
            a.click();
            URL.revokeObjectURL(a.href);
            try {
              localStorage.setItem("vaultchat.backupReminder.dismissed", "1");
            } catch {
              /* ignore */
            }
            setBackupReminderVisible(false);
            pushToast("Backup heruntergeladen", "success");
          }}
        />
      )}
      {forwardTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => {
            setForwardTarget(null);
            setForwardPick(new Set());
          }}
        >
          <div
            className="app-surface w-full max-w-md rounded-2xl p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between gap-2">
              <h2 className="text-lg font-semibold" style={{ color: "var(--text)" }}>
                Weiterleiten
              </h2>
              <button
                type="button"
                className="rounded-lg p-1 hover:bg-[var(--bg-hover)]"
                aria-label="Schließen"
                onClick={() => {
                  setForwardTarget(null);
                  setForwardPick(new Set());
                }}
              >
                <IconX size={18} />
              </button>
            </div>
            <p className="mb-1 text-xs font-medium" style={{ color: "var(--text-muted)" }}>
              Vorschau
            </p>
            <p
              className="mb-4 rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: "var(--border)", color: "var(--text)" }}
            >
              {previewForPayload(forwardTarget.plain)}
            </p>
            <p className="mb-2 text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>
              Kontakte auswählen (einzeln verschlüsselt per DM)
            </p>
            <div
              className="max-h-56 space-y-1 overflow-y-auto rounded-lg border p-2"
              style={{ borderColor: "var(--border)" }}
            >
              {users.filter((u) => !blockedPeers.has(u.id)).length === 0 ? (
                <p className="py-4 text-center text-sm" style={{ color: "var(--text-muted)" }}>
                  Keine Kontakte verfügbar.
                </p>
              ) : (
                users
                  .filter((u) => !blockedPeers.has(u.id))
                  .map((u) => (
                    <label
                      key={u.id}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--bg-hover)]"
                    >
                      <input
                        type="checkbox"
                        checked={forwardPick.has(u.id)}
                        onChange={() => {
                          setForwardPick((prev) => {
                            const next = new Set(prev);
                            if (next.has(u.id)) next.delete(u.id);
                            else next.add(u.id);
                            return next;
                          });
                        }}
                      />
                      <span className="text-sm" style={{ color: "var(--text)" }}>
                        {u.username}
                      </span>
                    </label>
                  ))
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setForwardTarget(null);
                  setForwardPick(new Set());
                }}
              >
                Abbrechen
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={forwardPick.size === 0}
                onClick={() => void commitForward()}
              >
                Senden{forwardPick.size > 0 ? ` (${forwardPick.size})` : ""}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="app-surface flex min-h-0 w-full flex-1 flex-col overflow-visible rounded-2xl md:rounded-3xl">
      {!connected && (
        <div
          className={`connection-banner shrink-0 rounded-t-2xl md:rounded-t-3xl${wsHadError ? " error" : ""}`}
          role="status"
        >
          <IconWifiOff size={15} aria-hidden />
          <span>
            {hasEverConnected
              ? "Verbindung getrennt. Erneuter Aufbau läuft automatisch. Ausgehende DMs warten in der Outbox."
              : "Verbindung zum Server wird hergestellt …"}
          </span>
        </div>
      )}
      {backupReminderVisible && (
        <div className="backup-reminder mx-3 mt-2 shrink-0 md:mx-4">
          <IconShieldCheck size={18} className="shrink-0" style={{ color: "var(--accent)" }} aria-hidden />
          <div className="backup-reminder-text">
            <strong>Backup sichern</strong>
            <span> — Exportiere deine Identität verschlüsselt, sonst kein Zugang von einem neuen Gerät.</span>
          </div>
          <button
            type="button"
            className="btn btn-primary !shrink-0 !px-2.5 !py-1 !text-xs"
            onClick={() => setSecurityOpen(true)}
          >
            Export
          </button>
          <button
            type="button"
            className="!text-[var(--text-muted)] hover:!text-[var(--text)]"
            title="Erinnerung dauerhaft ausblenden"
            aria-label="Erinnerung dauerhaft ausblenden"
            onClick={() => {
              try {
                localStorage.setItem("vaultchat.backupReminder.dismissed", "1");
              } catch {
                /* ignore */
              }
              setBackupReminderVisible(false);
            }}
          >
            <IconX size={16} />
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 overflow-visible">
      <aside
        className={`${
          showSidebar ? "flex" : "hidden"
        } w-full min-w-0 flex-col border-[var(--border)] bg-[var(--bg-sidebar)] md:flex md:w-84 md:min-w-[20rem] md:border-r`}
      >
        <div className="sidebar-header flex items-center justify-between !py-3.5">
          <div className="flex min-w-0 items-center gap-2">
            <VaultChatLogo size={32} style={{ color: "var(--accent)", flexShrink: 0 }} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold" style={{ color: "var(--text)" }}>
                VaultChat
              </p>
              {pendingCount > 0 && (
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {pendingCount} ausstehend
                </p>
              )}
            </div>
          </div>
          <div className="flex gap-1.5">
            <ThemeToggle />
            <button
              type="button"
              onClick={onLock}
              className="btn btn-secondary !px-2.5 !py-1.5 !text-xs"
              title="Konto sperren — Schlüssel aus dem Speicher entfernen"
              aria-label="Konto sperren"
            >
              <IconLock size={14} />
              Sperren
            </button>
          </div>
        </div>

        <div className="px-3 pt-2">
          <div className="search-box flex items-center gap-2 !py-2">
            <span className="app-muted" aria-hidden>
              <IconSearch size={16} />
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Suchen…"
              className="w-full border-0 bg-transparent text-sm outline-none"
              style={{ color: "var(--text)" }}
              aria-label="Kontakte und Gruppen filtern"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="shrink-0 rounded-full p-0.5 transition hover:bg-[var(--bg-hover)]"
                style={{ color: "var(--text-muted)" }}
                aria-label="Suche löschen"
                title="Löschen (Esc)"
              >
                <IconX size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="filter-chips mx-3 mt-3">
          {[
            ["all", "Alle"],
            ["dm", "DMs"],
            ["group", "Gruppen"],
            ["fav", "Favoriten"],
            ["unread", "Ungelesen"],
            ["star", "Markiert"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`filter-chip ${sidebarFilter === value ? "active" : ""}`}
              onClick={() => {
                const next = value as SidebarFilter;
                setSidebarFilter(next);
                if (next === "dm" || next === "unread") setTab("dm");
                if (next === "group") setTab("group");
              }}
            >
              {label}
            </button>
          ))}
          {folders.map((f) => {
            const value: SidebarFilter = `folder:${f.id}`;
            return (
              <button
                key={f.id}
                type="button"
                className={`filter-chip ${sidebarFilter === value ? "active" : ""}`}
                onClick={() => setSidebarFilter(value)}
                title={f.name}
              >
                <span aria-hidden style={{ marginRight: "0.25rem" }}>
                  {f.icon}
                </span>
                {f.name}
              </button>
            );
          })}
          <button
            type="button"
            className="filter-chip filter-chip-add"
            onClick={() => setFoldersManageOpen(true)}
            title="Ordner verwalten"
            aria-label="Ordner verwalten"
          >
            <IconPlus size={12} />
            <span>Ordner</span>
          </button>
        </div>

        {(sidebarFilter === "all" ||
          sidebarFilter === "dm" ||
          sidebarFilter === "unread" ||
          sidebarFilter === "star" ||
          activeFolder !== null) && (
          <>
            <div className="flex items-center justify-end gap-2 border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
              <button
                type="button"
                onClick={() => void refreshLists()}
                className={`btn btn-secondary btn-icon !h-8 !w-8 ${refreshing ? "animate-spin" : ""}`}
                title="Kontakte und Gruppen aktualisieren"
              >
                <IconRefreshCw size={16} />
              </button>
              <button
                type="button"
                onClick={() => setShowAddContact(true)}
                className="btn btn-primary btn-icon !h-8 !w-8"
                title="Kontakt hinzufügen"
                aria-label="Kontakt hinzufügen"
              >
                <IconUserPlus size={16} />
              </button>
            </div>
            <div
              className={`overflow-y-auto p-2 ${
                sidebarFilter === "all" || sidebarFilter === "star"
                  ? "max-h-[42%]"
                  : "flex-1"
              }`}
            >
              {(sidebarFilter === "all" || sidebarFilter === "dm") && (
                <button
                  type="button"
                  onClick={() => {
                    setTab("dm");
                    setGroup(null);
                    setPeer({
                      id: session.user.id,
                      username: "Saved Messages",
                      publicKey: session.user.publicKey,
                    });
                    setInfoOpen(false);
                  }}
                  className={`contact-item w-full !mx-0 ${
                    peer?.id === session.user.id && tab === "dm"
                      ? "active"
                      : ""
                  }`}
                >
                  <div
                    className="contact-avatar !h-9 !w-9"
                    style={{ background: "var(--accent)" }}
                  >
                    <IconBookmark size={16} />
                  </div>
                  <div className="contact-info min-w-0">
                    <span className="contact-name">Saved Messages</span>
                    <p
                      className="contact-preview"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Notizen für dich
                    </p>
                  </div>
                </button>
              )}
              {peerList}
              {sidebarFilter === "star" &&
                visibleUsers.length === 0 &&
                visibleGroups.length > 0 && (
                  <p
                    className="px-2 py-4 text-center text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Keine DMs mit Markierungen. Unten: Gruppen mit Sternen.
                  </p>
                )}
              {activeFolder !== null &&
                visibleUsers.length === 0 &&
                visibleGroups.length === 0 && (
                  <div
                    className="flex flex-col items-center gap-2 px-4 py-8 text-center"
                    style={{ color: "var(--text-muted)" }}
                  >
                    <span aria-hidden style={{ fontSize: "1.6rem" }}>
                      {activeFolder.icon}
                    </span>
                    <p className="text-sm font-medium" style={{ color: "var(--text)" }}>
                      Ordner „{activeFolder.name}" ist leer
                    </p>
                    <p className="text-xs">
                      Klick auf das + neben den Filtern, um Chats hinzuzufügen.
                    </p>
                  </div>
                )}
            </div>
          </>
        )}

        {sidebarFilter === "fav" && (
          <div className="flex-1 overflow-y-auto p-2">
            {peerList.length > 0 ? (
              peerList
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                  Markiere Kontakte als Favorit, damit sie hier erscheinen.
                </p>
              </div>
            )}
          </div>
        )}

        {sidebarFilter === "group" && (
          <>
            <div className="space-y-2 border-b p-3" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-3">
                <label
                  className="group-avatar-edit cursor-pointer"
                  title="Gruppenbild auswählen"
                >
                  {newGroupAvatar ? (
                    <img src={newGroupAvatar} alt="Vorschau" />
                  ) : (
                    <span aria-hidden>＋</span>
                  )}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (!f) return;
                      try {
                        const url = await resizeImageToDataUrl(f);
                        setNewGroupAvatar(url);
                      } catch {
                        pushToast("Bild konnte nicht gelesen werden.", "danger");
                      }
                    }}
                  />
                </label>
                <input
                  className="app-input flex-1 !py-2 text-sm"
                  placeholder="Gruppenname"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  aria-label="Gruppenname"
                />
              </div>
              {newGroupAvatar && (
                <button
                  type="button"
                  className="text-xs underline"
                  style={{ color: "var(--text-muted)" }}
                  onClick={() => setNewGroupAvatar("")}
                >
                  Bild entfernen
                </button>
              )}
              <textarea
                className="app-input w-full !py-2 text-xs"
                placeholder="Beschreibung (optional, max. 280 Zeichen)"
                value={newGroupDescription}
                onChange={(e) =>
                  setNewGroupDescription(e.target.value.slice(0, 280))
                }
                rows={2}
                aria-label="Gruppenbeschreibung"
                style={{ resize: "none" }}
              />
              <div
                className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border p-1"
                style={{ borderColor: "var(--border)" }}
                role="group"
                aria-label="Mitglieder auswählen"
              >
                {users.length === 0 ? (
                  <p
                    className="py-3 text-center text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Noch keine Kontakte. Füge zuerst Kontakte hinzu.
                  </p>
                ) : (
                  users.map((u) => {
                    const checked = newGroupMembers.includes(u.id);
                    return (
                      <label
                        key={u.id}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition hover:bg-[var(--bg-hover)]"
                        style={{ color: "var(--text)" }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            setNewGroupMembers((prev) =>
                              prev.includes(u.id)
                                ? prev.filter((id) => id !== u.id)
                                : [...prev, u.id]
                            );
                          }}
                        />
                        <span
                          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold text-white"
                          style={{ background: userGradient(u.id) }}
                          aria-hidden
                        >
                          {u.username.charAt(0).toUpperCase()}
                        </span>
                        <span className="truncate">{u.username}</span>
                      </label>
                    );
                  })
                )}
              </div>
              {newGroupMembers.length > 0 && (
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {newGroupMembers.length} ausgewählt
                </p>
              )}
              <button
                type="button"
                onClick={() => void createGroup()}
                disabled={!newGroupName.trim() || newGroupMembers.length === 0}
                className="btn btn-primary w-full"
              >
                Gruppe erstellen
              </button>
            </div>
          </>
        )}

        {(sidebarFilter === "all" ||
          sidebarFilter === "group" ||
          sidebarFilter === "star" ||
          activeFolder !== null) && (
          <div className="flex-1 overflow-y-auto p-2">
            {(sidebarFilter === "all" ||
              sidebarFilter === "star" ||
              activeFolder !== null) &&
              visibleGroups.length > 0 && (
              <p className="px-2 pb-1 pt-2 text-[11px] font-semibold" style={{ color: "var(--text-muted)" }}>
                Gruppen
              </p>
            )}
            {groupList}
            {sidebarFilter === "star" &&
              visibleGroups.length === 0 &&
              visibleUsers.length === 0 && (
                <p
                  className="px-6 py-10 text-center text-sm"
                  style={{ color: "var(--text-muted)" }}
                >
                  Noch keine markierten Nachrichten. Sterne erscheinen hier in der Liste.
                </p>
              )}
          </div>
        )}

        <div
          className="relative mt-auto flex items-center gap-3 border-t px-4 py-2.5 text-xs"
          style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
        >
          <div
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold text-white"
            style={{ background: userGradient(session.user.id) }}
          >
            {session.user.username.slice(0, 1).toUpperCase()}
          </div>
          <button
            type="button"
            onClick={() => setSecurityOpen(true)}
            className="min-w-0 flex-1 truncate text-left font-medium"
            style={{ color: "var(--text)" }}
            title={myFp ? `Fingerprint: ${myFp}` : "Eigenes Profil"}
          >
            {session.user.username}
          </button>
          <button
            type="button"
            onClick={() => setShortcutsHelpOpen(true)}
            className="sidebar-footer-action"
            title="Tastatur-Shortcuts (?)"
            aria-label="Tastatur-Shortcuts anzeigen"
          >
            <IconHelpCircle size={16} />
          </button>
          <button
            type="button"
            onClick={() => setSecurityOpen(true)}
            className="sidebar-footer-action"
            title="Einstellungen"
          >
            <IconSettings size={16} />
          </button>
          <button
            type="button"
            onClick={() => setUserMenuOpen((v) => !v)}
            className="sidebar-footer-action"
            title="Mehr"
          >
            <IconMoreVertical size={16} />
          </button>
          {userMenuOpen && (
            <div className="user-menu">
              <button
                type="button"
                className="chat-menu-item"
                onClick={() => {
                  setUserMenuOpen(false);
                  setSecurityOpen(true);
                }}
              >
                <IconSettings size={16} /> Einstellungen
              </button>
              <button
                type="button"
                className="chat-menu-item danger"
                onClick={onLogout}
              >
                Abmelden
              </button>
            </div>
          )}
        </div>
      </aside>

      <main
        className={`${
          showSidebar ? "hidden" : "flex"
        } min-h-0 min-w-0 flex-1 flex-col border-[var(--border)] bg-[var(--bg-chat)] md:flex md:border-0 h-full`}
      >
        {incomingOffer && (
          <div className="flex items-center justify-between border-b border-amber-900/50 bg-amber-950/40 px-4 py-2 text-sm text-amber-100">
            <span>Anruf von {incomingOffer.from.username}</span>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-lg bg-emerald-600 px-3 py-1"
                onClick={() => void acceptIncoming()}
              >
                Annehmen
              </button>
              <button
                type="button"
                className="rounded-lg bg-zinc-700 px-3 py-1"
                onClick={() => {
                  setIncomingOffer(null);
                  setCallStatus("ended");
                }}
              >
                Ablehnen
              </button>
            </div>
          </div>
        )}

        {callStatus !== "idle" && callStatus !== "ended" && (
          <div className="flex items-center justify-between border-b p-2 text-xs" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)", color: "var(--text-secondary)" }}>
            <p>
              Anruf: {callStatus === "ringing" ? "eingehend" : callStatus === "connecting" ? "verbinde..." : callStatus === "connected" ? "verbunden" : "fehlgeschlagen"}
              {relayOnly ? " · Relay geschützt" : ""}
            </p>
            {callRef.current && (
              <button
                type="button"
                className="btn btn-danger !px-2 !py-1 !text-xs"
                onClick={() => {
                  callRef.current?.close();
                  callRef.current = null;
                  setCallRemote(null);
                  setCallStatus("ended");
                }}
              >
                Auflegen
              </button>
            )}
            {callRemote && (
              <audio
                autoPlay
                ref={(el) => {
                  if (el) el.srcObject = callRemote;
                }}
              />
            )}
          </div>
        )}

        {tab === "dm" && !peer && (
          <ChatEmptyState
            hasChats={users.length > 0 || groups.length > 0}
            onAddContact={() => setShowAddContact(true)}
            onCreateGroup={() => {
              setTab("group");
              setSidebarFilter("group");
            }}
            onCreateFolder={() => setFoldersManageOpen(true)}
            onSaveBackup={() => setSecurityOpen(true)}
          />
        )}

        {tab === "dm" && peer && (
          <>
            <header className="chat-header !h-auto min-h-14 !px-3 !py-3 md:!px-4">
              <div className="absolute top-0 left-0 right-0 h-0.5 overflow-hidden rounded-t-2xl">
                <div className={`h-full transition-all duration-500 ${connected ? 'bg-emerald-500 w-full' : 'bg-amber-500 w-1/2 animate-pulse'}`} />
              </div>
              <div className="flex w-full items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  {isMobile && (
                    <button
                      type="button"
                      onClick={() => {
                        setPeer(null);
                        setInfoOpen(false);
                      }}
                      className="header-back-btn"
                      title="Zurück"
                      aria-label="Zurück"
                    >
                      ←
                    </button>
                  )}
                  <button
                    type="button"
                    className="header-identity"
                    onClick={() => setInfoOpen((v) => !v)}
                    title="Profil und Details öffnen"
                  >
                    <div className="header-avatar-wrap">
                      <div
                        className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-semibold text-white shadow-md"
                        style={{
                          background:
                            peer.id === session.user.id
                              ? "var(--accent)"
                              : userGradient(peer.id),
                        }}
                      >
                        {peer.id === session.user.id ? (
                          <IconBookmark size={16} />
                        ) : (
                          peer.username.slice(0, 1).toUpperCase()
                        )}
                      </div>
                      {peer.id !== session.user.id && (
                        <span
                          className={`header-online-dot${
                            onlinePeers.has(peer.id) ? " online" : ""
                          }`}
                        />
                      )}
                    </div>
                    <div className="header-identity-text min-w-0">
                      <p className="truncate font-semibold text-base" style={{ color: "var(--text)" }}>
                        {peer.username}
                      </p>
                      {peer.id === session.user.id ? (
                        <p
                          className="header-status"
                          style={{ color: "var(--text-muted)" }}
                        >
                          Notizen für dich
                        </p>
                      ) : typing ? (
                        <p className="header-status typing">
                          <span className="typing-indicator">
                            <span></span>
                            <span></span>
                            <span></span>
                          </span>
                          schreibt…
                        </p>
                      ) : (
                        <p
                          className="header-status"
                          style={{
                            color: onlinePeers.has(peer.id)
                              ? "var(--success)"
                              : "var(--text-muted)",
                          }}
                        >
                          <span
                            className="header-status-dot"
                            style={{
                              background: onlinePeers.has(peer.id)
                                ? "var(--success)"
                                : "var(--text-muted)",
                            }}
                          />
                          {onlinePeers.has(peer.id)
                            ? "Online"
                            : connected
                              ? "Zuletzt gesehen vor kurzem"
                              : "Offline"}
                        </p>
                      )}
                    </div>
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  {peer.id !== session.user.id && (
                    <button
                      type="button"
                      onClick={() => void beginCall()}
                      className="btn btn-secondary btn-icon !h-9 !w-9"
                      title="Anrufen"
                    >
                      <IconPhone size={18} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setInfoOpen((v) => !v)}
                    className={`btn btn-secondary btn-icon !h-9 !w-9 ${infoOpen ? "!border-[var(--accent)] !bg-[var(--accent-soft)] !text-[var(--accent)]" : ""}`}
                    title="Info"
                  >
                    <IconInfo size={18} />
                  </button>
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setDmMenuOpen((v) => !v)}
                      className="btn btn-secondary btn-icon !h-9 !w-9"
                      title="Mehr"
                    >
                      <IconMoreVertical size={18} />
                    </button>
                    {dmMenuOpen && (
                      <div className="chat-menu">
                        <label className="chat-menu-item cursor-default">
                          <span>Verschwindende Nachrichten</span>
                          <select
                            value={ttlDm}
                            onChange={(e) => void onChangeTtlDm(Number(e.target.value))}
                            className="chat-menu-select"
                            title="Verschwindende Nachrichten"
                          >
                            {TTL_OPTIONS.map((o) => (
                              <option key={o.ms} value={o.ms}>{o.label}</option>
                            ))}
                          </select>
                        </label>
                        <button type="button" className="chat-menu-item" onClick={() => { setDmMenuOpen(false); setSafetyOpen(true); }}>
                          <IconShieldCheck size={16} /> Sicherheitsnummer anzeigen
                        </button>
                        <button type="button" className="chat-menu-item" onClick={() => { setDmMenuOpen(false); setInfoOpen(true); }}>
                          <IconFileText size={16} /> Medien & Dateien
                        </button>
                        <button
                          type="button"
                          className="chat-menu-item"
                          onClick={() => {
                            setFavoritePeers((prev) => {
                              const next = new Set(prev);
                              if (next.has(peer.id)) next.delete(peer.id);
                              else next.add(peer.id);
                              saveStringSet("vaultchat.favorites.peers", next);
                              return next;
                            });
                            setDmMenuOpen(false);
                          }}
                        >
                          <IconPin size={16} /> {favoritePeers.has(peer.id) ? "Aus Favoriten entfernen" : "Zu Favoriten hinzufügen"}
                        </button>
                        <button type="button" className="chat-menu-item" onClick={() => { setDmMenuOpen(false); setSearchOpen(true); }}>
                          <IconSearch size={16} /> Suche in Konversation
                        </button>
                        <button
                          type="button"
                          className="chat-menu-item danger"
                          onClick={() => {
                            setBlockedPeers((prev) => {
                              const next = new Set(prev);
                              if (next.has(peer.id)) next.delete(peer.id);
                              else next.add(peer.id);
                              saveStringSet("vaultchat.blocked.peers", next);
                              return next;
                            });
                            setDmMenuOpen(false);
                          }}
                        >
                          {blockedPeers.has(peer.id) ? "Kontakt entsperren" : "Kontakt blockieren"}
                        </button>
                        <button type="button" className="chat-menu-item" onClick={() => { setDmMenuOpen(false); setInfoOpen(true); }}>
                          <IconInfo size={16} /> Info / Profil anzeigen
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {peerPin?.state === "mismatch" && (
                <div className="mt-2 rounded-lg border border-red-800/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
                  Der Identity-Key dieses Peers hat sich geändert. Nachrichten
                  werden blockiert, bis du die Sicherheitsnummer neu geprüft hast.
                </div>
              )}
              {blockedPeers.has(peer.id) && (
                <div className="mt-2 rounded-lg border border-amber-800/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-100">
                  Dieser Kontakt ist blockiert. Eingehende Nachrichten werden lokal verworfen.
                </div>
              )}
            </header>

            <div
              ref={dmScrollRef}
              className="messages-container !px-4 !py-4 relative"
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (!peer) return;
                const files = Array.from(e.dataTransfer.files ?? []);
                if (files.length === 0) return;
                void (async () => {
                  for (const f of files) await sendDmFile(f);
                })();
              }}
            >
              {dragOver && (
                <div className="absolute inset-0 z-50 flex items-center justify-center rounded-lg bg-emerald-500/20 backdrop-blur-sm border-2 border-dashed border-emerald-400 m-2">
                  <div className="text-center">
                    <p className="text-2xl mb-2">📎</p>
                    <p className="text-sm font-medium text-emerald-100">Dateien hier ablegen</p>
                  </div>
                </div>
              )}
              {(dmScrolledUp || newDmMessageWaiting) && (
                <button
                  type="button"
                  onClick={() => {
                    dmScrollRef.current?.scrollTo({
                      top: dmScrollRef.current.scrollHeight,
                      behavior: "smooth",
                    });
                    setNewDmMessageWaiting(false);
                    setDmScrollUnread(0);
                  }}
                  className="scroll-bottom-fab visible"
                  aria-label="Zum Ende scrollen"
                  title="Zum Ende"
                >
                  <IconArrowDown size={18} />
                  {dmScrollUnread > 0 && (
                    <span className="scroll-bottom-badge">
                      {dmScrollUnread > 99 ? "99+" : dmScrollUnread}
                    </span>
                  )}
                </button>
              )}
              {messages.length > 0 && (
                <div className="e2ee-hint" key="e2ee-hint">
                  <IconShieldCheck size={14} />
                  <span>
                    Ende-zu-Ende verschlüsselt mit {peer.username}.
                    {peerPin?.state !== "verified" &&
                      " Sicherheitsnummer prüfen für maximale Vertrauenswürdigkeit."}
                  </span>
                </div>
              )}
              {pinnedDmBanner && dmBannerKey && (
                <button
                  type="button"
                  className="pinned-banner !mx-0 !mb-3 w-full shrink-0 text-left"
                  onClick={() => {
                    jumpToCid(pinnedDmBanner.cid, dmScrollRef.current);
                    cyclePinnedBanner(dmBannerKey, pinnedDmList.length);
                  }}
                >
                  <span className="pinned-banner-icon">
                    <IconPin size={16} />
                  </span>
                  <span className="pinned-banner-content">
                    <span className="pinned-banner-label">
                      {pinnedDmList.length > 1
                        ? `Angeheftet ${dmBannerIdx + 1}/${pinnedDmList.length}`
                        : "Angeheftet"}
                    </span>
                    <span className="pinned-banner-text">
                      {pinnedDmBanner.preview}
                    </span>
                  </span>
                </button>
              )}
              {messages.flatMap((m, i) => {
                const items: JSX.Element[] = [];
                if (
                  i === 0 ||
                  new Date(m.at).toDateString() !==
                    new Date(messages[i - 1].at).toDateString()
                ) {
                  items.push(
                    <div key={`date-${m.id}`} className="date-separator">
                      <span>{fmtDateLabel(m.at)}</span>
                    </div>
                  );
                }
                items.push(
                  <MessageBubble
                    key={m.plain.cid ?? m.id}
                    msg={m}
                    isGrouped={i > 0 && messages[i - 1].fromMe === m.fromMe}
                    isLastInGroup={
                      i === messages.length - 1 ||
                      messages[i + 1].fromMe !== m.fromMe
                    }
                    isStarred={!!m.plain.cid && starredCids.has(m.plain.cid)}
                    isHighlighted={
                      !!m.plain.cid && m.plain.cid === jumpHighlightCid
                    }
                    isPinned={!!m.plain.cid && dmPinnedSet.has(m.plain.cid)}
                    peerLabel={peer.username}
                    replyToPreview={replyPreviewForMessage(
                      messages,
                      m,
                      peer.username
                    )}
                    onReply={(x) =>
                      setReplyDm({
                        cid: x.plain.cid ?? "",
                        author: x.fromMe ? "Du" : peer.username,
                        text: previewForPayload(x.plain),
                        expiresAt: x.expiresAt,
                      })
                    }
                    onReact={(x, e) => void reactDm(x, e)}
                    onEdit={(x, body) => void editDm(x, body)}
                    onDelete={(x) => void deleteDm(x)}
                    onLocalDelete={(x) => void localDeleteDm(x)}
                    onPollVote={(x, idx) => void votePollDm(x, idx)}
                    onCopy={copyText}
                    onForward={(x) => setForwardTarget(x)}
                    onJumpToCid={(cid) => jumpToCid(cid, dmScrollRef.current)}
                    onToggleStar={toggleStar}
                    onTogglePin={(x) => togglePinMessage(`dm:${peer.id}`, x)}
                  />
                );
                return items;
              })}
              {/* Typing-Indikator wird nun im Chat-Header angezeigt */}
            </div>

            <footer className="chat-input-area !flex-wrap !pb-[calc(env(safe-area-inset-bottom,0px)+12px)] !pt-3">
              {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
              {pollDm && (
                <div className="poll-composer">
                  <p className="text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>
                    Umfrage erstellen
                  </p>
                  <input
                    className="app-input !py-1.5 text-sm"
                    placeholder="Frage"
                    maxLength={200}
                    value={pollDm.question}
                    onChange={(e) =>
                      setPollDm({ ...pollDm, question: e.target.value })
                    }
                  />
                  {pollDm.options.map((opt, i) => (
                    <div key={i} className="poll-composer-row">
                      <input
                        className="app-input !py-1.5 text-sm"
                        placeholder={`Option ${i + 1}`}
                        maxLength={120}
                        value={opt}
                        onChange={(e) => {
                          const next = [...pollDm.options];
                          next[i] = e.target.value;
                          setPollDm({ ...pollDm, options: next });
                        }}
                      />
                      {pollDm.options.length > 2 && (
                        <button
                          type="button"
                          className="btn btn-secondary !px-2 !py-1 !text-xs"
                          onClick={() =>
                            setPollDm({
                              ...pollDm,
                              options: pollDm.options.filter((_, j) => j !== i),
                            })
                          }
                          aria-label={`Option ${i + 1} entfernen`}
                        >
                          <IconX size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                  <div className="poll-composer-actions">
                    {pollDm.options.length < 12 && (
                      <button
                        type="button"
                        className="btn btn-secondary !px-2 !py-1 !text-xs"
                        onClick={() =>
                          setPollDm({ ...pollDm, options: [...pollDm.options, ""] })
                        }
                      >
                        + Option
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-secondary !px-2 !py-1 !text-xs"
                      onClick={() => setPollDm(null)}
                    >
                      Abbrechen
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary !px-3 !py-1 !text-xs"
                      onClick={() => void sendDmPoll()}
                      disabled={
                        !pollDm.question.trim() ||
                        pollDm.options.filter((o) => o.trim()).length < 2
                      }
                    >
                      Senden
                    </button>
                  </div>
                </div>
              )}
              {replyDm && (
                <div className="mb-2 flex items-center justify-between rounded-lg border-l-2 px-3 py-1 text-xs" style={{ borderColor: "var(--accent)", background: "var(--bg-elevated)", color: "var(--text-secondary)" }}>
                  <span>
                    <span style={{ color: "var(--accent)" }}>
                      Antwort an {replyDm.author}:
                    </span>{" "}
                    {replyDm.text.slice(0, 120)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setReplyDm(null)}
                    className="ml-2 transition hover:opacity-70"
                    style={{ color: "var(--text-muted)" }}
                  >
                    ×
                  </button>
                </div>
              )}
              <div className="chat-input-row">
                <button
                  type="button"
                  onClick={() => setEmojiOpen((v) => !v)}
                  className={`chat-tool-button${emojiOpen ? " active" : ""}`}
                  title="Emoji"
                  aria-label="Emoji einfügen"
                >
                  <IconSmile size={18} />
                </button>
                {emojiOpen && (
                  <div className="emoji-picker-anchor">
                    <EmojiPicker
                      excludeCustom
                      onPick={(e) => {
                        setText((current) => {
                          const next = current ? `${current}${e}` : e;
                          window.requestAnimationFrame(() => {
                            resizeTextarea(dmInputRef.current);
                            dmInputRef.current?.focus();
                          });
                          return next;
                        });
                      }}
                      onClose={() => setEmojiOpen(false)}
                    />
                  </div>
                )}
                <label
                  className="chat-tool-button cursor-pointer"
                  title="Datei anhängen"
                  aria-label="Datei anhängen"
                >
                  <IconPaperclip size={18} />
                  <input
                    type="file"
                    className="hidden"
                    multiple
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      e.target.value = "";
                      if (files.length === 0) return;
                      void (async () => {
                        for (const f of files) await sendDmFile(f);
                      })();
                    }}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setViewOnceDm((v) => !v)}
                  className={`chat-tool-button${viewOnceDm ? " active" : ""}`}
                  title={
                    viewOnceDm
                      ? "Einmal anzeigen aktiviert (klicken zum Deaktivieren)"
                      : "Nachricht nur einmal anzeigen lassen"
                  }
                  aria-label="Einmal anzeigen umschalten"
                  aria-pressed={viewOnceDm}
                >
                  <IconLock size={18} />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setPollDm((cur) =>
                      cur ? null : { question: "", options: ["", ""] }
                    )
                  }
                  className={`chat-tool-button${pollDm ? " active" : ""}`}
                  title={pollDm ? "Umfrage abbrechen" : "Umfrage erstellen"}
                  aria-label="Umfrage erstellen"
                  aria-pressed={!!pollDm}
                >
                  <IconBarChart size={18} />
                </button>
                <textarea
                  ref={dmInputRef}
                  className="chat-input-textarea"
                  placeholder={
                    voice.recording
                      ? "Aufnahme läuft…"
                      : viewOnceDm
                        ? "Einmal-Nachricht…"
                        : "Nachricht…"
                  }
                  value={text}
                  disabled={voice.recording || peerPin?.state === "mismatch"}
                  rows={1}
                  onChange={(e) => {
                    setText(e.target.value);
                    resizeTextarea(e.currentTarget);
                    const ws = wsRef.current;
                    if (
                      sendTypingIndicators &&
                      ws &&
                      ws.readyState === WebSocket.OPEN &&
                      peer
                    ) {
                      ws.send(
                        JSON.stringify({
                          type: "typing",
                          toUserId: peer.id,
                          state: "start",
                        })
                      );
                    }
                  }}
                  onPaste={(e) => {
                    const items = e.clipboardData?.items;
                    if (!items) return;
                    const pastedFiles: File[] = [];
                    for (const it of Array.from(items)) {
                      if (it.kind === "file" && it.type.startsWith("image/")) {
                        const f = it.getAsFile();
                        if (f) {
                          const named = new File(
                            [f],
                            f.name && f.name !== "image.png"
                              ? f.name
                              : `image-${Date.now()}-${pastedFiles.length}.${(f.type.split("/")[1] || "png")}`,
                            { type: f.type }
                          );
                          pastedFiles.push(named);
                        }
                      }
                    }
                    if (pastedFiles.length === 0) return;
                    e.preventDefault();
                    void (async () => {
                      for (const f of pastedFiles) await sendDmFile(f);
                    })();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !(e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      void sendDmText();
                    }
                    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                      e.preventDefault();
                      void sendDmText();
                    }
                  }}
                />
                {text.trim() ? (
                  <button
                    type="button"
                    onClick={() => void sendDmText()}
                    disabled={voice.recording}
                    className="btn-send"
                    aria-label="Senden"
                    title="Senden (Enter)"
                  >
                    <IconSend size={16} />
                  </button>
                ) : (
                  <>
                    {voice.recording && (
                      <button
                        type="button"
                        onClick={() => voice.cancel()}
                        className="btn-send cancel"
                        aria-label="Aufnahme verwerfen"
                        title="Aufnahme verwerfen"
                      >
                        <IconX size={16} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void sendDmVoice()}
                      className={`btn-send${voice.recording ? " recording" : " mic"}`}
                      aria-label={voice.recording ? "Aufnahme senden" : "Sprachnachricht aufnehmen"}
                      title={voice.recording ? "Aufnahme senden" : "Sprachnachricht aufnehmen"}
                    >
                      {voice.recording ? (
                        <span className="rec-dot" aria-hidden />
                      ) : (
                        <IconMic size={18} />
                      )}
                    </button>
                  </>
                )}
              </div>
            </footer>
          </>
        )}

        {tab === "group" && !group && (
          <ChatEmptyState
            hasChats={users.length > 0 || groups.length > 0}
            onAddContact={() => setShowAddContact(true)}
            onCreateFolder={() => setFoldersManageOpen(true)}
            onSaveBackup={() => setSecurityOpen(true)}
          />
        )}

        {tab === "group" && group && (
          <>
            <header className="chat-header !px-3 !py-3 md:!px-4">
              <div className="flex w-full items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {isMobile && (
                    <button
                      type="button"
                      onClick={() => setGroup(null)}
                      className="btn btn-secondary !px-2.5 !py-1.5 !text-xs"
                      title="Zurück"
                    >
                      ←
                    </button>
                  )}
                  {group.avatar ? (
                    <img
                      src={group.avatar}
                      alt={`${group.name} Avatar`}
                      className="h-9 w-9 shrink-0 rounded-full object-cover shadow"
                    />
                  ) : (
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-semibold text-white shadow" style={{ background: "var(--accent)" }}>
                      {group.name.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div>
                  <p className="font-medium" style={{ color: "var(--text)" }}>{group.name}</p>
                  {(() => {
                    const ts = groupTypingMap.get(group.id);
                    if (ts && ts.size > 0) {
                      const names = [...ts].map(
                        (id) =>
                          users.find((u) => u.id === id)?.username ?? "Mitglied"
                      );
                      const label =
                        names.length === 1
                          ? `${names[0]} schreibt…`
                          : names.length === 2
                            ? `${names[0]} und ${names[1]} schreiben…`
                            : `${names.length} schreiben…`;
                      return (
                        <p className="header-status typing text-xs">
                          <span className="typing-indicator">
                            <span></span>
                            <span></span>
                            <span></span>
                          </span>
                          {label}
                        </p>
                      );
                    }
                    return (
                      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                        E2EE symmetrisch · {group.memberIds.length} Mitglieder
                      </p>
                    );
                  })()}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setGroupPanelOpen((v) => !v)}
                    className="btn btn-secondary btn-icon !h-9 !w-9"
                    title="Mitglieder"
                  >
                    <IconUsers size={18} />
                  </button>
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setGroupMenuOpen((v) => !v)}
                      className="btn btn-secondary btn-icon !h-9 !w-9"
                      title="Mehr"
                    >
                      <IconMoreVertical size={18} />
                    </button>
                    {groupMenuOpen && (
                      <div className="chat-menu">
                        <label className="chat-menu-item cursor-default">
                          <span>Verschwindende Nachrichten</span>
                          <select
                            value={ttlGroup}
                            onChange={(e) => void onChangeTtlGroup(Number(e.target.value))}
                            className="chat-menu-select"
                            title="Verschwindende Nachrichten"
                          >
                            {TTL_OPTIONS.map((o) => (
                              <option key={o.ms} value={o.ms}>{o.label}</option>
                            ))}
                          </select>
                        </label>
                        <button type="button" className="chat-menu-item" onClick={() => { setGroupMenuOpen(false); setSearchOpen(true); }}>
                          <IconSearch size={16} /> Suche in Konversation
                        </button>
                        <button type="button" className="chat-menu-item" onClick={() => { setGroupMenuOpen(false); setGroupPanelOpen(true); }}>
                          <IconUsers size={16} /> Mitglieder anzeigen
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {groupPanelOpen && (
                <div className="mt-3 rounded-xl border p-3 text-xs" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)", color: "var(--text)" }}>
                  {/* Profile (description + edit) */}
                  {(group.description || group.createdByUserId === session.user.id) && (
                    <div
                      className="mb-2 border-b pb-2"
                      style={{ borderColor: "var(--border)" }}
                    >
                      {groupEditMode ? (
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <label
                              className="group-avatar-edit cursor-pointer"
                              title="Gruppenbild auswählen"
                            >
                              {(() => {
                                const showAvatar = groupEditAvatarRemoved
                                  ? null
                                  : groupEditAvatar || group.avatar;
                                return showAvatar ? (
                                  <img src={showAvatar} alt="Vorschau" />
                                ) : (
                                  <span aria-hidden>＋</span>
                                );
                              })()}
                              <input
                                type="file"
                                accept="image/png,image/jpeg,image/webp"
                                className="hidden"
                                onChange={async (e) => {
                                  const f = e.target.files?.[0];
                                  e.target.value = "";
                                  if (!f) return;
                                  try {
                                    const url = await resizeImageToDataUrl(f);
                                    setGroupEditAvatar(url);
                                    setGroupEditAvatarRemoved(false);
                                  } catch {
                                    pushToast("Bild konnte nicht gelesen werden.", "danger");
                                  }
                                }}
                              />
                            </label>
                            {(groupEditAvatar || (group.avatar && !groupEditAvatarRemoved)) && (
                              <button
                                type="button"
                                className="text-[10px] underline"
                                style={{ color: "var(--text-muted)" }}
                                onClick={() => {
                                  setGroupEditAvatar("");
                                  setGroupEditAvatarRemoved(true);
                                }}
                              >
                                Bild entfernen
                              </button>
                            )}
                          </div>
                          <input
                            className="app-input w-full !py-1 !text-xs"
                            value={groupEditName}
                            onChange={(e) => setGroupEditName(e.target.value)}
                            placeholder="Gruppenname"
                            maxLength={64}
                            aria-label="Gruppenname bearbeiten"
                          />
                          <textarea
                            className="app-input w-full !py-1 !text-xs"
                            value={groupEditDescription}
                            onChange={(e) =>
                              setGroupEditDescription(e.target.value.slice(0, 280))
                            }
                            placeholder="Beschreibung (optional, max. 280 Zeichen)"
                            rows={2}
                            style={{ resize: "none" }}
                            aria-label="Gruppenbeschreibung bearbeiten"
                          />
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setGroupEditMode(false)}
                              className="btn btn-secondary !px-2 !py-1 !text-[10px]"
                              disabled={groupEditBusy}
                            >
                              Abbrechen
                            </button>
                            <button
                              type="button"
                              onClick={() => void saveGroupProfile()}
                              className="btn btn-primary !px-2 !py-1 !text-[10px]"
                              disabled={groupEditBusy || !groupEditName.trim()}
                            >
                              {groupEditBusy ? "…" : "Speichern"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          {group.description ? (
                            <p
                              className="whitespace-pre-wrap leading-snug"
                              style={{ color: "var(--text-secondary)" }}
                            >
                              {group.description}
                            </p>
                          ) : (
                            <p
                              className="italic"
                              style={{ color: "var(--text-muted)" }}
                            >
                              Keine Beschreibung gesetzt.
                            </p>
                          )}
                          {group.createdByUserId === session.user.id && (
                            <button
                              type="button"
                              onClick={() => {
                                setGroupEditName(group.name);
                                setGroupEditDescription(group.description ?? "");
                                setGroupEditMode(true);
                              }}
                              className="btn btn-secondary !px-2 !py-1 !text-[10px]"
                            >
                              Profil bearbeiten
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  {group.createdByUserId === session.user.id && (
                    <div
                      className="mb-2 border-b pb-2"
                      style={{ borderColor: "var(--border)" }}
                    >
                      <p
                        className="mb-1 text-[11px] font-semibold"
                        style={{ color: "var(--text-muted)" }}
                      >
                        Einladungslinks
                      </p>
                      {groupInvitesLoading ? (
                        <p
                          className="text-[10px]"
                          style={{ color: "var(--text-muted)" }}
                        >
                          Lade…
                        </p>
                      ) : groupInvites.length === 0 ? (
                        <p
                          className="mb-1.5 text-[10px] italic"
                          style={{ color: "var(--text-muted)" }}
                        >
                          Noch keine. Klick „Neuer Link" um einen zu erstellen.
                        </p>
                      ) : (
                        <ul className="mb-1.5 space-y-1">
                          {groupInvites.map((inv) => {
                            const url = buildInviteUrl(inv.token);
                            const expired =
                              inv.expiresAt > 0 && Date.now() > inv.expiresAt;
                            const exhausted =
                              inv.maxUses > 0 && inv.usedCount >= inv.maxUses;
                            return (
                              <li
                                key={inv.token}
                                className="flex items-center gap-1.5 rounded px-1.5 py-1"
                                style={{ background: "var(--bg-hover)" }}
                              >
                                <input
                                  readOnly
                                  value={url}
                                  className="app-input flex-1 !py-0.5 !text-[10px] font-mono"
                                  onFocus={(e) => e.currentTarget.select()}
                                  aria-label="Einladungslink"
                                />
                                <button
                                  type="button"
                                  className="btn btn-secondary !px-1.5 !py-0.5 !text-[10px]"
                                  onClick={() =>
                                    void navigator.clipboard?.writeText(url).then(
                                      () =>
                                        pushToast(
                                          "Link kopiert.",
                                          "success"
                                        )
                                    )
                                  }
                                  title="Kopieren"
                                >
                                  Kopieren
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-danger !px-1.5 !py-0.5 !text-[10px]"
                                  onClick={() =>
                                    void handleRevokeInvite(inv.token)
                                  }
                                  title={
                                    expired
                                      ? "abgelaufen"
                                      : exhausted
                                        ? "verbraucht"
                                        : "Widerrufen"
                                  }
                                >
                                  ×
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleCreateInvite()}
                        disabled={creatingInvite}
                        className="btn btn-secondary !px-2 !py-1 !text-[10px]"
                      >
                        {creatingInvite ? "…" : "Neuer Link (7 Tage)"}
                      </button>
                    </div>
                  )}
                  <ul className="mb-2 space-y-1">
                    {group.memberIds.map((mid) => {
                      const u = users.find((x) => x.id === mid);
                      const label = u?.username ?? (mid === session.user.id ? "Du" : mid.slice(0, 8));
                      const isFounder =
                        Boolean(group.createdByUserId) &&
                        mid === group.createdByUserId;
                      const canManageMembers =
                        !group.createdByUserId ||
                        group.createdByUserId === session.user.id;
                      return (
                        <li
                          key={mid}
                          className="flex items-center justify-between gap-2 rounded px-2 py-1"
                          style={{ background: "var(--bg-hover)" }}
                        >
                          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <span className="truncate">{label}</span>
                            {isFounder && (
                              <span
                                className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold"
                                style={{
                                  background: "var(--accent-soft)",
                                  color: "var(--accent)",
                                }}
                              >
                                Gründer
                              </span>
                            )}
                          </span>
                          {mid !== session.user.id && canManageMembers && (
                            <button
                              type="button"
                              onClick={() => void removeMember(mid)}
                              className="btn btn-danger shrink-0 !px-2 !py-0.5 !text-[10px]"
                            >
                              Entfernen
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <div className="flex gap-2">
                    <select
                      value={addMemberId}
                      onChange={(e) => setAddMemberId(e.target.value)}
                      className="app-input flex-1 !py-1 !text-xs"
                    >
                      <option value="">— Mitglied wählen —</option>
                      {users
                        .filter((u) => !group.memberIds.includes(u.id))
                        .map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.username}
                          </option>
                        ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => void addMember()}
                      disabled={!addMemberId}
                      className="btn btn-primary !px-2 !py-1 !text-[10px] disabled:opacity-40"
                    >
                      Hinzufügen
                    </button>
                    <button
                      type="button"
                      onClick={() => void leaveCurrentGroup()}
                      className="btn btn-danger !px-2 !py-1 !text-[10px]"
                    >
                      Verlassen
                    </button>
                  </div>
                </div>
              )}
            </header>
            <div
              ref={groupScrollRef}
              className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 relative"
              onDragOver={(e) => {
                e.preventDefault();
                setGroupDragOver(true);
              }}
              onDragLeave={() => setGroupDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setGroupDragOver(false);
                if (!group) return;
                const files = Array.from(e.dataTransfer.files ?? []);
                if (files.length === 0) return;
                void (async () => {
                  for (const f of files) await sendGroupFile(f);
                })();
              }}
            >
              {groupDragOver && (
                <div className="absolute inset-0 z-50 m-2 flex items-center justify-center rounded-lg border-2 border-dashed border-emerald-400 bg-emerald-500/20 backdrop-blur-sm">
                  <div className="text-center">
                    <p className="mb-2 text-2xl">📎</p>
                    <p className="text-sm font-medium text-emerald-100">Dateien in die Gruppe legen</p>
                  </div>
                </div>
              )}
              {pinnedGroupBanner && groupBannerKey && (
                <button
                  type="button"
                  className="pinned-banner !mx-0 w-full shrink-0 text-left"
                  onClick={() => {
                    jumpToCid(pinnedGroupBanner.cid, groupScrollRef.current);
                    cyclePinnedBanner(groupBannerKey, pinnedGroupList.length);
                  }}
                >
                  <span className="pinned-banner-icon">
                    <IconPin size={16} />
                  </span>
                  <span className="pinned-banner-content">
                    <span className="pinned-banner-label">
                      {pinnedGroupList.length > 1
                        ? `Angeheftet ${groupBannerIdx + 1}/${pinnedGroupList.length}`
                        : "Angeheftet"}
                    </span>
                    <span className="pinned-banner-text">
                      {pinnedGroupBanner.preview}
                    </span>
                  </span>
                </button>
              )}
              {(groupScrolledUp || newGroupMessageWaiting) && (
                <button
                  type="button"
                  onClick={() => {
                    groupScrollRef.current?.scrollTo({
                      top: groupScrollRef.current.scrollHeight,
                      behavior: "smooth",
                    });
                    setNewGroupMessageWaiting(false);
                    setGroupScrollUnread(0);
                  }}
                  className="scroll-bottom-fab visible"
                  aria-label="Zum Ende scrollen"
                  title="Zum Ende"
                >
                  <IconArrowDown size={18} />
                  {groupScrollUnread > 0 && (
                    <span className="scroll-bottom-badge">
                      {groupScrollUnread > 99 ? "99+" : groupScrollUnread}
                    </span>
                  )}
                </button>
              )}
              {(() => {
                const threadCounts = new Map<string, number>();
                for (const m of groupMessages) {
                  const parentCid = m.plain.threadParentCid;
                  if (parentCid) {
                    threadCounts.set(parentCid, (threadCounts.get(parentCid) ?? 0) + 1);
                  }
                }
                const mainMsgs = groupMessages.filter(
                  (m) => !m.plain.threadParentCid
                );
                return mainMsgs.map((m, i) => (
                <MessageBubble
                  key={m.plain.cid ?? m.id}
                  msg={m}
                  isGrouped={
                    i > 0 &&
                    mainMsgs[i - 1].fromUserId === m.fromUserId &&
                    mainMsgs[i - 1].fromMe === m.fromMe
                  }
                  isLastInGroup={
                    i === mainMsgs.length - 1 ||
                    mainMsgs[i + 1].fromUserId !== m.fromUserId
                  }
                  threadReplyCount={
                    m.plain.cid ? threadCounts.get(m.plain.cid) : undefined
                  }
                  onOpenThread={(x) => {
                    if (x.plain.cid) setOpenThreadCid(x.plain.cid);
                  }}
                  isStarred={!!m.plain.cid && starredCids.has(m.plain.cid)}
                  isHighlighted={
                    !!m.plain.cid && m.plain.cid === jumpHighlightCid
                  }
                  isPinned={!!m.plain.cid && groupPinnedSet.has(m.plain.cid)}
                  peerLabel={
                    users.find((u) => u.id === m.fromUserId)?.username ?? group.name
                  }
                  replyToPreview={replyPreviewForMessage(
                    groupMessages,
                    m,
                    users.find((u) => u.id === m.fromUserId)?.username ?? "Mitglied"
                  )}
                  onReply={(x) => {
                    const author = x.fromMe
                      ? "Du"
                      : users.find((u) => u.id === x.fromUserId)?.username ?? "Mitglied";
                    setReplyGroup({
                      cid: x.plain.cid ?? "",
                      author,
                      text: previewForPayload(x.plain),
                      expiresAt: x.expiresAt,
                    });
                  }}
                  onReact={(x, e) => void reactGroup(x, e)}
                  onEdit={(x, body) => void editGroup(x, body)}
                  onDelete={(x) => void deleteGroup(x)}
                  onLocalDelete={(x) => void localDeleteGroupMsg(x)}
                  onPollVote={(x, idx) => void votePollGroup(x, idx)}
                  onCopy={copyText}
                  onForward={(x) => setForwardTarget(x)}
                  onJumpToCid={(cid) => jumpToCid(cid, groupScrollRef.current)}
                  onToggleStar={toggleStar}
                  onTogglePin={(x) => togglePinMessage(`group:${group.id}`, x)}
                />
              ));
              })()}
            </div>
            <footer className="chat-input-area !flex-wrap !pb-[calc(env(safe-area-inset-bottom,0px)+12px)] !pt-3">
              {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
              {pollGroup && (
                <div className="poll-composer">
                  <p className="text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>
                    Umfrage erstellen
                  </p>
                  <input
                    className="app-input !py-1.5 text-sm"
                    placeholder="Frage"
                    maxLength={200}
                    value={pollGroup.question}
                    onChange={(e) =>
                      setPollGroup({ ...pollGroup, question: e.target.value })
                    }
                  />
                  {pollGroup.options.map((opt, i) => (
                    <div key={i} className="poll-composer-row">
                      <input
                        className="app-input !py-1.5 text-sm"
                        placeholder={`Option ${i + 1}`}
                        maxLength={120}
                        value={opt}
                        onChange={(e) => {
                          const next = [...pollGroup.options];
                          next[i] = e.target.value;
                          setPollGroup({ ...pollGroup, options: next });
                        }}
                      />
                      {pollGroup.options.length > 2 && (
                        <button
                          type="button"
                          className="btn btn-secondary !px-2 !py-1 !text-xs"
                          onClick={() =>
                            setPollGroup({
                              ...pollGroup,
                              options: pollGroup.options.filter((_, j) => j !== i),
                            })
                          }
                          aria-label={`Option ${i + 1} entfernen`}
                        >
                          <IconX size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                  <div className="poll-composer-actions">
                    {pollGroup.options.length < 12 && (
                      <button
                        type="button"
                        className="btn btn-secondary !px-2 !py-1 !text-xs"
                        onClick={() =>
                          setPollGroup({
                            ...pollGroup,
                            options: [...pollGroup.options, ""],
                          })
                        }
                      >
                        + Option
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-secondary !px-2 !py-1 !text-xs"
                      onClick={() => setPollGroup(null)}
                    >
                      Abbrechen
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary !px-3 !py-1 !text-xs"
                      onClick={() => void sendGroupPoll()}
                      disabled={
                        !pollGroup.question.trim() ||
                        pollGroup.options.filter((o) => o.trim()).length < 2
                      }
                    >
                      Senden
                    </button>
                  </div>
                </div>
              )}
              {replyGroup && (
                <div className="mb-2 flex items-center justify-between rounded-lg border-l-2 px-3 py-1 text-xs" style={{ borderColor: "var(--accent)", background: "var(--bg-elevated)", color: "var(--text-secondary)" }}>
                  <span>
                    <span style={{ color: "var(--accent)" }}>
                      Antwort an {replyGroup.author}:
                    </span>{" "}
                    {replyGroup.text.slice(0, 120)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setReplyGroup(null)}
                    className="ml-2 transition hover:opacity-70"
                    style={{ color: "var(--text-muted)" }}
                  >
                    ×
                  </button>
                </div>
              )}
              <div className="chat-input-row">
                <button
                  type="button"
                  onClick={() => setGroupEmojiOpen((v) => !v)}
                  className={`chat-tool-button${groupEmojiOpen ? " active" : ""}`}
                  title="Emoji"
                  aria-label="Emoji einfügen"
                >
                  <IconSmile size={18} />
                </button>
                {groupEmojiOpen && (
                  <div className="emoji-picker-anchor">
                    <EmojiPicker
                      excludeCustom
                      onPick={(e) => {
                        setGroupText((current) => {
                          const next = current ? `${current}${e}` : e;
                          window.requestAnimationFrame(() => {
                            resizeTextarea(groupInputRef.current);
                            groupInputRef.current?.focus();
                          });
                          return next;
                        });
                      }}
                      onClose={() => setGroupEmojiOpen(false)}
                    />
                  </div>
                )}
                <label
                  className="chat-tool-button cursor-pointer"
                  title="Datei anhängen"
                  aria-label="Datei anhängen"
                >
                  <IconPaperclip size={18} />
                  <input
                    type="file"
                    className="hidden"
                    multiple
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      e.target.value = "";
                      if (files.length === 0) return;
                      void (async () => {
                        for (const f of files) await sendGroupFile(f);
                      })();
                    }}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setViewOnceGroup((v) => !v)}
                  className={`chat-tool-button${viewOnceGroup ? " active" : ""}`}
                  title={
                    viewOnceGroup
                      ? "Einmal anzeigen aktiviert (klicken zum Deaktivieren)"
                      : "Nachricht nur einmal anzeigen lassen"
                  }
                  aria-label="Einmal anzeigen umschalten"
                  aria-pressed={viewOnceGroup}
                >
                  <IconLock size={18} />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setPollGroup((cur) =>
                      cur ? null : { question: "", options: ["", ""] }
                    )
                  }
                  className={`chat-tool-button${pollGroup ? " active" : ""}`}
                  title={pollGroup ? "Umfrage abbrechen" : "Umfrage erstellen"}
                  aria-label="Umfrage erstellen"
                  aria-pressed={!!pollGroup}
                >
                  <IconBarChart size={18} />
                </button>
                <textarea
                  ref={groupInputRef}
                  className="chat-input-textarea"
                  placeholder={
                    groupVoice.recording
                      ? "Aufnahme läuft…"
                      : viewOnceGroup
                        ? "Einmal-Nachricht…"
                        : "Gruppennachricht…"
                  }
                  value={groupText}
                  disabled={groupVoice.recording}
                  rows={1}
                  onChange={(e) => {
                    const value = e.target.value;
                    setGroupText(value);
                    resizeTextarea(e.currentTarget);
                    // Mention detection: find last `@` before cursor
                    const cursor = e.currentTarget.selectionStart ?? value.length;
                    const before = value.slice(0, cursor);
                    const at = before.lastIndexOf("@");
                    if (at >= 0) {
                      const sub = before.slice(at + 1);
                      const hasSpace = /\s/.test(sub);
                      if (!hasSpace) {
                        setMentionOpen(true);
                        setMentionStart(at);
                        setMentionQuery(sub);
                        setMentionIndex(0);
                        return;
                      }
                    }
                    if (mentionOpen) setMentionOpen(false);
                    const ws = wsRef.current;
                    if (
                      sendTypingIndicators &&
                      ws &&
                      ws.readyState === WebSocket.OPEN &&
                      group
                    ) {
                      ws.send(
                        JSON.stringify({
                          type: "typing",
                          groupId: group.id,
                          state: "start",
                        })
                      );
                    }
                  }}
                  onPaste={(e) => {
                    const items = e.clipboardData?.items;
                    if (!items) return;
                    const pastedFiles: File[] = [];
                    for (const it of Array.from(items)) {
                      if (it.kind === "file" && it.type.startsWith("image/")) {
                        const f = it.getAsFile();
                        if (f) {
                          const named = new File(
                            [f],
                            f.name && f.name !== "image.png"
                              ? f.name
                              : `image-${Date.now()}-${pastedFiles.length}.${(f.type.split("/")[1] || "png")}`,
                            { type: f.type }
                          );
                          pastedFiles.push(named);
                        }
                      }
                    }
                    if (pastedFiles.length === 0) return;
                    e.preventDefault();
                    void (async () => {
                      for (const f of pastedFiles) await sendGroupFile(f);
                    })();
                  }}
                  onKeyDown={(e) => {
                    if (mentionOpen) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setMentionIndex((i) => i + 1);
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setMentionIndex((i) => Math.max(0, i - 1));
                        return;
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setMentionOpen(false);
                        return;
                      }
                      if (e.key === "Tab" || e.key === "Enter") {
                        const candidates = users.filter((u) =>
                          group.memberIds.includes(u.id) &&
                          u.username.toLowerCase().startsWith(mentionQuery.toLowerCase())
                        );
                        const pick = candidates[mentionIndex % Math.max(1, candidates.length)];
                        if (pick) {
                          e.preventDefault();
                          const before = groupText.slice(0, mentionStart);
                          const after = groupText.slice(mentionStart + 1 + mentionQuery.length);
                          const next = `${before}@${pick.username} ${after}`;
                          setGroupText(next);
                          setMentionOpen(false);
                          window.requestAnimationFrame(() => {
                            const el = groupInputRef.current;
                            if (!el) return;
                            const pos = before.length + 1 + pick.username.length + 1;
                            el.focus();
                            el.setSelectionRange(pos, pos);
                          });
                          return;
                        }
                      }
                    }
                    if (e.key === "Enter" && !e.shiftKey && !(e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      void sendGroupText();
                    }
                    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                      e.preventDefault();
                      void sendGroupText();
                    }
                  }}
                />
                {mentionOpen && (() => {
                  const candidates = users
                    .filter(
                      (u) =>
                        group.memberIds.includes(u.id) &&
                        u.id !== session.user.id &&
                        u.username.toLowerCase().startsWith(mentionQuery.toLowerCase())
                    )
                    .slice(0, 6);
                  if (candidates.length === 0) return null;
                  return (
                    <div className="mention-popover">
                      {candidates.map((u, i) => (
                        <button
                          key={u.id}
                          type="button"
                          className={`mention-item${
                            i === mentionIndex % candidates.length ? " active" : ""
                          }`}
                          onMouseDown={(ev) => {
                            ev.preventDefault();
                            const before = groupText.slice(0, mentionStart);
                            const after = groupText.slice(
                              mentionStart + 1 + mentionQuery.length
                            );
                            const next = `${before}@${u.username} ${after}`;
                            setGroupText(next);
                            setMentionOpen(false);
                            window.requestAnimationFrame(() => {
                              const el = groupInputRef.current;
                              if (!el) return;
                              const pos = before.length + 1 + u.username.length + 1;
                              el.focus();
                              el.setSelectionRange(pos, pos);
                            });
                          }}
                        >
                          <span
                            className="mention-avatar"
                            style={{ background: userGradient(u.id) }}
                          >
                            {u.username.charAt(0).toUpperCase()}
                          </span>
                          <span>@{u.username}</span>
                        </button>
                      ))}
                    </div>
                  );
                })()}
                {groupText.trim() ? (
                  <button
                    type="button"
                    onClick={() => void sendGroupText()}
                    disabled={groupVoice.recording}
                    className="btn-send"
                    aria-label="Senden"
                    title="Senden"
                  >
                    <IconSend size={16} />
                  </button>
                ) : (
                  <>
                    {groupVoice.recording && (
                      <button
                        type="button"
                        onClick={() => groupVoice.cancel()}
                        className="btn-send cancel"
                        aria-label="Aufnahme verwerfen"
                        title="Aufnahme verwerfen"
                      >
                        <IconX size={16} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void sendGroupVoice()}
                      className={`btn-send${groupVoice.recording ? " recording" : " mic"}`}
                      aria-label={
                        groupVoice.recording
                          ? "Aufnahme senden"
                          : "Sprachnachricht aufnehmen"
                      }
                      title={
                        groupVoice.recording
                          ? "Aufnahme senden"
                          : "Sprachnachricht aufnehmen"
                      }
                    >
                      {groupVoice.recording ? (
                        <span className="rec-dot" aria-hidden />
                      ) : (
                        <IconMic size={18} />
                      )}
                    </button>
                  </>
                )}
              </div>
            </footer>
          </>
        )}
      </main>

      {openThreadCid && group && (() => {
        const parent = groupMessages.find((m) => m.plain.cid === openThreadCid);
        if (!parent) return null;
        const replies = groupMessages.filter(
          (m) => m.plain.threadParentCid === openThreadCid
        );
        const resolveAuthor = (m: ChatMsg) =>
          m.fromMe
            ? "Du"
            : users.find((u) => u.id === m.fromUserId)?.username ?? "Mitglied";
        return (
          <ThreadPanel
            parent={parent}
            replies={replies}
            resolveAuthor={resolveAuthor}
            onClose={() => setOpenThreadCid(null)}
            onSend={async (body) => {
              const payload: PlainPayload = {
                v: 2,
                cid: newCid(),
                kind: "text",
                body,
                threadParentCid: openThreadCid,
              };
              await sendGroupWire(group, payload);
            }}
            onReact={(x, e) => void reactGroup(x, e)}
            onEdit={(x, body) => void editGroup(x, body)}
            onDelete={(x) => void deleteGroup(x)}
            onLocalDelete={(x) => void localDeleteGroupMsg(x)}
            onCopy={copyText}
            onForward={(x) => setForwardTarget(x)}
            onJumpToCid={(cid) => jumpToCid(cid, groupScrollRef.current)}
          />
        );
      })()}

      {/* Right info panel (desktop) */}
      {!isMobile && showConversation && (
        <aside className={`info-panel-shell hidden md:flex ${showInfo ? "open" : ""}`}>
          <InfoPanel
            mode={tab}
            peer={peer}
            group={group}
            peerFp={peerFp}
            onSafety={() => setSafetyOpen(true)}
            onOpenSearch={() => setSearchOpen(true)}
            onClearChat={async () => {
              if (peer) {
                const rows = rawDmRef.current.get(peer.id) ?? [];
                for (const r of rows) await idbDeleteDm(r.id).catch(() => {});
                rawDmRef.current.set(peer.id, []);
                rebuildDm(peer.id);
              }
              if (group) {
                const rows = rawGroupRef.current.get(group.id) ?? [];
                for (const r of rows) await idbDeleteGroupMsg(r.id).catch(() => {});
                rawGroupRef.current.set(group.id, []);
                rebuildGroup(group.id);
              }
            }}
            mutedPeers={mutedPeers}
            setMutedPeers={setMutedPeers}
            mutedGroups={mutedGroups}
            setMutedGroups={setMutedGroups}
            isFavorite={Boolean(peer && favoritePeers.has(peer.id))}
            onToggleFavorite={() => {
              if (!peer) return;
              setFavoritePeers((prev) => {
                const next = new Set(prev);
                if (next.has(peer.id)) next.delete(peer.id);
                else next.add(peer.id);
                saveStringSet("vaultchat.favorites.peers", next);
                return next;
              });
            }}
            isBlocked={Boolean(peer && blockedPeers.has(peer.id))}
            onToggleBlocked={() => {
              if (!peer) return;
              setBlockedPeers((prev) => {
                const next = new Set(prev);
                if (next.has(peer.id)) next.delete(peer.id);
                else next.add(peer.id);
                saveStringSet("vaultchat.blocked.peers", next);
                return next;
              });
            }}
            sharedMediaItems={sharedMediaItems}
          />
        </aside>
      )}

      {/* Mobile info drawer */}
      {isMobile && infoOpen && showConversation && (
        <div className="fixed inset-0 z-50 bg-black/50 p-3" onClick={() => setInfoOpen(false)}>
          <div
            className="app-surface ml-auto h-full w-full max-w-sm overflow-y-auto rounded-2xl p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>Details</p>
              <button
                type="button"
                onClick={() => setInfoOpen(false)}
                className="btn btn-secondary !px-2 !py-1 !text-xs"
              >
                ✕
              </button>
            </div>
            <InfoPanel
              mode={tab}
              peer={peer}
              group={group}
              peerFp={peerFp}
              onSafety={() => {
                setInfoOpen(false);
                setSafetyOpen(true);
              }}
              onOpenSearch={() => {
                setInfoOpen(false);
                setSearchOpen(true);
              }}
              onClearChat={async () => {
                setInfoOpen(false);
                if (peer) {
                  const rows = rawDmRef.current.get(peer.id) ?? [];
                  for (const r of rows) await idbDeleteDm(r.id).catch(() => {});
                  rawDmRef.current.set(peer.id, []);
                  rebuildDm(peer.id);
                }
                if (group) {
                  const rows = rawGroupRef.current.get(group.id) ?? [];
                  for (const r of rows) await idbDeleteGroupMsg(r.id).catch(() => {});
                  rawGroupRef.current.set(group.id, []);
                  rebuildGroup(group.id);
                }
              }}
              mutedPeers={mutedPeers}
              setMutedPeers={setMutedPeers}
              mutedGroups={mutedGroups}
              setMutedGroups={setMutedGroups}
              isFavorite={Boolean(peer && favoritePeers.has(peer.id))}
              onToggleFavorite={() => {
                if (!peer) return;
                setFavoritePeers((prev) => {
                  const next = new Set(prev);
                  if (next.has(peer.id)) next.delete(peer.id);
                  else next.add(peer.id);
                  saveStringSet("vaultchat.favorites.peers", next);
                  return next;
                });
              }}
              isBlocked={Boolean(peer && blockedPeers.has(peer.id))}
              onToggleBlocked={() => {
                if (!peer) return;
                setBlockedPeers((prev) => {
                  const next = new Set(prev);
                  if (next.has(peer.id)) next.delete(peer.id);
                  else next.add(peer.id);
                  saveStringSet("vaultchat.blocked.peers", next);
                  return next;
                });
              }}
              sharedMediaItems={sharedMediaItems}
            />
          </div>
        </div>
      )}
      {isMobile && !showConversation && (
        <div className="fixed bottom-0 left-0 right-0 z-40 border-t p-2 backdrop-blur" style={{ borderColor: "var(--border)", background: "var(--bg-glass)" }}>
          <div className="mx-auto flex max-w-md gap-2">
            <button
              type="button"
              onClick={() => setTab("dm")}
              className="flex-1 rounded-xl px-3 py-2 text-sm font-medium transition"
              style={tab === "dm" ? { background: "var(--accent)", color: "white" } : { border: "1px solid var(--border)", color: "var(--text-secondary)" }}
            >
              Direkt
            </button>
            <button
              type="button"
              onClick={() => setTab("group")}
              className="flex-1 rounded-xl px-3 py-2 text-sm font-medium transition"
              style={tab === "group" ? { background: "var(--accent)", color: "white" } : { border: "1px solid var(--border)", color: "var(--text-secondary)" }}
            >
              Gruppen
            </button>
          </div>
        </div>
      )}
      </div>
      </div>

      <AddContactModal
        isOpen={showAddContact}
        onClose={() => setShowAddContact(false)}
        sessionToken={session.token}
        sessionUserId={session.user.id}
        onContactSelected={(user) => {
          setUsers((prev) => {
            if (prev.find((u) => u.id === user.id)) return prev;
            return [...prev, user];
          });
          void observePeerKey(user.id, user.publicKey);
          setTab("dm");
          setPeer(user);
        }}
      />
      {onboardingOpen && (
        <OnboardingOverlay
          onDone={() => setOnboardingOpen(false)}
          onRequestBackup={() => setSecurityOpen(true)}
        />
      )}
      <ToastRegion />
    </div>
  );
}

function PeerRow({
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

function InfoPanel({
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
  const title = mode === "dm" ? peer?.username ?? "Kontakt" : group?.name ?? "Gruppe";
  const initials = (title.slice(0, 1) || "•").toUpperCase();
  const status = mode === "dm" ? "Online" : `${group?.memberIds.length ?? 0} Mitglieder`;
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
          {mode === "group" && group?.avatar ? (
            <img
              src={group.avatar}
              alt={`${group.name} Avatar`}
              className="info-avatar-large"
              style={{ objectFit: "cover" }}
            />
          ) : (
            <div className="info-avatar-large">
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
          title={isFavorite ? "Aus Favoriten entfernen" : "Als Favorit markieren"}
          disabled={mode !== "dm"}
        >
          <IconPin size={18} />
          <span>{isFavorite ? "Favorit" : "Favorit"}</span>
        </button>
        <button
          type="button"
          className={`info-action-button ${isMuted ? "active-warning" : ""}`}
          onClick={toggleMute}
          title={isMuted ? "Stummschaltung aufheben" : "Stummschalten"}
        >
          <IconBell size={18} />
          <span>
            {isMuted ? "Stumm" : "Benachrichtigungen"}
          </span>
        </button>
        <button
          type="button"
          className="info-action-button"
          onClick={onToggleBlocked}
          disabled={mode !== "dm"}
          title={isBlocked ? "Kontakt entsperren" : "Kontakt blockieren"}
        >
          <IconShieldCheck size={18} />
          <span>{isBlocked ? "Blockiert" : "Blockieren"}</span>
        </button>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-2">
        <button
          type="button"
          className="info-action-button !h-auto !py-3"
          onClick={onOpenSearch}
          title="Suchen"
        >
          <IconSearch size={18} />
          <span>Suchen</span>
        </button>
      </div>

      {mode === "dm" && peer && (
        <div className="info-section">
          <p className="info-section-title">Benutzerinfo</p>
          <div className="rounded-xl border p-3" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
            <div className="flex items-center justify-between">
              <span className="text-sm" style={{ color: "var(--text-secondary)" }}>Username</span>
              <span className="font-medium" style={{ color: "var(--text)" }}>@{peer.username}</span>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-sm" style={{ color: "var(--text-secondary)" }}>ID</span>
              <button
                type="button"
                className="group inline-flex items-center gap-1 font-mono text-xs"
                style={{ color: "var(--accent)" }}
                title="ID kopieren"
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
        <p className="info-section-title">Sicherheit</p>
        <p className="text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          Nachrichten und Anrufe sind Ende-zu-Ende verschlüsselt. Der Server
          leitet nur versiegelte Daten. Perfect Forward Secrecy aktiv.
        </p>
      </div>

      {mode === "dm" && (
        <div className="info-section">
          <p className="info-section-title">Sicherheitsnummer</p>
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
                Verifizieren
              </span>
            </div>
          </button>
        </div>
      )}

      <div className="info-section">
        <p className="info-section-title">Geteilte Inhalte</p>
        {sharedMediaItems.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            Noch keine Dateien oder Sprachnotizen in diesem Chat.
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
        Chat-Verlauf leeren
      </button>

      <p className="mt-auto pt-4 text-center text-[11px] app-muted">
        Verlauf nur lokal, verschlüsselt (IndexedDB).
      </p>
    </div>
  );
}
