import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Session } from "../lib/sessionHelpers";
import * as api from "../lib/api";
import { decryptIncomingSealedDm } from "../lib/incomingDm";
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
import {
  generateKeyMaterial,
  ensurePostQuantumKem,
  loadKeyMaterial,
  replenishOneTimePreKeys,
  saveKeyMaterial,
  toUploadBody,
} from "../lib/keyStore";
import { encryptIdentityBackup } from "../lib/backup";
import { loadLocalIdentity } from "../lib/localIdentity";
import {
  MessageBubble,
  previewForPayload,
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
import { SearchPanel } from "./SearchPanel";
import { AddContactModal } from "./AddContactModal";
import { SecuritySettings } from "./SecuritySettings";
import { ChatEmptyState } from "./ChatEmptyState";
import {
  IconAlertTriangle,
  IconBell,
  IconFileText,
  IconInfo,
  IconLock,
  IconMic,
  IconMoreVertical,
  IconPaperclip,
  IconPin,
  IconPhone,
  IconRefreshCw,
  IconSearch,
  IconSend,
  IconSettings,
  IconShield,
  IconShieldCheck,
  IconSmile,
  IconUsers,
} from "./Icons";

type Tab = "dm" | "group";
type SidebarFilter = "all" | "dm" | "group" | "fav" | "unread";
type CallStatus = "idle" | "ringing" | "connecting" | "connected" | "failed" | "ended";
const EMOJI_CHOICES = ["😀", "😂", "😍", "👍", "🔥", "🎉", "😮", "😢", "🙏", "✅"];

type PendingGroupFrame = {
  id: string;
  groupId: string;
  ciphertext: string;
  createdAt: number;
};

type SharedMediaItem = {
  id: string;
  kind: "file" | "voice";
  name: string;
  href: string;
  at: number;
};

function SidebarEmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="sidebar-empty-state">
      <div className="sidebar-empty-icon">
        <IconUsers size={18} />
      </div>
      <p>{title}</p>
      <span>{body}</span>
      {action}
    </div>
  );
}

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

function humanDmSendError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === "prekey_bundle_unavailable" || msg === "x3dh_required") {
    return "Sicherer X3DH-Schluesselaustausch fehlgeschlagen. Der Kontakt muss einmal online sein oder seine PreKeys neu hochladen.";
  }
  if (msg === "missing_ratchet_session") {
    return "Keine sichere Ratchet-Session gefunden. Starte den Chat neu, sobald der Kontakt PreKeys verfuegbar hat.";
  }
  return msg;
}

function maxE2eFileBytes(): number {
  const e2eMaxB64 = 128 * 1024 * 1024;
  return Math.floor(e2eMaxB64 / 1.5);
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
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
  const [typing, setTyping] = useState(false);
  const [myFp, setMyFp] = useState<string | null>(null);
  const [peerFp, setPeerFp] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupMembers, setNewGroupMembers] = useState<string[]>([]);
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
  const [mutedGroups, setMutedGroups] = useState<Set<string>>(new Set());
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
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [peerPin, setPeerPin] = useState<PeerPin | null>(null);
  const [relayOnly, setRelayOnly] = useState(
    () => localStorage.getItem("vaultchat.privacy.relayOnly") === "on"
  );
  const [addMemberId, setAddMemberId] = useState<string>("");
  const [groupPanelOpen, setGroupPanelOpen] = useState(false);
  const [groupVoiceOpen, setGroupVoiceOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [isMobile, setIsMobile] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sidebarFilter, setSidebarFilter] = useState<SidebarFilter>("all");
  const [unreadByPeer, setUnreadByPeer] = useState<Record<string, number>>({});
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [newDmMessageWaiting, setNewDmMessageWaiting] = useState(false);
  const [newGroupMessageWaiting, setNewGroupMessageWaiting] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [dmMenuOpen, setDmMenuOpen] = useState(false);
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [sendTypingIndicators, setSendTypingIndicators] = useState(
    () => localStorage.getItem("vaultchat.privacy.typing") === "on"
  );
  const [sendReadReceipts, setSendReadReceipts] = useState(
    () => localStorage.getItem("vaultchat.privacy.receipts") === "on"
  );
  const [notificationEnabled, setNotificationEnabled] = useState(
    () => localStorage.getItem("vaultchat.privacy.notifications") === "on"
  );
  const [notificationPreview, setNotificationPreview] = useState(
    () => localStorage.getItem("vaultchat.privacy.notificationPreview") === "on"
  );
  const [notificationPermission, setNotificationPermission] = useState(
    () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission)
  );
  const [serverStatus, setServerStatus] = useState<api.ServerStatus | null>(null);
  const [serverStatusError, setServerStatusError] = useState<string | null>(null);

  const callRef = useRef<{
    close: () => void;
    handleRemote?: (p: RtcPayload) => void | Promise<void>;
    addIce?: (c: RTCIceCandidateInit) => void | Promise<void>;
  } | null>(null);
  const pendingRtcRef = useRef<Map<string, RtcPayload[]>>(new Map());

  const wsRef = useRef<WebSocket | null>(null);
  const wsAuthenticatedRef = useRef(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const peerRef = useRef<api.ApiUser | null>(null);
  const groupRef = useRef<api.ApiGroup | null>(null);
  const usersRef = useRef<api.ApiUser[]>([]);
  const groupsRef = useRef<api.ApiGroup[]>([]);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seen = useRef(new Set<string>());
  const pendingGroupFramesRef = useRef<PendingGroupFrame[]>([]);
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

  useShortcuts({
    onSearch: () => setSearchOpen(true),
    onEscape: () => {
      setSearchOpen(false);
      setEmojiOpen(false);
      setSafetyOpen(false);
      setInfoOpen(false);
      setGroupPanelOpen(false);
      setDmMenuOpen(false);
      setGroupMenuOpen(false);
      setUserMenuOpen(false);
    },
    onLock: () => onLock(),
  });

  const voice = useVoiceRecorder();

  useEffect(() => {
    const mq = window.matchMedia?.("(max-width: 768px)");
    if (!mq) return;
    const apply = () => setIsMobile(Boolean(mq.matches));
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [status, rtc] = await Promise.all([
          api.serverStatus(session.token),
          api.getRtcConfig(session.token),
        ]);
        if (cancelled) return;
        setServerStatus(status);
        setServerStatusError(null);
        if (rtc.forceRelay) {
          setRelayOnly(true);
          localStorage.setItem("vaultchat.privacy.relayOnly", "on");
        }
      } catch (err) {
        if (cancelled) return;
        setServerStatusError(err instanceof Error ? err.message : "server_status_unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.token]);

  useEffect(() => {
    if (!incomingOffer) return;
    const t = window.setTimeout(() => {
      setIncomingOffer(null);
      setCallStatus("ended");
    }, 30_000);
    return () => window.clearTimeout(t);
  }, [incomingOffer]);

  const maybeNotify = useCallback((title: string, body: string) => {
    if (!notificationEnabled) return;
    if (!("Notification" in window) || document.visibilityState === "visible") return;
    if (Notification.permission !== "granted") return;
    if (notificationPreview) {
      new Notification(title, { body, tag: "vaultchat-message" });
    } else {
      new Notification("VaultChat", {
        body: "Neue verschluesselte Nachricht",
        tag: "vaultchat-message",
      });
    }
  }, [notificationEnabled, notificationPreview]);

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
    const memberIds = Array.from(new Set(g.flatMap((x) => x.memberIds))).filter(
      (id) => id !== session.user.id
    );
    if (memberIds.length > 0) {
      const { users: members } = await api.listUsers(session.token, memberIds);
      setUsers((prev) => {
        const byId = new Map(prev.map((u) => [u.id, u]));
        for (const member of members) byId.set(member.id, member);
        return Array.from(byId.values());
      });
    }
  }, [session.token, session.user.id]);

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

  /** Pre-Key-Bundle auf den Server hochladen (X3DH-API, kompatibel mit eurer Konto-Identität). */
  useEffect(() => {
    void (async () => {
      try {
        let km = await loadKeyMaterial();
        if (!km) {
          km = await generateKeyMaterial(session.secretKey);
          await saveKeyMaterial(km);
        }
        const withPqKem = await ensurePostQuantumKem(km);
        if (withPqKem !== km) {
          km = withPqKem;
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
      setPeerPin(await getPin(peer.id));
    })();
  }, [peer]);

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
      setTtlDm(savedTtl ? Number(savedTtl) || 0 : 0);
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
      setTtlGroup(savedTtl ? Number(savedTtl) || 0 : 0);
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
      // Smooth scroll to bottom with animation
      el.scrollTo({
        top: el.scrollHeight,
        behavior: 'smooth'
      });
      setDmScrolledUp(false);
    } else {
      // User has scrolled up - show indicator
      setDmScrolledUp(true);
      setNewDmMessageWaiting(true);
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
    } else {
      setGroupScrolledUp(true);
      setNewGroupMessageWaiting(true);
    }
  }, [groupMessages]);

  // Scroll event handler für DM
  const handleDmScroll = useCallback(() => {
    const el = dmScrollRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setDmScrolledUp(!isNearBottom);
    if (isNearBottom) {
      setNewDmMessageWaiting(false);
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
    if (!wsAuthenticatedRef.current) return;
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
      let encrypted: Awaited<ReturnType<typeof drEncryptJsonForDm>>;
      try {
        encrypted = await drEncryptJsonForDm(
          session.secretKey,
          toUser.id,
          toUser.publicKey,
          JSON.stringify(payload),
          tokenRef.current
        );
      } catch (err) {
        setError(humanDmSendError(err));
        return null;
      }
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
      if (ws && ws.readyState === WebSocket.OPEN && wsAuthenticatedRef.current) {
        ws.send(
          JSON.stringify({ type: "dm", toUserId: toUser.id, envelope, cid })
        );
      }
      return tmpId;
    },
    [session.secretKey, session.user.id, rebuildDm, refreshPendingCount, blockedPeers]
  );

  const sendGroupWire = useCallback(
    async (g: api.ApiGroup, payload: PlainPayload, suppressLocal = false) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !wsAuthenticatedRef.current) {
        setError("Keine Verbindung.");
        return null;
      }
      const p: PlainPayload = { ...payload, senderUserId: session.user.id };
      let ciphertext = "";
      let repairedKey = false;
      for (;;) {
        try {
          ciphertext = await encryptGroupPayload(g.id, p);
          break;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (
            !repairedKey &&
            (message === "no_group_key" ||
              message === "no_group_state" ||
              message === "no_sender_state")
          ) {
            repairedKey = true;
            await rotateGroupKey(g, g.memberIds);
            continue;
          }
          if (message === "no_group_key" || message === "no_group_state" || message === "no_sender_state") {
            setError(
              "Gruppenschluessel fehlt auf diesem Geraet. Oeffne die Gruppe neu oder lasse dich erneut hinzufuegen."
            );
            void loadGroups().catch(() => {});
            return null;
          }
          setError("Gruppennachricht konnte nicht verschluesselt werden.");
          return null;
        }
      }
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
      return tmpId;
    },
    [loadGroups, rebuildGroup, session.user.id]
  );

  const handleIncomingGroupFrame = useCallback(
    async (frame: PendingGroupFrame, allowQueue = true) => {
      if (seen.current.has(frame.id)) return true;
      let plain: PlainPayload;
      try {
        plain = await decryptGroupPayload(frame.groupId, frame.ciphertext);
      } catch {
        if (allowQueue) {
          pendingGroupFramesRef.current = [
            ...pendingGroupFramesRef.current.filter((x) => x.id !== frame.id),
            frame,
          ].slice(-100);
        }
        return false;
      }
      seen.current.add(frame.id);
      const fromUserId = plain.senderUserId ?? "";
      const ttl = plain.ttlMs ?? 0;
      await idbPutGroupMsg({
        id: frame.id,
        groupId: frame.groupId,
        fromUserId,
        plainJson: JSON.stringify(plain),
        at: frame.createdAt,
        ...(ttl ? { expiresAt: frame.createdAt + ttl } : {}),
      });
      const arr = rawGroupRef.current.get(frame.groupId) ?? [];
      arr.push({
        id: frame.id,
        fromMe: fromUserId === session.user.id,
        fromUserId,
        plainJson: JSON.stringify(plain),
        at: frame.createdAt,
        ...(ttl ? { expiresAt: frame.createdAt + ttl } : {}),
      });
      rawGroupRef.current.set(frame.groupId, arr);
      if (groupRef.current?.id === frame.groupId) rebuildGroup(frame.groupId);
      if (groupRef.current?.id !== frame.groupId && !mutedGroups.has(frame.groupId)) {
        const groupName = groupsRef.current.find((x) => x.id === frame.groupId)?.name ?? "Gruppe";
        maybeNotify(groupName, previewForPayload(plain));
      }
      return true;
    },
    [maybeNotify, mutedGroups, rebuildGroup, session.user.id]
  );

  const retryPendingGroupFrames = useCallback(
    async (groupId?: string) => {
      const pending = pendingGroupFramesRef.current;
      if (pending.length === 0) return;
      const stillPending: PendingGroupFrame[] = [];
      for (const frame of pending) {
        if (groupId && frame.groupId !== groupId) {
          stillPending.push(frame);
          continue;
        }
        const handled = await handleIncomingGroupFrame(frame, false);
        if (!handled && !seen.current.has(frame.id)) stillPending.push(frame);
      }
      pendingGroupFramesRef.current = stillPending;
    },
    [handleIncomingGroupFrame]
  );

  /** Flush pending envelopes from outbox. Called on reconnect + periodically. */
  const flushOutbox = useCallback(async () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !wsAuthenticatedRef.current) return;
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
    let stopped = false;
    const url = getWsUrl();
    const ws = new WebSocket(url);
    wsRef.current = ws;
    wsAuthenticatedRef.current = false;
    ws.onopen = () => {
      const activeWs = wsRef.current;
      if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
      activeWs.send(JSON.stringify({ type: "auth", token: tokenRef.current }));
    };
    ws.onclose = () => {
      setConnected(false);
      wsAuthenticatedRef.current = false;
      wsRef.current = null;
      if (stopped) return;
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
    ws.onerror = () => setError("WebSocket-Fehler");
    ws.onmessage = (ev) => {
      void (async () => {
        try {
          const data = JSON.parse(String(ev.data)) as Record<string, unknown>;

          if (data.type === "auth_ok") {
            const activeWs = wsRef.current;
            if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
            wsAuthenticatedRef.current = true;
            reconnectAttempts.current = 0;
            setConnected(true);
            void flushOutbox();
            if (coverRef.current) {
              coverRef.current.stop();
              coverRef.current = null;
            }
            const peerList = usersRef.current.map((u) => ({
              id: u.id,
              publicKey: u.publicKey,
            }));
            if (peerList.length > 0) {
              coverRef.current = startCoverTraffic(activeWs, peerList, () => {
                return activeWs.readyState === WebSocket.OPEN;
              });
            }
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
          const cur = peerRef.current;
          if (
            data.type === "typing" &&
            cur &&
            data.fromUserId === cur.id
          ) {
            setTyping(true);
            if (typingTimer.current) clearTimeout(typingTimer.current);
            typingTimer.current = setTimeout(() => setTyping(false), 2800);
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
            const dec = await decryptIncomingSealedDm(
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
              const existingState = await getGroupKeyState(plain.groupId);
              if (!existingState || existingState.rootKey !== plain.keyB64) {
                const groupMembers =
                  groupsRef.current.find((x) => x.id === plain.groupId)?.memberIds ??
                  usersRef.current.map((u) => u.id);
                await initGroupKeyState(
                  plain.groupId,
                  groupMembers,
                  session.user.id,
                  session.secretKey,
                  keyBytes
                );
              }
              await loadGroups();
              await retryPendingGroupFrames(plain.groupId);
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
            await handleIncomingGroupFrame({
              id: String(data.id),
              groupId: String(data.groupId),
              ciphertext: String(data.ciphertext),
              createdAt: Number(data.createdAt ?? Date.now()),
            });
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
      stopped = true;
      ws.close();
      clearInterval(interval);
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      if (coverRef.current) {
        coverRef.current.stop();
        coverRef.current = null;
      }
      if (typingTimer.current) clearTimeout(typingTimer.current);
    };
  }, [
    session,
    loadGroups,
    sendDmWire,
    handleIncomingGroupFrame,
    retryPendingGroupFrames,
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
    if (peerPin?.state === "mismatch") {
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
    };
    await sendDmWire(peer, payload);
    setText("");
    resetTextarea(dmInputRef.current);
    setReplyDm(null);
  }

  async function sendDmFile(file: File) {
    if (!peer) return;
    /** Server: 128 MB verschlüsselter Umschlag; Data-URL + DR + Seal wachsen ~1,4–1,5×. */
    const maxFile = maxE2eFileBytes();
    if (file.size > maxFile) {
      setError(
        `Datei zu groß: Der E2E-Server-Rahmen beträgt 128 MB (Umschlag). Wegen Data-URL und Verschlüsselung bitte Dateien bis etwa ${Math.floor(maxFile / (1024 * 1024))} MB.`
      );
      return;
    }
    const body = await readFileAsDataUrl(file);
    const payload: PlainPayload = {
      v: 2,
      cid: newCid(),
      kind: "file",
      body,
      fileName: file.name,
      fileSize: file.size,
      mime: file.type,
      ...(ttlDm ? { ttlMs: ttlDm } : {}),
    };
    await sendDmWire(peer, payload);
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
      };
      await sendDmWire(peer, payload);
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
    };
    const sentId = await sendGroupWire(group, payload);
    if (!sentId) return;
    setGroupText("");
    resetTextarea(groupInputRef.current);
    setReplyGroup(null);
  }

  async function sendGroupFile(file: File) {
    if (!group) return;
    const maxFile = maxE2eFileBytes();
    if (file.size > maxFile) {
      setError(
        `Datei zu gross: Bitte Dateien bis etwa ${Math.floor(maxFile / (1024 * 1024))} MB senden.`
      );
      return;
    }
    setError(null);
    const body = await readFileAsDataUrl(file);
    const payload: PlainPayload = {
      v: 2,
      cid: newCid(),
      kind: "file",
      body,
      fileName: file.name,
      fileSize: file.size,
      mime: file.type,
      ...(ttlGroup ? { ttlMs: ttlGroup } : {}),
    };
    await sendGroupWire(group, payload);
  }

  async function sendGroupVoice() {
    if (!group) return;
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
        ...(ttlGroup ? { ttlMs: ttlGroup } : {}),
      };
      await sendGroupWire(group, payload);
    } else {
      const ok = await voice.start();
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
    await sendDmWire(peer, payload);
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
    await sendDmWire(peer, payload);
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
    await sendDmWire(peer, payload);
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
    const sentId = await sendGroupWire(group, payload);
    if (!sentId) return;
    await idbDeleteGroupMsg(m.id);
    const arr = (rawGroupRef.current.get(group.id) ?? []).filter(
      (x) => x.id !== m.id
    );
    rawGroupRef.current.set(group.id, arr);
    rebuildGroup(group.id);
  }

  function copyText(t: string) {
    void navigator.clipboard?.writeText(t).catch(() => {});
  }

  async function distributeGroupKey(g: api.ApiGroup, memberIds: string[], keyB64: string) {
    const knownUsers = new Map(usersRef.current.map((u) => [u.id, u]));
    const missing = memberIds.filter((mid) => mid !== session.user.id && !knownUsers.has(mid));
    if (missing.length > 0) {
      const { users: fetched } = await api.listUsers(session.token, missing);
      for (const u of fetched) knownUsers.set(u.id, u);
      setUsers((prev) => {
        const byId = new Map(prev.map((u) => [u.id, u]));
        for (const u of fetched) byId.set(u.id, u);
        return Array.from(byId.values());
      });
    }
    for (const mid of memberIds) {
      if (mid === session.user.id) continue;
      const u = knownUsers.get(mid);
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
    const { group: g } = await api.createGroup(session.token, {
      name: newGroupName.trim(),
      memberIds,
    });
    const key = await randomGroupKey();
    await setGroupKey(g.id, key);
    await initGroupKeyState(g.id, memberIds, session.user.id, session.secretKey, key);
    await loadGroups();
    await distributeGroupKey(g, memberIds, base64FromUint8(key));
    setNewGroupName("");
    setNewGroupMembers([]);
    setGroup(g);
    setTab("group");
    // Refresh group list immediately
    await loadGroups();
  }

  async function rotateGroupKey(g: api.ApiGroup, newMembers: string[]) {
    const key = await randomGroupKey();
    await setGroupKey(g.id, key);
    await initGroupKeyState(g.id, newMembers, session.user.id, session.secretKey, key);
    await distributeGroupKey(g, newMembers, base64FromUint8(key));
  }

  async function addMember() {
    if (!group || !addMemberId) return;
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "add_failed");
    }
  }

  async function removeMember(memberId: string) {
    if (!group) return;
    try {
      const { group: g2 } = await api.removeGroupMember(
        session.token,
        group.id,
        memberId
      );
      setGroup(g2);
      await loadGroups();
      await rotateGroupKey(g2, g2.memberIds);
    } catch (e) {
      setError(e instanceof Error ? e.message : "remove_failed");
    }
  }

  async function leaveCurrentGroup() {
    if (!group) return;
    try {
      await api.leaveGroup(session.token, group.id);
      setGroup(null);
      await loadGroups();
    } catch (e) {
      setError(e instanceof Error ? e.message : "leave_failed");
    }
  }

  async function beginCallWith(target: api.ApiUser) {
    setCallStatus("connecting");
    try {
      const ctrl = await startCall(
        target,
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
      const queued = pendingRtcRef.current.get(target.id) ?? [];
      pendingRtcRef.current.delete(target.id);
      for (const payload of queued) {
        await ctrl.handleRemote?.(payload);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "call_failed");
      setCallStatus("failed");
    }
  }

  async function beginCall() {
    if (!peer) return;
    await beginCallWith(peer);
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
  ): { author: string; text: string } | null {
    if (!cid) return null;
    const m = list.find((x) => x.plain.cid === cid);
    if (!m) return null;
    return {
      author: m.fromMe ? "Du" : peer?.username ?? "Peer",
      text: previewForPayload(m.plain),
    };
  }

  function replyPreviewForMessage(
    list: ChatMsg[],
    msg: ChatMsg,
    fallbackAuthor: string
  ): { author: string; text: string } | null {
    if (msg.plain.replyToCid) {
      return findReplyPreview(list, msg.plain.replyToCid);
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

  const lastDmPreviewByPeer = useMemo(() => {
    const out = new Map<string, { text: string; at: number }>();
    for (const [pid, msgs] of rawDmRef.current.entries()) {
      const last = msgs[msgs.length - 1];
      if (!last) continue;
      const plain = last.plainJson;
      let text = "";
      try {
        const p = JSON.parse(plain) as PlainPayload;
        text = previewForPayload(p);
      } catch {
        text = "";
      }
      out.set(pid, { text, at: last.at });
    }
    return out;
  }, [messages.length, users.length]);

  const lastGroupPreviewByGroup = useMemo(() => {
    const out = new Map<string, { text: string; at: number }>();
    for (const [gid, msgs] of rawGroupRef.current.entries()) {
      const last = msgs[msgs.length - 1];
      if (!last) continue;
      try {
        const p = JSON.parse(last.plainJson) as PlainPayload;
        const author =
          last.fromUserId === session.user.id
            ? "Du"
            : usersRef.current.find((u) => u.id === last.fromUserId)?.username ?? "Mitglied";
        out.set(gid, { text: `${author}: ${previewForPayload(p)}`, at: last.at });
      } catch {
        out.set(gid, { text: "Neue Nachricht", at: last.at });
      }
    }
    return out;
  }, [groupMessages.length, groups.length, users.length, session.user.id]);

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

  const visibleUsers = useMemo(() => {
    if (sidebarFilter === "group") return [];
    if (sidebarFilter === "fav") {
      return filteredUsers.filter((u) => favoritePeers.has(u.id));
    }
    if (sidebarFilter === "unread") {
      return filteredUsers.filter((u) => (unreadByPeer[u.id] ?? 0) > 0);
    }
    return filteredUsers;
  }, [filteredUsers, sidebarFilter, unreadByPeer, favoritePeers]);

  const visibleGroups = useMemo(() => {
    if (sidebarFilter === "dm" || sidebarFilter === "unread" || sidebarFilter === "fav") return [];
    return filteredGroups;
  }, [filteredGroups, sidebarFilter]);

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
      return (
        <PeerRow
          key={u.id}
          u={u}
          subtitle={prev?.text ?? "Keine Nachrichten"}
          metaRight={fmtListTime(prev?.at)}
          unread={unreadByPeer[u.id] ?? 0}
          isFavorite={favoritePeers.has(u.id)}
          isBlocked={blockedPeers.has(u.id)}
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
  }, [visibleUsers, peer, tab, lastDmPreviewByPeer, unreadByPeer, favoritePeers, blockedPeers]);

  const groupList = useMemo(
    () =>
      visibleGroups.map((g) => {
        const prev = lastGroupPreviewByGroup.get(g.id);
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
            <div className="contact-avatar !h-9 !w-9 !text-sm">
              {g.name.slice(0, 1).toUpperCase()}
            </div>
            <div className="contact-info min-w-0">
              <span className="contact-name">{g.name}</span>
              <p className="contact-preview">
                {prev?.text ?? `${g.memberIds.length} Mitglieder`}
              </p>
            </div>
            <div className="contact-meta">
              <span className="contact-time">{fmtListTime(prev?.at)}</span>
            </div>
          </button>
        );
      }),
    [visibleGroups, group, tab, lastGroupPreviewByGroup, fmtListTime]
  );

  const canCreateGroup = newGroupName.trim().length > 0 && newGroupMembers.length > 0;
  const hasContacts = users.length > 0;

  return (
    <div className="flex h-full w-full flex-col bg-[var(--bg)] p-0 md:p-4">
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
          onRelayOnlyChange={(value) => {
            setRelayOnly(value);
            localStorage.setItem("vaultchat.privacy.relayOnly", value ? "on" : "off");
          }}
          myFingerprint={myFp}
          serverStatus={serverStatus}
          serverStatusError={serverStatusError}
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
          notificationEnabled={notificationEnabled}
          onNotificationEnabledChange={(value) => {
            setNotificationEnabled(value);
            localStorage.setItem("vaultchat.privacy.notifications", value ? "on" : "off");
          }}
          notificationPreview={notificationPreview}
          onNotificationPreviewChange={(value) => {
            setNotificationPreview(value);
            localStorage.setItem("vaultchat.privacy.notificationPreview", value ? "on" : "off");
          }}
          notificationPermission={notificationPermission}
          onRequestNotificationPermission={async () => {
            if (!("Notification" in window)) {
              setNotificationPermission("unsupported");
              return;
            }
            const permission = await Notification.requestPermission();
            setNotificationPermission(permission);
            if (permission === "granted") {
              setNotificationEnabled(true);
              localStorage.setItem("vaultchat.privacy.notifications", "on");
            }
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
          }}
        />
      )}
      <div className="app-surface flex min-h-0 w-full flex-1 overflow-visible rounded-2xl md:rounded-3xl">
      <aside
        className={`${
          showSidebar ? "flex" : "hidden"
        } sidebar-shell w-full min-w-0 flex-col border-[var(--border)] bg-[var(--bg-sidebar)] md:flex md:w-84 md:min-w-[20rem] md:border-r`}
      >
        <div className="sidebar-header flex items-center justify-between !py-3.5">
          <div className="flex min-w-0 items-center gap-2">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
              <IconShield size={18} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold" style={{ color: "var(--text)" }}>
              VaultChat
              </p>
              <p className="text-xs app-muted">
                {pendingCount > 0 ? `${pendingCount} ausstehend` : "Secure Messenger"}
              </p>
            </div>
          </div>
          <div className="flex gap-1.5">
            <ThemeToggle />
            <button
              type="button"
              onClick={() => setSecurityOpen(true)}
              className="btn btn-secondary btn-icon !h-9 !w-9"
              title="Sicherheitseinstellungen"
              aria-label="Sicherheitseinstellungen"
            >
              <IconSettings size={15} />
            </button>
            <button
              type="button"
              onClick={onLock}
              className="btn btn-secondary !px-2.5 !py-1.5 !text-xs"
              title="Sofort sperren (LDK aus dem Speicher entfernen)"
            >
              <IconLock size={14} />
              <span className="sidebar-lock-label">Sperren</span>
            </button>
          </div>
        </div>

        <div className="sidebar-security-strip mx-3 mt-3">
          <span className={connected ? "online" : "offline"} />
          <div className="min-w-0">
            <p>{connected ? "Realtime verbunden" : "Verbindung wird aufgebaut"}</p>
            <small>{relayOnly ? "Relay-only aktiv" : "E2E aktiv, Relay optional"}</small>
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
            />
          </div>
        </div>

        <div className="filter-chips mx-3 mt-3">
          {[
            ["all", "Alle"],
            ["dm", "DMs"],
            ["group", "Gruppen"],
            ["fav", "Favorit"],
            ["unread", "Neu"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`filter-chip ${sidebarFilter === value ? "active" : ""}`}
              aria-label={`Filter: ${label}`}
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
        </div>

        {(sidebarFilter === "all" || sidebarFilter === "dm" || sidebarFilter === "unread") && (
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
                className="btn btn-primary btn-icon !h-8 !w-8 !text-base"
                title="Kontakt hinzufügen"
              >
                +
              </button>
            </div>
            <div
              className={`overflow-y-auto p-2 ${
                sidebarFilter === "all" ? "max-h-[42%]" : "flex-1"
              }`}
            >
              {peerList.length > 0 ? (
                peerList
              ) : (
                <SidebarEmptyState
                  title={query.trim() ? "Keine Kontakte gefunden" : "Noch keine Kontakte"}
                  body={
                    query.trim()
                      ? "Passe die Suche an oder fuege einen neuen Kontakt hinzu."
                      : "Fuege deinen ersten Kontakt hinzu, um eine verschluesselte Unterhaltung zu starten."
                  }
                  action={
                    <button
                      type="button"
                      onClick={() => setShowAddContact(true)}
                      className="btn btn-secondary !mt-3 !px-3 !py-2 !text-xs"
                    >
                      Kontakt hinzufuegen
                    </button>
                  }
                />
              )}
            </div>
          </>
        )}

        {sidebarFilter === "fav" && (
          <div className="flex-1 overflow-y-auto p-2">
            {peerList.length > 0 ? (
              peerList
            ) : (
              <SidebarEmptyState
                title="Keine Favoriten"
                body="Markiere wichtige Kontakte als Favorit, damit sie hier erscheinen."
              />
            )}
          </div>
        )}

        {sidebarFilter === "group" && (
          <>
            <div className="space-y-2 border-b p-3" style={{ borderColor: 'var(--border)' }}>
              <div className="group-create-header">
                <p>Neue private Gruppe</p>
                <span>Key-Rotation bei jeder Aenderung</span>
              </div>
              <input
                className="app-input w-full !py-2 text-sm"
                placeholder="Gruppenname"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
              />
              <select
                multiple
                className="app-input h-24 !py-1 text-xs"
                value={newGroupMembers}
                disabled={!hasContacts}
                aria-label="Gruppenmitglieder aus Kontakten auswaehlen"
                onChange={(e) => {
                  const o = [...e.target.selectedOptions].map((x) => x.value);
                  setNewGroupMembers(o);
                }}
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.username}
                  </option>
                ))}
              </select>
              {!hasContacts && (
                <p className="sidebar-form-hint">
                  Fuege zuerst Kontakte hinzu. Gruppen koennen nur mit verifizierten Kontakten erstellt werden.
                </p>
              )}
              {hasContacts && !canCreateGroup && (
                <p className="sidebar-form-hint">
                  Name und mindestens ein Kontakt sind erforderlich.
                </p>
              )}
              <button
                type="button"
                onClick={() => void createGroup()}
                disabled={!canCreateGroup}
                className="btn btn-primary w-full"
              >
                Gruppe erstellen
              </button>
            </div>
          </>
        )}

        {(sidebarFilter === "all" || sidebarFilter === "group") && (
          <div className="flex-1 overflow-y-auto p-2">
            {sidebarFilter === "all" && visibleGroups.length > 0 && (
              <p className="px-2 pb-1 pt-2 text-[11px] font-semibold" style={{ color: "var(--text-muted)" }}>
                Gruppen
              </p>
            )}
            {groupList.length > 0 ? (
              groupList
            ) : sidebarFilter === "group" ? (
              <SidebarEmptyState
                title={query.trim() ? "Keine Gruppen gefunden" : "Noch keine Gruppen"}
                body={
                  query.trim()
                    ? "Passe die Suche an oder erstelle eine neue private Gruppe."
                    : "Erstelle eine Gruppe, sobald du mindestens einen Kontakt hinzugefuegt hast."
                }
              />
            ) : null}
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
            onClick={() => setSecurityOpen(true)}
            className="sidebar-footer-action"
            title="Einstellungen"
            aria-label="Einstellungen oeffnen"
          >
            <IconSettings size={16} />
          </button>
          <button
            type="button"
            onClick={() => setUserMenuOpen((v) => !v)}
            className="sidebar-footer-action"
            title="Mehr"
            aria-label="Profilmenue oeffnen"
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
          <ChatEmptyState />
        )}

        {tab === "dm" && peer && (
          <>
            <header className="chat-header !h-auto min-h-14 !px-3 !py-3 md:!px-4">
              <div className="absolute top-0 left-0 right-0 h-0.5 overflow-hidden rounded-t-2xl">
                <div className={`h-full transition-all duration-500 ${connected ? 'bg-emerald-500 w-full' : 'bg-amber-500 w-1/2 animate-pulse'}`} />
              </div>
              <div className="flex w-full items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-3">
                  {isMobile && (
                    <button
                      type="button"
                      onClick={() => setPeer(null)}
                      className="btn btn-secondary !px-2.5 !py-1.5 !text-xs"
                      title="Zurück"
                    >
                      ←
                    </button>
                  )}
                  <div className="relative">
                    <div
                      className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-semibold text-white shadow-md"
                      style={{
                        background: peer
                          ? userGradient(peer.id)
                          : "linear-gradient(135deg, var(--accent-hover), var(--accent))",
                      }}
                    >
                      {peer.username.slice(0, 1).toUpperCase()}
                    </div>
                    {/* Online indicator dot */}
                    <div className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[var(--bg)] ${onlinePeers.has(peer.id) ? 'bg-emerald-500' : 'bg-zinc-400'}`} />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-base" style={{ color: "var(--text)" }}>
                      {peer.username}
                    </p>
                    {typing ? (
                      <p className="text-xs text-emerald-500/80 flex items-center gap-1">
                        <span className="flex gap-0.5">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-bounce" style={{animationDelay: '0ms'}} />
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-bounce" style={{animationDelay: '150ms'}} />
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-bounce" style={{animationDelay: '300ms'}} />
                        </span>
                        schreibt...
                      </p>
                    ) : (
                      <p className="flex items-center gap-1.5 text-xs" style={{ color: connected ? "var(--success)" : "var(--text-muted)" }}>
                        <span className="h-2 w-2 rounded-full" style={{ background: connected ? "var(--success)" : "var(--text-muted)" }} />
                        {connected ? "Online" : "Zuletzt gesehen vor kurzem"}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void beginCall()}
                    className="btn btn-secondary btn-icon !h-9 !w-9"
                    title="Anrufen"
                  >
                    <IconPhone size={18} />
                  </button>
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
                const file = e.dataTransfer.files?.[0];
                if (file && peer) void sendDmFile(file);
              }}
            >
              {dragOver && (
                <div className="absolute inset-0 z-50 flex items-center justify-center rounded-lg bg-emerald-500/20 backdrop-blur-sm border-2 border-dashed border-emerald-400 m-2">
                  <div className="text-center">
                    <p className="text-2xl mb-2">📎</p>
                    <p className="text-sm font-medium text-emerald-700">Datei hier ablegen</p>
                  </div>
                </div>
              )}
              {newDmMessageWaiting && (
                <button
                  type="button"
                  onClick={() => {
                    dmScrollRef.current?.scrollTo({ top: dmScrollRef.current.scrollHeight, behavior: "smooth" });
                    setNewDmMessageWaiting(false);
                  }}
                  className="absolute bottom-4 right-4 z-10 rounded-full bg-emerald-600 px-4 py-2 text-sm text-white shadow-lg hover:bg-emerald-500 transition-all"
                >
                  ↓ Neue Nachrichten
                </button>
              )}
              {messages.length === 0 && (
                <div className="chat-inline-empty">
                  <IconShieldCheck size={24} />
                  <p>Schreibe die erste verschluesselte Nachricht.</p>
                  <span>Nur deine Geraete und dieser Kontakt koennen den Inhalt lesen.</span>
                </div>
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
                    onCopy={copyText}
                  />
                );
                return items;
              })}
              {typing && (
                <p className="text-xs italic text-zinc-500">
                  {peer.username} schreibt…
                </p>
              )}
            </div>

            <footer className="chat-input-area !flex-wrap !pb-[calc(env(safe-area-inset-bottom,0px)+12px)] !pt-3">
              {error && <ComposerNotice message={error} onDismiss={() => setError(null)} />}
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
              <div className="relative flex items-end gap-2">
                <button
                  type="button"
                  onClick={() => setEmojiOpen((v) => !v)}
                  className="chat-tool-button"
                  style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
                  title="Emoji"
                >
                  <IconSmile size={18} />
                </button>
                {emojiOpen && (
                  <div className="absolute bottom-[62px] left-3 z-20 rounded-2xl border p-2 text-lg shadow-xl backdrop-blur" style={{ borderColor: "var(--border)", background: "var(--bg-glass)" }}>
                    {EMOJI_CHOICES.map((e) => (
                      <button
                        key={e}
                        type="button"
                        className="rounded px-1.5 py-1 transition hover:bg-[var(--bg-hover)]"
                        title={`Emoji ${e} einfügen`}
                        onClick={() => {
                          setText((current) => {
                            const next = current ? `${current}${e}` : e;
                            window.requestAnimationFrame(() => {
                              resizeTextarea(dmInputRef.current);
                              dmInputRef.current?.focus();
                            });
                            return next;
                          });
                          setEmojiOpen(false);
                        }}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                )}
                <label
                  className="chat-tool-button cursor-pointer"
                  style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
                  title="Datei anhängen"
                >
                  <IconPaperclip size={18} />
                  <input
                    type="file"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void sendDmFile(f);
                      e.target.value = "";
                    }}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void sendDmVoice()}
                  className={`chat-tool-button ${
                    voice.recording
                      ? "border-red-500 bg-red-700/60 text-white"
                      : ""
                  }`}
                  style={voice.recording ? {} : { borderColor: "var(--border)", color: "var(--text-secondary)" }}
                >
                  {voice.recording ? "■" : <IconMic size={18} />}
                </button>
                <textarea
                  ref={dmInputRef}
                  className="chat-input-textarea"
                  placeholder={
                    voice.recording ? "Aufnahme läuft…" : "Nachricht…"
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
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void sendDmText();
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => void sendDmText()}
                  disabled={voice.recording || !text.trim()}
                  className="btn-send"
                >
                  <IconSend size={16} />
                </button>
              </div>
            </footer>
          </>
        )}

        {tab === "group" && !group && (
          <ChatEmptyState />
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
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-semibold text-white shadow" style={{ background: "linear-gradient(135deg, var(--accent-hover), var(--accent))" }}>
                    {group.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div>
                  <p className="font-medium" style={{ color: "var(--text)" }}>{group.name}</p>
                  <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                    Ende-zu-Ende verschluesselt · {group.memberIds.length} Mitglieder
                  </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setGroupVoiceOpen((v) => !v)}
                    className={`btn btn-secondary btn-icon !h-9 !w-9 ${groupVoiceOpen ? "!border-[var(--accent)] !bg-[var(--accent-soft)] !text-[var(--accent)]" : ""}`}
                    title="Voice-Lounge"
                  >
                    <IconPhone size={18} />
                  </button>
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

              {groupVoiceOpen && (
                <div className="group-voice-panel">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
                        Voice-Lounge
                      </p>
                      <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
                        Relay-Only schützt IP-Adressen. Mehrpersonen-Voice wird als sichere Mesh/SFU-Stufe vorbereitet.
                      </p>
                    </div>
                    <span className="group-voice-badge">
                      {relayOnly ? "Relay aktiv" : "Direkt/Relay"}
                    </span>
                  </div>
                  <div className="chat-context-badges">
                    <span>IP-Schutz</span>
                    <span>E2E Signaling</span>
                    <span>Private Member List</span>
                  </div>
                  <div className="group-voice-members">
                    {group.memberIds
                      .filter((mid) => mid !== session.user.id)
                      .map((mid) => {
                        const u = users.find((x) => x.id === mid);
                        const label = u?.username ?? mid.slice(0, 8);
                        return (
                          <div key={mid} className="group-voice-member">
                            <div className="flex min-w-0 items-center gap-2">
                              <div
                                className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold text-white"
                                style={{ background: userGradient(mid) }}
                              >
                                {label.slice(0, 1).toUpperCase()}
                              </div>
                              <div className="min-w-0">
                                <p className="truncate text-xs font-semibold" style={{ color: "var(--text)" }}>
                                  {label}
                                </p>
                                <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                                  {onlinePeers.has(mid) ? "Online" : "Nicht verbunden"}
                                </p>
                              </div>
                            </div>
                            <button
                              type="button"
                              className="btn btn-primary !px-2 !py-1 !text-[11px]"
                              disabled={!u || callStatus === "connecting" || callStatus === "connected"}
                              onClick={() => u && void beginCallWith(u)}
                            >
                              Anrufen
                            </button>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}

              {groupPanelOpen && (
                <div className="mt-3 rounded-xl border p-3 text-xs" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)", color: "var(--text)" }}>
                  <ul className="mb-2 space-y-1">
                    {group.memberIds.map((mid) => {
                      const u = users.find((x) => x.id === mid);
                      const label = u?.username ?? (mid === session.user.id ? "Du" : mid.slice(0, 8));
                      return (
                        <li
                          key={mid}
                          className="flex items-center justify-between rounded px-2 py-1"
                          style={{ background: "var(--bg-hover)" }}
                        >
                          <span>{label}</span>
                          {mid !== session.user.id && (
                            <button
                              type="button"
                              onClick={() => void removeMember(mid)}
                              className="btn btn-danger !px-2 !py-0.5 !text-[10px]"
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
              className="messages-container !px-4 !py-4 relative"
            >
              {newGroupMessageWaiting && (
                <button
                  type="button"
                  onClick={() => {
                    groupScrollRef.current?.scrollTo({ top: groupScrollRef.current.scrollHeight, behavior: "smooth" });
                    setNewGroupMessageWaiting(false);
                  }}
                  className="absolute bottom-4 right-4 z-10 rounded-full bg-emerald-600 px-4 py-2 text-sm text-white shadow-lg hover:bg-emerald-500 transition-all"
                >
                  ↓ Neue Nachrichten
                </button>
              )}
              {groupMessages.length === 0 && (
                <div className="chat-inline-empty">
                  <IconUsers size={24} />
                  <p>Diese Gruppe ist bereit.</p>
                  <span>Nachrichten, Dateien und Sprachnachrichten werden Ende-zu-Ende verschluesselt.</span>
                </div>
              )}
              {groupMessages.flatMap((m, i) => {
                const author =
                  users.find((u) => u.id === m.fromUserId)?.username ??
                  (m.fromMe ? "Du" : "Mitglied");
                const previous = groupMessages[i - 1];
                const next = groupMessages[i + 1];
                const items: JSX.Element[] = [];
                if (
                  i === 0 ||
                  new Date(m.at).toDateString() !== new Date(previous.at).toDateString()
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
                    peerLabel={author}
                    replyToPreview={replyPreviewForMessage(groupMessages, m, author)}
                    isGrouped={
                      i > 0 &&
                      previous.fromMe === m.fromMe &&
                      previous.fromUserId === m.fromUserId
                    }
                    isLastInGroup={
                      i === groupMessages.length - 1 ||
                      next.fromMe !== m.fromMe ||
                      next.fromUserId !== m.fromUserId
                    }
                    onReply={(x) =>
                      setReplyGroup({
                        cid: x.plain.cid ?? "",
                        author: x.fromMe ? "Du" : author,
                        text: previewForPayload(x.plain),
                        expiresAt: x.expiresAt,
                      })
                    }
                    onReact={(x, e) => void reactGroup(x, e)}
                    onEdit={(x, body) => void editGroup(x, body)}
                    onDelete={(x) => void deleteGroup(x)}
                    onCopy={copyText}
                  />
                );
                return items;
              })}
            </div>
            <footer className="chat-input-area !flex-wrap !pb-[calc(env(safe-area-inset-bottom,0px)+12px)] !pt-3">
              {error && <ComposerNotice message={error} onDismiss={() => setError(null)} />}
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
              <div className="relative flex items-end gap-2">
                <button
                  type="button"
                  onClick={() => setEmojiOpen((v) => !v)}
                  className="chat-tool-button"
                  style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
                  title="Emoji"
                >
                  <IconSmile size={18} />
                </button>
                {emojiOpen && (
                  <div className="absolute bottom-[62px] left-3 z-20 rounded-2xl border p-2 text-lg shadow-xl backdrop-blur" style={{ borderColor: "var(--border)", background: "var(--bg-glass)" }}>
                    {EMOJI_CHOICES.map((e) => (
                      <button
                        key={e}
                        type="button"
                        className="rounded px-1.5 py-1 transition hover:bg-[var(--bg-hover)]"
                        title={`Emoji ${e} einfuegen`}
                        onClick={() => {
                          setGroupText((current) => {
                            const nextText = current ? `${current}${e}` : e;
                            window.requestAnimationFrame(() => {
                              resizeTextarea(groupInputRef.current);
                              groupInputRef.current?.focus();
                            });
                            return nextText;
                          });
                          setEmojiOpen(false);
                        }}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                )}
                <label
                  className="chat-tool-button cursor-pointer"
                  style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
                  title="Datei an Gruppe senden"
                >
                  <IconPaperclip size={18} />
                  <input
                    type="file"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void sendGroupFile(f);
                      e.target.value = "";
                    }}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void sendGroupVoice()}
                  className={`chat-tool-button ${
                    voice.recording
                      ? "border-red-500 bg-red-700/60 text-white"
                      : ""
                  }`}
                  style={voice.recording ? {} : { borderColor: "var(--border)", color: "var(--text-secondary)" }}
                  title={voice.recording ? "Aufnahme stoppen und senden" : "Sprachnachricht aufnehmen"}
                >
                  {voice.recording ? "■" : <IconMic size={18} />}
                </button>
                <textarea
                  ref={groupInputRef}
                  className="chat-input-textarea"
                  placeholder="Gruppennachricht…"
                  value={groupText}
                  rows={1}
                  onChange={(e) => {
                    setGroupText(e.target.value);
                    resizeTextarea(e.currentTarget);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void sendGroupText();
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => void sendGroupText()}
                  disabled={voice.recording || !groupText.trim()}
                  className="btn-send"
                >
                  <IconSend size={16} />
                </button>
              </div>
            </footer>
          </>
        )}
      </main>

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
              style={tab === "dm" ? { background: "linear-gradient(135deg, var(--accent-hover), var(--accent))", color: "white" } : { border: "1px solid var(--border)", color: "var(--text-secondary)" }}
              aria-label="Mobile Ansicht: Direktnachrichten"
            >
              Direkt
            </button>
            <button
              type="button"
              onClick={() => setTab("group")}
              className="flex-1 rounded-xl px-3 py-2 text-sm font-medium transition"
              style={tab === "group" ? { background: "linear-gradient(135deg, var(--accent-hover), var(--accent))", color: "white" } : { border: "1px solid var(--border)", color: "var(--text-secondary)" }}
              aria-label="Mobile Ansicht: Gruppen"
            >
              Gruppen
            </button>
          </div>
        </div>
      )}
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
  selected,
  onSelect,
}: {
  u: api.ApiUser;
  subtitle?: string;
  metaRight?: string;
  unread?: number;
  isFavorite?: boolean;
  isBlocked?: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const [pin, setPin] = useState<PeerPin | null>(null);
  useEffect(() => {
    void getPin(u.id).then(setPin);
  }, [u.id, u.publicKey]);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`contact-item w-full ${
        selected ? "active" : ""
      } !mx-0 items-center justify-between`}
    >
      <div
        className="contact-avatar !h-9 !w-9 !text-sm"
        style={{ background: userGradient(u.id) }}
      >
        {u.username.slice(0, 1).toUpperCase()}
      </div>
      <div className="contact-info min-w-0">
        <div className="flex items-center gap-2">
          <span className="contact-name">{u.username}</span>
            {isFavorite && (
              <span className="rounded-md border px-1.5 py-0.5 text-[10px]" style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>
                ★
              </span>
            )}
            {isBlocked && (
              <span className="rounded-md border border-amber-700/70 bg-amber-950/30 px-1.5 py-0.5 text-[10px] text-amber-200">
                blockiert
              </span>
            )}
            {pin?.state === "mismatch" && (
              <span className="rounded-md border border-red-700/70 bg-red-950/30 px-1.5 py-0.5 text-[10px] text-red-200">
                ⚠
              </span>
            )}
            {pin?.state === "verified" && (
              <span
                className="rounded-md border px-1.5 py-0.5 text-[10px]"
                style={{
                  borderColor: "var(--accent)",
                  color: "var(--accent)",
                  background: "var(--accent-soft)",
                }}
              >
                ✓
              </span>
            )}
        </div>
        <p className="contact-preview">{subtitle ?? ""}</p>
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
  );
}

function ComposerNotice({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div className="composer-notice" role="status">
      <IconAlertTriangle size={16} />
      <span>{message}</span>
      <button type="button" onClick={onDismiss} title="Hinweis schliessen">
        ×
      </button>
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
  isFavorite: boolean;
  onToggleFavorite: () => void;
  isBlocked: boolean;
  onToggleBlocked: () => void;
  sharedMediaItems: SharedMediaItem[];
}) {
  const title = mode === "dm" ? peer?.username ?? "Kontakt" : group?.name ?? "Gruppe";
  const initials = (title.slice(0, 1) || "•").toUpperCase();
  const status = mode === "dm" ? "Online" : `${group?.memberIds.length ?? 0} Mitglieder`;
  const isMuted = peer ? mutedPeers.has(peer.id) : false;
  const groupedSafetyNumber = peerFp
    ? peerFp.replace(/\s+/g, "").match(/.{1,4}/g)?.join(" ") ?? peerFp
    : "…";

  const toggleMute = () => {
    if (!peer) return;
    setMutedPeers((prev) => {
      const next = new Set(prev);
      if (next.has(peer.id)) {
        next.delete(peer.id);
      } else {
        next.add(peer.id);
      }
      return next;
    });
  };

  return (
    <div className="info-panel">
      {/* Profile Avatar */}
      <div className="flex flex-col items-center">
        <div className="relative">
          <div className="info-avatar-large">
            {initials}
          </div>
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
            {isMuted ? "Stumm" : "Aktiv"}
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
