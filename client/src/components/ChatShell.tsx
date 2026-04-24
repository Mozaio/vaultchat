import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "../lib/sessionHelpers";
import * as api from "../lib/api";
import { decryptIncomingSealedDm } from "../lib/incomingDm";
import { drEncryptJson, ensureDrSession } from "../lib/drSession";
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
  loadKeyMaterial,
  saveKeyMaterial,
  toUploadBody,
} from "../lib/keyStore";
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
import {
  IconInfo,
  IconMic,
  IconMore,
  IconPaperclip,
  IconPhone,
  IconSearch,
  IconSend,
} from "./Icons";

type Tab = "dm" | "group";

type ReplyTarget = { cid: string; author: string; text: string } | null;

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
  const [replyDm, setReplyDm] = useState<ReplyTarget>(null);
  // Contact add modal
  const [showAddContact, setShowAddContact] = useState(false);
  // Notification settings per chat
  const [mutedPeers, setMutedPeers] = useState<Set<string>>(new Set());
  const [mutedGroups, setMutedGroups] = useState<Set<string>>(new Set());
  // Online status tracking
  const [onlinePeers, setOnlinePeers] = useState<Set<string>>(new Set());
  const [replyGroup, setReplyGroup] = useState<ReplyTarget>(null);
  const [ttlDm, setTtlDm] = useState<number>(0);
  const [ttlGroup, setTtlGroup] = useState<number>(0);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [peerPin, setPeerPin] = useState<PeerPin | null>(null);
  const [relayOnly, setRelayOnly] = useState(false);
  const [addMemberId, setAddMemberId] = useState<string>("");
  const [groupPanelOpen, setGroupPanelOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [isMobile, setIsMobile] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sideTab, setSideTab] = useState<"direct" | "groups" | "fav">("direct");
  const [unreadByPeer, setUnreadByPeer] = useState<Record<string, number>>({});
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [newDmMessageWaiting, setNewDmMessageWaiting] = useState(false);
  const [newGroupMessageWaiting, setNewGroupMessageWaiting] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const callRef = useRef<{
    close: () => void;
    handleRemote?: (p: RtcPayload) => void | Promise<void>;
    addIce?: (c: RTCIceCandidateInit) => void | Promise<void>;
  } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const peerRef = useRef<api.ApiUser | null>(null);
  const groupRef = useRef<api.ApiGroup | null>(null);
  const usersRef = useRef<api.ApiUser[]>([]);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seen = useRef(new Set<string>());
  const dmScrollRef = useRef<HTMLDivElement | null>(null);
  const groupScrollRef = useRef<HTMLDivElement | null>(null);
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
  tokenRef.current = session.token;

  useShortcuts({
    onSearch: () => setSearchOpen(true),
    onEscape: () => {
      setSearchOpen(false);
      setEmojiOpen(false);
      setSafetyOpen(false);
      setInfoOpen(false);
      setGroupPanelOpen(false);
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

  const showConversation = tab === "dm" ? Boolean(peer) : Boolean(group);
  const showSidebar = !isMobile || !showConversation;
  const showInfo = !isMobile && showConversation;

  const resolveUser = useCallback(
    async (userId: string): Promise<api.ApiUser | null> => {
      const local = usersRef.current.find((u) => u.id === userId);
      if (local) return local;
      try {
        const { users: list } = await api.listUsers(session.token);
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
      const { users: list } = await api.listUsers(session.token);
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
    const { users: list } = await api.listUsers(session.token);
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

  /** Pre-Key-Bundle auf den Server hochladen (X3DH-API, kompatibel mit eurer Konto-Identität). */
  useEffect(() => {
    void (async () => {
      try {
        let km = await loadKeyMaterial();
        if (!km) {
          km = await generateKeyMaterial(session.secretKey);
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
      await ensureDrSession(session.secretKey, peer.id, peer.publicKey);
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
  useEffect(() => {
    const el = dmScrollRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (isAtBottom) {
      el.scrollTop = el.scrollHeight;
    } else {
      // Zeige einen "neue Nachricht" Button
      setNewDmMessageWaiting(true);
    }
  }, [messages]);

  // Auto-scroll für Gruppen
  useEffect(() => {
    const el = groupScrollRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (isAtBottom) {
      el.scrollTop = el.scrollHeight;
    } else {
      setNewGroupMessageWaiting(true);
    }
  }, [groupMessages]);

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
      const inner = await drEncryptJson(
        session.secretKey,
        toUser.id,
        toUser.publicKey,
        JSON.stringify(payload)
      );
      const envelope = await sealSender(
        session.user.id,
        inner,
        toUser.publicKey
      );
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
      return tmpId;
    },
    [session.secretKey, session.user.id, rebuildDm, refreshPendingCount]
  );

  const sendGroupWire = useCallback(
    async (g: api.ApiGroup, payload: PlainPayload, suppressLocal = false) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        setError("Keine Verbindung.");
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
    const url = getWsUrl(session.token);
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
      void flushOutbox();

      // Starte Cover Traffic (Dummy-Envelopes bei Inaktivität)
      const peerList = usersRef.current.map((u) => ({
        id: u.id,
        publicKey: u.publicKey,
      }));
      if (peerList.length > 0) {
        coverRef.current = startCoverTraffic(ws, peerList, () => {
          return ws.readyState === WebSocket.OPEN && session !== null;
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
        const url = getWsUrl(tokenRef.current);
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
              return;
            }
            if (callRef.current?.handleRemote) {
              await callRef.current.handleRemote(payload);
            }
            if (payload.type === "candidate" && callRef.current?.addIce) {
              await callRef.current.addIce(payload.candidate);
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
            seen.current.add(id);
            const peerUser = usersRef.current.find(
              (u) => u.id === dec.senderUserId
            );
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

            if (plain.kind !== "receipt" && plain.cid) {
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
    };
  }, [
    session,
    loadGroups,
    sendDmWire,
    rebuildDm,
    rebuildGroup,
    resolveUser,
    flushOutbox,
    refreshPendingCount,
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
            replyPreview: `${replyDm.author}: ${replyDm.text}`,
          }
        : {}),
      ...(ttlDm ? { ttlMs: ttlDm } : {}),
    };
    await sendDmWire(peer, payload);
    setText("");
    setReplyDm(null);
  }

  async function sendDmFile(file: File) {
    if (!peer) return;
    /** Server: 128 MB verschlüsselter Umschlag; Data-URL + DR + Seal wachsen ~1,4–1,5×. */
    const e2eMaxB64 = 128 * 1024 * 1024;
    const maxFile = Math.floor(e2eMaxB64 / 1.5);
    if (file.size > maxFile) {
      setError(
        `Datei zu groß: Der E2E-Server-Rahmen beträgt 128 MB (Umschlag). Wegen Data-URL und Verschlüsselung bitte Dateien bis etwa ${Math.floor(maxFile / (1024 * 1024))} MB.`
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
            replyPreview: `${replyGroup.author}: ${replyGroup.text}`,
          }
        : {}),
      ...(ttlGroup ? { ttlMs: ttlGroup } : {}),
    };
    await sendGroupWire(group, payload);
    setGroupText("");
    setReplyGroup(null);
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
    await sendGroupWire(group, payload);
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
    const { group: g } = await api.createGroup(session.token, {
      name: newGroupName.trim(),
      memberIds,
    });
    const key = await randomGroupKey();
    await setGroupKey(g.id, key);
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

  async function beginCall() {
    if (!peer) return;
    const ctrl = await startCall(
      peer,
      tokenRef.current,
      relayOnly,
      sendRtc,
      (s) => setCallRemote(s),
      () => {
        setCallRemote(null);
        callRef.current = null;
      }
    );
    callRef.current = ctrl;
  }

  async function acceptIncoming() {
    if (!incomingOffer) return;
    const ctrl = await acceptCall(
      incomingOffer.from,
      incomingOffer.sdp,
      tokenRef.current,
      relayOnly,
      sendRtc,
      (s) => setCallRemote(s),
      () => {
        setCallRemote(null);
        callRef.current = null;
      }
    );
    callRef.current = {
      ...ctrl,
      handleRemote: undefined,
      addIce: ctrl.addIce,
    };
    setIncomingOffer(null);
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

  const filteredUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => u.username.toLowerCase().includes(q));
  }, [users, query]);

  const peerList = useMemo(() => {
    return filteredUsers.map((u) => {
      const prev = lastDmPreviewByPeer.get(u.id);
      return (
        <PeerRow
          key={u.id}
          u={u}
          subtitle={prev?.text ?? "Keine Nachrichten"}
          metaRight={fmtListTime(prev?.at)}
          unread={unreadByPeer[u.id] ?? 0}
          selected={peer?.id === u.id && tab === "dm"}
          onSelect={() => {
            setTab("dm");
            setPeer(u);
          }}
        />
      );
    });
  }, [filteredUsers, peer, tab, lastDmPreviewByPeer, unreadByPeer]);

  const groupList = useMemo(
    () =>
      groups.map((g) => (
        <button
          key={g.id}
          type="button"
          onClick={() => {
            setTab("group");
            setGroup(g);
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
            <p className="contact-preview">{g.memberIds.length} Mitglieder</p>
          </div>
        </button>
      )),
    [groups, group, tab]
  );

  return (
    <div className="flex h-full w-full flex-col bg-[var(--bg)] p-2 md:p-4">
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
        <SecuritySettings onClose={() => setSecurityOpen(false)} />
      )}
      <div className="app-surface flex min-h-0 w-full flex-1 overflow-hidden rounded-2xl md:rounded-3xl">
      <aside
        className={`${
          showSidebar ? "flex" : "hidden"
        } w-full min-w-0 flex-col border-[var(--border)] bg-[var(--bg-sidebar)] md:flex md:w-84 md:min-w-[20rem] md:border-r`}
      >
        <div className="sidebar-header flex items-center justify-between !py-3.5">
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
              VaultChat
            </p>
            <p className="text-xs app-muted">Secure Messenger</p>
          </div>
          <div className="flex gap-1.5">
            <ThemeToggle />
            <button
              type="button"
              onClick={onLock}
              className="btn btn-secondary !px-2.5 !py-1.5 !text-xs"
              title="Sofort sperren (LDK aus dem Speicher entfernen)"
            >
              Sperren
            </button>
            <button
              type="button"
              onClick={() => setSecurityOpen(true)}
              className="btn btn-secondary !px-2.5 !py-1.5 !text-xs"
              title="Sicherheitseinstellungen"
            >
              🔒
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="btn btn-secondary !px-2.5 !py-1.5 !text-xs"
            >
              Abmelden
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
            />
          </div>
        </div>

        <div className="tab-group !mx-3 !mt-2 !mb-1">
          <button
            type="button"
            className={`tab ${sideTab === "direct" ? "active" : ""}`}
            onClick={() => {
              setSideTab("direct");
              setTab("dm");
            }}
          >
            Direkt
          </button>
          <button
            type="button"
            className={`tab ${sideTab === "groups" ? "active" : ""}`}
            onClick={() => {
              setSideTab("groups");
              setTab("group");
            }}
          >
            Gruppen
          </button>
          <button
            type="button"
            className={`tab ${sideTab === "fav" ? "active" : ""}`}
            onClick={() => setSideTab("fav")}
            title="Favoriten (coming soon)"
          >
            Favoriten
          </button>
        </div>

        {tab === "dm" && (
          <>
            <div className="flex items-center justify-between border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
              <p
                className="text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: "var(--text-muted)" }}
              >
                Kontakte
              </p>
              <button
                type="button"
                onClick={() => setShowAddContact(true)}
                className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-500 transition"
                title="Kontakt hinzufügen"
              >
                +
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2">{peerList}</div>
          </>
        )}

        {tab === "group" && (
          <>
            <div className="space-y-2 border-b p-3" style={{ borderColor: 'var(--border)' }}>
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
              <button
                type="button"
                onClick={() => void createGroup()}
                className="btn btn-primary w-full"
              >
                Gruppe erstellen
              </button>
            </div>
            <div className="border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
              <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Deine Gruppen
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-2">{groupList}</div>
          </>
        )}

        <div
          className="space-y-1.5 border-t p-3 text-xs"
          style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
        >
          <p className="font-mono text-[10px] leading-snug" style={{ color: "var(--accent)" }}>
            Du: {myFp ?? "…"}
          </p>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={relayOnly}
              onChange={(e) => setRelayOnly(e.target.checked)}
            />
            <span>Anruf nur über TURN (Relay)</span>
          </label>
          <button
            type="button"
            className="text-left font-medium hover:underline"
            style={{ color: "var(--accent)" }}
            onClick={() => {
              void loadContacts();
              void loadGroups();
            }}
          >
            Kontakte & Gruppen aktualisieren
          </button>
        </div>
      </aside>

      <main
        className={`${
          showSidebar ? "hidden" : "flex"
        } min-h-0 min-w-0 flex-1 flex-col border-[var(--border)] bg-[var(--bg-chat)] md:flex md:border-0 overflow-hidden`}
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
                onClick={() => setIncomingOffer(null)}
              >
                Ablehnen
              </button>
            </div>
          </div>
        )}

        {callRemote && (
          <div className="border-b border-zinc-800 bg-black/40 p-2">
            <p className="text-xs text-zinc-400">Remote-Video</p>
            <video
              className="max-h-48 w-full rounded-lg"
              autoPlay
              playsInline
              ref={(el) => {
                if (el) el.srcObject = callRemote;
              }}
            />
          </div>
        )}

        {tab === "dm" && !peer && (
          <div className="flex flex-1 items-center justify-center px-6 text-center app-muted">
            <div className="max-w-sm">
              <p className="text-sm font-medium" style={{ color: "var(--text)" }}>
                Wähle eine Unterhaltung
              </p>
              <p className="mt-1 text-xs">Verlauf nur auf diesem Gerät, verschlüsselt (IndexedDB).</p>
            </div>
          </div>
        )}

        {tab === "dm" && peer && (
          <>
            <header className="chat-header !h-auto min-h-14 !px-3 !py-3 md:!px-4">
              {/* Connection status indicator */}
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
                    <div className="flex items-center gap-2">
                      <p className="truncate font-semibold text-base" style={{ color: "var(--text)" }}>
                        {peer.username}
                      </p>
                      {/* Connection status badge */}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${connected ? 'bg-emerald-500/20 text-emerald-500' : 'bg-amber-500/20 text-amber-500'}`}>
                        {connected ? 'Online' : 'Verbinden...'}
                      </span>
                    </div>
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
                      <p
                        className="max-w-[min(100%,14rem)] break-all font-mono text-[10px] leading-snug opacity-60 sm:max-w-md sm:text-[11px]"
                        style={{ color: "var(--accent)" }}
                      >
                        {peerFp ? `${peerFp.slice(0, 32)}...` : "Verschlüsselt"}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setInfoOpen((v) => !v)}
                    className="btn btn-secondary !px-2.5 !py-1.5 !text-xs md:hidden"
                    title="Details"
                  >
                    <IconMore size={16} />
                  </button>
                  <select
                    value={ttlDm}
                    onChange={(e) => void onChangeTtlDm(Number(e.target.value))}
                    className="app-input !py-1.5 !text-xs !w-auto"
                    title="Verschwindende Nachrichten"
                  >
                    {TTL_OPTIONS.map((o) => (
                      <option key={o.ms} value={o.ms}>
                        ⏳ {o.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setSafetyOpen(true)}
                    className={`btn btn-secondary !px-2.5 !py-1.5 !text-xs ${
                      peerPin?.state === "verified"
                        ? "!border-emerald-600 !text-emerald-500"
                        : peerPin?.state === "mismatch"
                          ? "!border-red-500 !text-red-500"
                          : ""
                    }`}
                  >
                    {peerPin?.state === "verified" && "✓ Verifiziert"}
                    {peerPin?.state === "mismatch" && "⚠ Schlüssel geändert"}
                    {(!peerPin || peerPin.state === "pinned") &&
                      "Sicherheitsnummer"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void beginCall()}
                    className="btn btn-secondary !px-2.5 !py-1.5 !text-xs"
                  >
                    <IconPhone size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setInfoOpen(true)}
                    className="btn btn-secondary !px-2.5 !py-1.5 !text-xs hidden md:inline-flex"
                    title="Details"
                  >
                    <IconInfo size={16} />
                  </button>
                </div>
              </div>
              {peerPin?.state === "mismatch" && (
                <div className="mt-2 rounded-lg border border-red-800/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
                  Der Identity-Key dieses Peers hat sich geändert. Nachrichten
                  werden blockiert, bis du die Sicherheitsnummer neu geprüft hast.
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
                    replyToPreview={
                      m.plain.replyPreview
                        ? {
                            author: m.plain.replyPreview.split(":")[0] ?? "",
                            text: m.plain.replyPreview
                              .split(":")
                              .slice(1)
                              .join(":")
                              .trim(),
                          }
                        : findReplyPreview(messages, m.plain.replyToCid)
                    }
                    onReply={(x) =>
                      setReplyDm({
                        cid: x.plain.cid ?? "",
                        author: x.fromMe ? "Du" : peer.username,
                        text: previewForPayload(x.plain),
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
              {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
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
              <div className="relative flex gap-2">
                <button
                  type="button"
                  onClick={() => setEmojiOpen((v) => !v)}
                  className="rounded-xl border px-3 py-2 text-xs transition hover:bg-[var(--bg-hover)]"
                  style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
                  title="Emoji"
                >
                  🙂
                </button>
                {emojiOpen && (
                  <div className="absolute bottom-[62px] left-3 z-20 rounded-2xl border p-2 text-lg shadow-xl backdrop-blur" style={{ borderColor: "var(--border)", background: "var(--bg-glass)" }}>
                    {["😀","😂","😍","👍","🔥","🎉","😮","😢","🙏","✅"].map((e) => (
                      <button
                        key={e}
                        type="button"
                        className="rounded px-1.5 py-1 transition hover:bg-[var(--bg-hover)]"
                        onClick={() => {
                          setText((t) => (t ? t + e : e));
                          setEmojiOpen(false);
                        }}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                )}
                <input
                  className="app-input flex-1 rounded-xl border border-[color:var(--border)] px-3 py-2 text-sm outline-none ring-[color:var(--shadow)]/30 transition focus:ring-2"
                  placeholder={
                    voice.recording ? "🎙️ Aufnahme läuft…" : "Nachricht…"
                  }
                  value={text}
                  disabled={voice.recording || peerPin?.state === "mismatch"}
                  onChange={(e) => {
                    setText(e.target.value);
                    const ws = wsRef.current;
                    if (ws && ws.readyState === WebSocket.OPEN && peer) {
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
                <label
                  className="cursor-pointer rounded-xl border px-3 py-2 text-xs transition hover:bg-[var(--bg-hover)]"
                  style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
                  title="Datei anhängen"
                >
                  <IconPaperclip size={16} />
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
                  className={`rounded-xl border px-3 py-2 text-xs transition ${
                    voice.recording
                      ? "border-red-500 bg-red-700/60 text-white"
                      : ""
                  }`}
                  style={voice.recording ? {} : { borderColor: "var(--border)", color: "var(--text-secondary)" }}
                >
                  {voice.recording ? "■" : <IconMic size={16} />}
                </button>
                <button
                  type="button"
                  onClick={() => void sendDmText()}
                  disabled={voice.recording || !text.trim()}
                  className="btn-send disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <IconSend size={16} />
                </button>
              </div>
            </footer>
          </>
        )}

        {tab === "group" && !group && (
          <div className="flex flex-1 items-center justify-center px-6 text-center">
            <div className="max-w-sm">
              <p className="text-sm font-medium" style={{ color: "var(--text)" }}>Wähle eine Gruppe</p>
              <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
                Oder erstelle oben links eine neue Gruppe.
              </p>
            </div>
          </div>
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
                    E2EE symmetrisch · {group.memberIds.length} Mitglieder
                  </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setInfoOpen((v) => !v)}
                    className="btn btn-secondary !px-2.5 !py-1.5 !text-xs md:hidden"
                    title="Info"
                  >
                    <IconMore size={16} />
                  </button>
                  <select
                    value={ttlGroup}
                    onChange={(e) => void onChangeTtlGroup(Number(e.target.value))}
                    className="app-input !py-1.5 !text-xs !w-auto"
                    title="Verschwindende Nachrichten"
                  >
                    {TTL_OPTIONS.map((o) => (
                      <option key={o.ms} value={o.ms}>
                        ⏳ {o.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setGroupPanelOpen((v) => !v)}
                    className="btn btn-secondary !px-2.5 !py-1.5 !text-xs"
                  >
                    Mitglieder
                  </button>
                </div>
              </div>

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
              className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-[radial-gradient(circle_at_top,rgba(16,185,129,0.06),transparent_40%)] px-4 py-4 relative"
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
              {groupMessages.map((m) => (
                <MessageBubble
                  key={m.plain.cid ?? m.id}
                  msg={m}
                  peerLabel={
                    users.find((u) => u.id === m.fromUserId)?.username ?? group.name
                  }
                  replyToPreview={
                    m.plain.replyPreview
                      ? {
                          author: m.plain.replyPreview.split(":")[0] ?? "",
                          text: m.plain.replyPreview
                            .split(":")
                            .slice(1)
                            .join(":")
                            .trim(),
                        }
                      : findReplyPreview(groupMessages, m.plain.replyToCid)
                  }
                  onReply={(x) =>
                    setReplyGroup({
                      cid: x.plain.cid ?? "",
                      author: x.fromMe ? "Du" : "Mitglied",
                      text: previewForPayload(x.plain),
                    })
                  }
                  onReact={(x, e) => void reactGroup(x, e)}
                  onEdit={(x, body) => void editGroup(x, body)}
                  onDelete={(x) => void deleteGroup(x)}
                  onCopy={copyText}
                />
              ))}
            </div>
            <footer className="chat-input-area !flex-wrap !pb-[calc(env(safe-area-inset-bottom,0px)+12px)] !pt-3">
              {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
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
              <div className="flex gap-2">
                <input
                  className="app-input flex-1 !rounded-xl px-3 py-2 text-sm"
                  placeholder="Gruppennachricht…"
                  value={groupText}
                  onChange={(e) => setGroupText(e.target.value)}
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
      {showInfo && (
        <aside className="info-panel hidden w-80 min-w-0 shrink-0 md:flex">
          <InfoPanel
            mode={tab}
            peer={peer}
            group={group}
            peerFp={peerFp}
            onSafety={() => setSafetyOpen(true)}
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
            >
              Direkt
            </button>
            <button
              type="button"
              onClick={() => setTab("group")}
              className="flex-1 rounded-xl px-3 py-2 text-sm font-medium transition"
              style={tab === "group" ? { background: "linear-gradient(135deg, var(--accent-hover), var(--accent))", color: "white" } : { border: "1px solid var(--border)", color: "var(--text-secondary)" }}
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
  selected,
  onSelect,
}: {
  u: api.ApiUser;
  subtitle?: string;
  metaRight?: string;
  unread?: number;
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

function InfoPanel({
  mode,
  peer,
  group,
  peerFp,
  onSafety,
  onClearChat,
  mutedPeers,
  setMutedPeers,
}: {
  mode: "dm" | "group";
  peer: api.ApiUser | null;
  group: api.ApiGroup | null;
  peerFp: string | null;
  onSafety: () => void;
  onClearChat: () => void | Promise<void>;
  mutedPeers: Set<string>;
  setMutedPeers: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  const title = mode === "dm" ? peer?.username ?? "Kontakt" : group?.name ?? "Gruppe";
  const initials = (title.slice(0, 1) || "•").toUpperCase();
  const status = mode === "dm" ? "Online" : `${group?.memberIds.length ?? 0} Mitglieder`;
  const isMuted = peer ? mutedPeers.has(peer.id) : false;

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
    <div className="flex h-full min-h-0 w-full max-w-full flex-col overflow-y-auto p-1">
      {/* Profile Avatar */}
      <div className="flex flex-col items-center">
        <div className="info-avatar-large !mb-3 !mt-0 !h-20 !w-20 !text-2xl">
          {initials}
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
          className="flex flex-col items-center gap-1 rounded-lg border border-[var(--border)] p-2 transition hover:bg-[var(--bg-hover)]"
          style={{ background: "var(--bg-elevated)" }}
          title="Profil anzeigen"
        >
          <span className="text-lg">👤</span>
          <span className="text-[10px]" style={{ color: "var(--text-secondary)" }}>Profil</span>
        </button>
        <button
          type="button"
          className={`flex flex-col items-center gap-1 rounded-lg border p-2 transition ${
            isMuted ? "border-amber-600 bg-amber-900/30" : "border-[var(--border)] hover:bg-[var(--bg-hover)]"
          }`}
          style={isMuted ? {} : { background: "var(--bg-elevated)" }}
          onClick={toggleMute}
          title={isMuted ? "Stummschaltung aufheben" : "Stummschalten"}
        >
          <span className="text-lg">{isMuted ? "🔔" : "🔕"}</span>
          <span className="text-[10px]" style={{ color: isMuted ? "var(--amber)" : "var(--text-secondary)" }}>
            {isMuted ? "Stumm" : "Benachrichtigungen"}
          </span>
        </button>
        <button
          type="button"
          className="flex flex-col items-center gap-1 rounded-lg border border-[var(--border)] p-2 transition hover:bg-[var(--bg-hover)]"
          style={{ background: "var(--bg-elevated)" }}
          title="Suchen"
        >
          <span className="text-lg">🔍</span>
          <span className="text-[10px]" style={{ color: "var(--text-secondary)" }}>Suchen</span>
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
              <span className="font-mono text-xs" style={{ color: "var(--accent)" }}>
                {peer.id.slice(0, 16)}...
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="info-section !border-0 !pb-0">
        <p className="info-section-title">🔒 Sicherheit</p>
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
            <p
              className="font-mono text-xs leading-relaxed break-all"
              style={{ color: "var(--accent)" }}
            >
              {peerFp ?? "…"}
            </p>
            <p className="mt-1 text-[11px] app-muted">Tippen zum Prüfen / vergleichen</p>
          </button>
        </div>
      )}

      <div className="info-section">
        <p className="info-section-title">Geteilte Inhalte</p>
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
          Dateien und Sprachnotizen erscheinen in diesem Chat. Medienübersicht
          folgt.
        </p>
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
