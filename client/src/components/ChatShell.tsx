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
  randomGroupKey,
  setGroupKey,
} from "../lib/groupCrypto";
import { acceptCall, startCall, type RtcPayload } from "../lib/webrtc";
import { sealSender } from "../lib/sealedSender";
import {
  outboxAdd,
  outboxList,
  outboxGetMeta,
  outboxRemove,
  outboxAttempt,
} from "../lib/outbox";
import { observePeerKey, getPin, type PeerPin } from "../lib/trust";
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
import { useTheme } from "../lib/theme.tsx";
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

export function ChatShell({
  session,
  onLogout,
  onLock,
}: {
  session: Session;
  onLogout: () => void;
  onLock: () => void;
}) {
  const { theme, toggle } = useTheme();
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

  const callRef = useRef<{
    close: () => void;
    handleRemote?: (p: RtcPayload) => void | Promise<void>;
    addIce?: (c: RTCIceCandidateInit) => void | Promise<void>;
  } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
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
  peerRef.current = peer;
  groupRef.current = group;
  usersRef.current = users;
  tokenRef.current = session.token;

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
        setUsers(list.filter((u) => u.id !== session.user.id));
        return list.find((u) => u.id === userId) ?? null;
      } catch {
        return null;
      }
    },
    [session.token, session.user.id]
  );

  const loadUsers = useCallback(async () => {
    const { users: list } = await api.listUsers(session.token);
    const others = list.filter((u) => u.id !== session.user.id);
    setUsers(others);
    for (const u of others) {
      try {
        await observePeerKey(u.id, u.publicKey);
      } catch {
        /* ignore */
      }
    }
    // Refresh unread counters (best-effort).
    try {
      const next: Record<string, number> = {};
      for (const u of others) {
        const seenRaw = await metaGet(`seen:dm:${u.id}`);
        const seenAt = seenRaw ? Number(seenRaw) || 0 : 0;
        const rows = rawDmRef.current.get(u.id) ?? [];
        next[u.id] = rows.filter((r) => !r.fromMe && r.at > seenAt).length;
      }
      setUnreadByPeer(next);
    } catch {
      /* ignore */
    }
  }, [session.token, session.user.id]);

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
    void loadUsers();
    void loadGroups();
    void idbPurgeExpired().catch(() => {});
    void refreshPendingCount();
  }, [loadUsers, loadGroups, refreshPendingCount]);

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

  useEffect(() => {
    if (!dmScrollRef.current) return;
    dmScrollRef.current.scrollTop = dmScrollRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!groupScrollRef.current) return;
    groupScrollRef.current.scrollTop = groupScrollRef.current.scrollHeight;
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
    };
    ws.onclose = () => setConnected(false);
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
              await setGroupKey(plain.groupId, uint8FromBase64(plain.keyB64));
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
          className={`w-full rounded-lg px-3 py-2 text-left text-sm ${
            group?.id === g.id && tab === "group"
              ? "bg-emerald-900/40 text-emerald-100"
              : "text-zinc-300 hover:bg-zinc-800"
          }`}
        >
          {g.name}
        </button>
      )),
    [groups, group, tab]
  );

  return (
    <div className="flex h-full w-full flex-col bg-zinc-950 p-2 md:p-4">
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

      <div className="app-surface flex min-h-0 w-full flex-1 overflow-hidden rounded-2xl md:rounded-3xl">
      <aside className={`${showSidebar ? "flex" : "hidden"} w-full flex-col border-zinc-800/80 bg-zinc-950/45 md:flex md:w-84 md:border-r`}>
        <div className="flex items-center justify-between border-b border-zinc-800/80 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-white">VaultChat</p>
            <p className="text-xs text-zinc-500">Secure Messenger</p>
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={toggle}
              className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 transition hover:bg-zinc-800"
              title="Theme umschalten"
            >
              {theme === "dark" ? "Light" : "Dark"}
            </button>
            <button
              type="button"
              onClick={onLock}
              className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 transition hover:bg-zinc-800"
              title="Sofort sperren (LDK aus dem Speicher entfernen)"
            >
              Sperren
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 transition hover:bg-zinc-800"
            >
              Abmelden
            </button>
          </div>
        </div>

        <div className="px-3 pt-3">
          <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/50 px-3 py-2">
            <span className="text-zinc-500">
              <IconSearch size={16} />
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Suchen…"
              className="app-input w-full rounded-lg bg-transparent text-sm outline-none"
            />
          </div>
        </div>

        <div className="flex gap-2 border-b border-zinc-800/80 p-3">
          <button
            type="button"
            className={`flex-1 rounded-2xl py-2 text-xs font-semibold ${
              sideTab === "direct"
                ? "bg-emerald-700/80 text-white shadow-sm shadow-emerald-950/40"
                : "text-zinc-400 hover:bg-zinc-800/60"
            }`}
            onClick={() => {
              setSideTab("direct");
              setTab("dm");
            }}
          >
            Direkt
          </button>
          <button
            type="button"
            className={`flex-1 rounded-2xl py-2 text-xs font-semibold ${
              sideTab === "groups"
                ? "bg-emerald-700/80 text-white shadow-sm shadow-emerald-950/40"
                : "text-zinc-400 hover:bg-zinc-800/60"
            }`}
            onClick={() => {
              setSideTab("groups");
              setTab("group");
            }}
          >
            Gruppen
          </button>
          <button
            type="button"
            className={`flex-1 rounded-2xl py-2 text-xs font-semibold ${
              sideTab === "fav"
                ? "bg-emerald-700/80 text-white shadow-sm shadow-emerald-950/40"
                : "text-zinc-400 hover:bg-zinc-800/60"
            }`}
            onClick={() => setSideTab("fav")}
            title="Favoriten (coming soon)"
          >
            Favoriten
          </button>
        </div>

        {tab === "dm" && (
          <>
            <div className="border-b border-zinc-800/80 px-3 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                Kontakte
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-2">{peerList}</div>
          </>
        )}

        {tab === "group" && (
          <>
            <div className="space-y-2 border-b border-zinc-800/80 p-3">
              <input
                className="w-full rounded-xl border border-zinc-700 bg-zinc-900/80 px-2.5 py-2 text-sm text-white outline-none ring-emerald-500/20 focus:ring-2"
                placeholder="Gruppenname"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
              />
              <select
                multiple
                className="h-24 w-full rounded-xl border border-zinc-700 bg-zinc-900/80 px-2 py-1 text-xs text-zinc-200 outline-none ring-emerald-500/20 focus:ring-2"
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
                className="w-full rounded-xl bg-emerald-700 py-2 text-sm font-medium text-white transition hover:bg-emerald-600"
              >
                Gruppe erstellen
              </button>
            </div>
            <div className="border-b border-zinc-800/80 px-3 py-2">
              <p className="text-xs uppercase tracking-wide text-zinc-500">
                Deine Gruppen
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-2">{groupList}</div>
          </>
        )}

        <div className="space-y-1 border-t border-zinc-800/80 p-3 text-xs text-zinc-500">
          <p className="font-mono text-emerald-600/90">Du: {myFp ?? "…"}</p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={relayOnly}
              onChange={(e) => setRelayOnly(e.target.checked)}
            />
            <span>Call nur über TURN-Relay</span>
          </label>
          <button
            type="button"
            className="mt-1 text-emerald-500 hover:text-emerald-400"
            onClick={() => {
              void loadUsers();
              void loadGroups();
            }}
          >
            Aktualisieren
          </button>
        </div>
      </aside>

      <main className={`${showSidebar ? "hidden" : "flex"} min-h-0 flex-1 flex-col bg-zinc-950/55 md:flex`}>
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
          <div className="flex flex-1 items-center justify-center px-6 text-center text-zinc-500">
            <div className="max-w-sm">
              <p className="text-sm font-medium text-zinc-200">Wähle einen Kontakt</p>
              <p className="mt-1 text-xs text-zinc-500">
                Nachrichten-Historie liegt nur lokal (verschlüsselte IndexedDB).
              </p>
            </div>
          </div>
        )}

        {tab === "dm" && peer && (
          <>
            <header className="border-b border-zinc-800/80 bg-zinc-900/30 px-3 py-3 md:px-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {isMobile && (
                    <button
                      type="button"
                      onClick={() => setPeer(null)}
                      className="rounded-xl border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
                      title="Zurück"
                    >
                      ←
                    </button>
                  )}
                  <div className="grid h-9 w-9 place-items-center rounded-full bg-emerald-900/40 text-sm font-semibold text-emerald-200">
                    {peer.username.slice(0, 1).toUpperCase()}
                  </div>
                  <div>
                  <p className="font-medium text-white">{peer.username}</p>
                  <p className="font-mono text-xs text-emerald-600/80">
                    Fingerprint: {peerFp ?? "…"}
                  </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setInfoOpen((v) => !v)}
                    className="rounded-xl border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800 md:hidden"
                    title="Details"
                  >
                    <IconMore size={16} />
                  </button>
                  <select
                    value={ttlDm}
                    onChange={(e) => void onChangeTtlDm(Number(e.target.value))}
                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
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
                    className={`rounded-lg border px-3 py-1 text-xs hover:bg-zinc-800 ${
                      peerPin?.state === "verified"
                        ? "border-emerald-600 text-emerald-300"
                        : peerPin?.state === "mismatch"
                          ? "border-red-700 text-red-300"
                          : "border-zinc-600 text-zinc-200"
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
                    className="rounded-lg border border-zinc-600 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
                  >
                    <IconPhone size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setInfoOpen(true)}
                    className="hidden rounded-lg border border-zinc-600 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 md:inline-flex"
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
              className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-[radial-gradient(circle_at_top,rgba(16,185,129,0.06),transparent_40%)] px-4 py-4"
            >
              {messages.map((m) => (
                <MessageBubble
                  key={m.plain.cid ?? m.id}
                  msg={m}
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
              ))}
              {typing && (
                <p className="text-xs italic text-zinc-500">
                  {peer.username} schreibt…
                </p>
              )}
            </div>

            <footer className="border-t border-zinc-800/80 bg-zinc-900/35 p-3 pb-[calc(env(safe-area-inset-bottom,0px)+12px)]">
              {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
              {replyDm && (
                <div className="mb-2 flex items-center justify-between rounded-lg border-l-2 border-emerald-500 bg-zinc-900 px-3 py-1 text-xs text-zinc-300">
                  <span>
                    <span className="text-emerald-400">
                      Antwort an {replyDm.author}:
                    </span>{" "}
                    {replyDm.text.slice(0, 120)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setReplyDm(null)}
                    className="ml-2 text-zinc-500 hover:text-white"
                  >
                    ×
                  </button>
                </div>
              )}
              <div className="relative flex gap-2">
                <button
                  type="button"
                  onClick={() => setEmojiOpen((v) => !v)}
                  className="rounded-xl border border-zinc-700 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800"
                  title="Emoji"
                >
                  🙂
                </button>
                {emojiOpen && (
                  <div className="absolute bottom-[62px] left-3 z-20 rounded-2xl border border-zinc-800 bg-zinc-950/90 p-2 text-lg shadow-xl backdrop-blur">
                    {["😀","😂","😍","👍","🔥","🎉","😮","😢","🙏","✅"].map((e) => (
                      <button
                        key={e}
                        type="button"
                        className="rounded px-1.5 py-1 hover:bg-zinc-800"
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
                  className="cursor-pointer rounded-xl border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition hover:bg-zinc-800"
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
                  className={`rounded-xl border px-3 py-2 text-xs ${
                    voice.recording
                      ? "border-red-500 bg-red-700/60 text-white"
                      : "border-zinc-700 text-zinc-300 transition hover:bg-zinc-800"
                  }`}
                >
                  {voice.recording ? "■" : <IconMic size={16} />}
                </button>
                <button
                  type="button"
                  onClick={() => void sendDmText()}
                  disabled={voice.recording || !text.trim()}
                  className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-40"
                >
                  <IconSend size={16} />
                </button>
              </div>
            </footer>
          </>
        )}

        {tab === "group" && !group && (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-zinc-500">
            <div className="max-w-sm">
              <p className="text-sm font-medium text-zinc-200">Wähle eine Gruppe</p>
              <p className="mt-1 text-xs text-zinc-500">
                Oder erstelle oben links eine neue Gruppe.
              </p>
            </div>
          </div>
        )}

        {tab === "group" && group && (
          <>
            <header className="border-b border-zinc-800/80 bg-zinc-900/30 px-3 py-3 md:px-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {isMobile && (
                    <button
                      type="button"
                      onClick={() => setGroup(null)}
                      className="rounded-xl border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
                      title="Zurück"
                    >
                      ←
                    </button>
                  )}
                  <div className="grid h-9 w-9 place-items-center rounded-full bg-zinc-800 text-sm font-semibold text-zinc-200">
                    {group.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div>
                  <p className="font-medium text-white">{group.name}</p>
                  <p className="text-xs text-zinc-500">
                    E2EE symmetrisch · {group.memberIds.length} Mitglieder
                  </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setInfoOpen((v) => !v)}
                    className="rounded-xl border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 md:hidden"
                    title="Info"
                  >
                    Info
                  </button>
                  <select
                    value={ttlGroup}
                    onChange={(e) => void onChangeTtlGroup(Number(e.target.value))}
                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
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
                    className="rounded-lg border border-zinc-600 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
                  >
                    Mitglieder
                  </button>
                </div>
              </div>

              {groupPanelOpen && (
                <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-200">
                  <ul className="mb-2 space-y-1">
                    {group.memberIds.map((mid) => {
                      const u = users.find((x) => x.id === mid);
                      const label = u?.username ?? (mid === session.user.id ? "Du" : mid.slice(0, 8));
                      return (
                        <li
                          key={mid}
                          className="flex items-center justify-between rounded bg-zinc-950/60 px-2 py-1"
                        >
                          <span>{label}</span>
                          {mid !== session.user.id && (
                            <button
                              type="button"
                              onClick={() => void removeMember(mid)}
                              className="rounded border border-red-700 px-2 py-0.5 text-red-300 hover:bg-red-900/30"
                            >
                              Entfernen + Key rotieren
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
                      className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
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
                      className="rounded border border-emerald-700 px-2 py-1 text-emerald-300 hover:bg-emerald-900/30 disabled:opacity-40"
                    >
                      Hinzufügen + Key rotieren
                    </button>
                    <button
                      type="button"
                      onClick={() => void leaveCurrentGroup()}
                      className="rounded border border-amber-700 px-2 py-1 text-amber-200 hover:bg-amber-900/30"
                    >
                      Verlassen
                    </button>
                  </div>
                </div>
              )}
            </header>
            <div
              ref={groupScrollRef}
              className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-[radial-gradient(circle_at_top,rgba(16,185,129,0.06),transparent_40%)] px-4 py-4"
            >
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
            <footer className="border-t border-zinc-800/80 bg-zinc-900/35 p-3 pb-[calc(env(safe-area-inset-bottom,0px)+12px)]">
              {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
              {replyGroup && (
                <div className="mb-2 flex items-center justify-between rounded-lg border-l-2 border-emerald-500 bg-zinc-900 px-3 py-1 text-xs text-zinc-300">
                  <span>
                    <span className="text-emerald-400">
                      Antwort an {replyGroup.author}:
                    </span>{" "}
                    {replyGroup.text.slice(0, 120)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setReplyGroup(null)}
                    className="ml-2 text-zinc-500 hover:text-white"
                  >
                    ×
                  </button>
                </div>
              )}
              <div className="flex gap-2">
                <input
                  className="flex-1 rounded-xl border border-zinc-700 bg-zinc-900/80 px-3 py-2 text-sm text-white outline-none ring-emerald-500/20 transition focus:border-emerald-500/50 focus:ring-2"
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
                  className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500"
                >
                  Senden
                </button>
              </div>
            </footer>
          </>
        )}
      </main>

      {/* Right info panel (desktop) */}
      {showInfo && (
        <aside className="hidden w-80 shrink-0 border-l border-zinc-800/80 bg-zinc-950/40 md:flex">
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
              <p className="text-sm font-semibold text-white">Details</p>
              <button
                type="button"
                onClick={() => setInfoOpen(false)}
                className="rounded-lg border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
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
            />
          </div>
        </div>
      )}
      {isMobile && !showConversation && (
        <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-zinc-800/80 bg-zinc-950/80 p-2 backdrop-blur">
          <div className="mx-auto flex max-w-md gap-2">
            <button
              type="button"
              onClick={() => setTab("dm")}
              className={`flex-1 rounded-xl px-3 py-2 text-sm font-medium ${
                tab === "dm"
                  ? "bg-emerald-600 text-white"
                  : "border border-zinc-800 text-zinc-300"
              }`}
            >
              Direkt
            </button>
            <button
              type="button"
              onClick={() => setTab("group")}
              className={`flex-1 rounded-xl px-3 py-2 text-sm font-medium ${
                tab === "group"
                  ? "bg-emerald-600 text-white"
                  : "border border-zinc-800 text-zinc-300"
              }`}
            >
              Gruppen
            </button>
          </div>
        </div>
      )}
      </div>
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
      className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left ${
        selected
          ? "bg-emerald-900/35 text-emerald-100"
          : "text-zinc-200 hover:bg-zinc-800/60"
      }`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-zinc-800 text-sm font-semibold text-zinc-100">
          {u.username.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{u.username}</span>
            {pin?.state === "mismatch" && (
              <span className="rounded-md border border-red-700/70 bg-red-950/30 px-1.5 py-0.5 text-[10px] text-red-200">
                ⚠
              </span>
            )}
            {pin?.state === "verified" && (
              <span className="rounded-md border border-emerald-600/70 bg-emerald-950/20 px-1.5 py-0.5 text-[10px] text-emerald-200">
                ✓
              </span>
            )}
          </div>
          <p className="truncate text-xs text-zinc-500">{subtitle ?? ""}</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-[10px] text-zinc-500">{metaRight ?? ""}</span>
        {unread && unread > 0 ? (
          <span className="grid h-5 min-w-5 place-items-center rounded-full bg-emerald-600 px-1 text-[10px] font-semibold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : (
          <span className="text-[10px] text-zinc-500">›</span>
        )}
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
}: {
  mode: "dm" | "group";
  peer: api.ApiUser | null;
  group: api.ApiGroup | null;
  peerFp: string | null;
  onSafety: () => void;
  onClearChat: () => void | Promise<void>;
}) {
  const title = mode === "dm" ? peer?.username ?? "Kontakt" : group?.name ?? "Gruppe";
  const initials = (title.slice(0, 1) || "•").toUpperCase();
  const status = mode === "dm" ? "Online" : `${group?.memberIds.length ?? 0} Mitglieder`;

  return (
    <div className="flex h-full w-full flex-col p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-full bg-emerald-900/30 text-sm font-semibold text-emerald-200">
            {initials}
          </div>
          <div>
            <p className="text-sm font-semibold text-white">{title}</p>
            <p className="text-xs text-zinc-500">{status}</p>
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-4 gap-2 text-[11px] text-zinc-300">
        <QuickAction label="Profil" />
        <QuickAction label="Suchen" />
        <QuickAction label="Stumm" />
        <QuickAction label="Mehr" />
      </div>

      <div className="mt-4 space-y-2">
        <div className="rounded-2xl border border-zinc-800/80 bg-zinc-950/40 p-3">
          <p className="text-xs font-semibold text-emerald-300">Sicherheit</p>
          <p className="mt-1 text-xs text-zinc-400">
            Deine Nachrichten und Anrufe sind Ende‑zu‑Ende verschlüsselt.
          </p>
        </div>

        <button
          type="button"
          onClick={onSafety}
          className="w-full rounded-2xl border border-zinc-800/80 bg-zinc-950/40 p-3 text-left transition hover:bg-zinc-900/40"
        >
          <p className="text-xs font-semibold text-white">Sicherheitsnummer</p>
          <p className="mt-1 font-mono text-[11px] text-emerald-300">
            {peerFp ?? "…"}
          </p>
        </button>

        <div className="rounded-2xl border border-zinc-800/80 bg-zinc-950/40 p-3">
          <p className="text-xs font-semibold text-white">Geteilte Medien</p>
          <p className="mt-1 text-xs text-zinc-500">
            Dateien &amp; Voice findest du direkt im Chat. Links/Galerie kommt als nächstes.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void onClearChat()}
          className="w-full rounded-2xl border border-red-900/40 bg-red-950/20 p-3 text-left text-red-200 transition hover:bg-red-950/30"
        >
          Chat löschen
        </button>
      </div>

      <div className="mt-auto pt-4 text-[11px] text-zinc-500">
        Hinweis: Historie ist lokal gespeichert (verschlüsselte IndexedDB).
      </div>
    </div>
  );
}

function QuickAction({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="rounded-2xl border border-zinc-800/80 bg-zinc-950/40 py-2 text-center text-[11px] text-zinc-200 hover:bg-zinc-900/40"
    >
      {label}
    </button>
  );
}
