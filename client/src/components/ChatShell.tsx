import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "../lib/sessionHelpers";
import * as api from "../lib/api";
import { decryptIncomingSealedDmWithReplayCheck } from "../lib/incomingDm";
import { olmEncryptJson } from "../lib/olmSession";
import {
  buildSessionKeyDistribution,
  ingestSessionKey,
  isMegolmGroupCiphertext,
  megolmDecryptGroup,
  megolmEncryptGroup,
  parseMegolmEnvelope,
  rotateForMemberRemoval,
} from "../lib/megolmSession";
import {
  getGroupSecret,
  adoptGroupSecret,
  ensureGroupSecret,
  encryptGroupMeta,
  decryptGroupMeta,
  isEncryptedGroupMeta,
} from "../lib/groupSecret";

/** Server-sichtbarer Platzhalter-Name, während der echte Name als
 *  GMETA1-Ciphertext nachgereicht wird (Server sieht den echten Namen nie). */
const GROUP_NAME_PLACEHOLDER = "🔒";
import { getWsUrl } from "../lib/wsUrl";
import {
  fingerprintFromPublicKeyB64,
  type PlainPayload,
} from "../lib/crypto";
import {
  idbCountUnreadByGroup,
  idbCountUnreadByPeer,
  idbDeleteDm,
  idbDeleteGroupMsg,
  idbListDm,
  idbListDmPeerIds,
  idbListGroup,
  idbListGroupIds,
  idbPutDm,
  idbPutGroupMsg,
  idbPurgeExpired,
  metaGet,
  metaSet,
} from "../lib/idb";
// Phase 5: eigenes groupCrypto entfernt — Megolm ist alleiniger Group-Pfad.
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
import { buildUploadBodyWithOlm } from "../lib/keyStore";
import { encryptIdentityBackup } from "../lib/backup";
import { loadLocalIdentity } from "../lib/localIdentity";
import { previewForPayload } from "../lib/messagePreview";
import {
  fmtDateLabel,
  formatElapsedMs,
  loadStringSet,
  newCid,
  saveStringSet,
  userGradient,
} from "../lib/chatHelpers";
import {
  MessageBubble,
  type ChatMsg,
} from "./MessageBubble";
import { PeerRow } from "./PeerRow";
import { InfoPanel, type SharedMediaItem } from "./InfoPanel";
import { safeMediaSrc } from "../lib/safeMedia";
import { t, useLocale } from "../lib/i18n";
import { GroupCallBar } from "./GroupCallBar";
import {
  GroupCallController,
  type GroupCallState,
  type VoiceAnnounce,
} from "../lib/groupCall";
import { BackupReminder } from "./BackupReminder";
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
import { ComposerToolsMenu } from "./ComposerToolsMenu";
import { ThreadPanel } from "./ThreadPanel";
import { loadThreadSeen, type ThreadSeenMap } from "../lib/threadState";
import { isPro, loadPlan, getLimits, PLAN_LABELS } from "../lib/plan";
import { EmojiPicker } from "./EmojiPicker";
import { OnboardingOverlay, readOnboardingPending } from "./OnboardingOverlay";
import { ToastRegion } from "./ToastRegion";
import { VaultChatLogo } from "./Logo";
import { FoldersManageModal } from "./FoldersManageModal";
import { ShortcutsHelpModal } from "./ShortcutsHelpModal";
import { pushToast } from "../lib/toastBus";
import {
  isTauri,
  sendDesktopNotification,
  setUnreadBadge,
  flashDesktopWindow,
} from "../lib/desktopNotify";
import {
  IconArrowDown,
  IconBan,
  IconBell,
  IconBookmark,
  IconCopy,
  IconDownload,
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
  | "requests"
  | `folder:${string}`;
type CallStatus = "idle" | "ringing" | "connecting" | "connected" | "failed" | "ended";

// Consecutive messages from the same author within this window are visually
// grouped (tight spacing, shared corner). Beyond it they get breathing room —
// Signal/WhatsApp-style time-aware grouping.
const MSG_GROUP_WINDOW_MS = 5 * 60_000;

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

const TTL_OPTIONS: { labelKey: string; ms: number }[] = [
  { labelKey: "ttl.off", ms: 0 },
  { labelKey: "ttl.30s", ms: 30_000 },
  { labelKey: "ttl.5min", ms: 5 * 60_000 },
  { labelKey: "ttl.1h", ms: 60 * 60_000 },
  { labelKey: "ttl.1day", ms: 24 * 60 * 60_000 },
  { labelKey: "ttl.7days", ms: 7 * 24 * 60 * 60_000 },
];

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
  useLocale(); // re-render chat UI on language change
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
  // 0 = noch nie versucht, >0 = wir reconnecten gerade (für UI-State).
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
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
  const [mutedPeers, setMutedPeers] = useState<Set<string>>(() =>
    loadStringSet("vaultchat.muted.peers")
  );
  const [mutedGroups, setMutedGroups] = useState<Set<string>>(() =>
    loadStringSet("vaultchat.muted.groups")
  );
  const [favoritePeers, setFavoritePeers] = useState<Set<string>>(
    () => loadStringSet("vaultchat.favorites.peers")
  );
  const [blockedPeers, setBlockedPeers] = useState<Set<string>>(
    () => loadStringSet("vaultchat.blocked.peers")
  );
  // Message requests (Signal-style gate): a peer is "accepted" once the user
  // has engaged (added them, sent them a message, or explicitly accepted a
  // request). The first DM from a not-yet-accepted, not-blocked sender lands
  // in the requests area instead of the main chat list.
  const [acceptedPeers, setAcceptedPeers] = useState<Set<string>>(
    () => loadStringSet("vaultchat.accepted.peers")
  );
  const [requestPeers, setRequestPeers] = useState<Set<string>>(
    () => loadStringSet("vaultchat.requests.peers")
  );
  // Display-name cache for blocked peers so the "Blocked contacts" manager can
  // show names even after the peer leaves the in-memory contact list (e.g.
  // after a reload or after deleting a blocked request).
  const [blockedNames, setBlockedNames] = useState<Record<string, string>>(
    () => {
      try {
        const raw = localStorage.getItem("vaultchat.blocked.names");
        if (!raw) return {};
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string") out[k] = v;
        }
        return out;
      } catch {
        return {};
      }
    }
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
  // Relay-only ("hide my IP from the call peer") persists across reloads —
  // a privacy choice shouldn't silently reset to off every session.
  const [relayOnly, setRelayOnly] = useState(() => {
    try {
      return localStorage.getItem("vaultchat.call.relayOnly") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("vaultchat.call.relayOnly", relayOnly ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [relayOnly]);
  // Group voice room (Discord-style, P2P mesh, E2EE via DTLS-SRTP). The
  // controller lives in a ref; its published snapshot drives the UI.
  const groupCallCtrlRef = useRef<GroupCallController | null>(null);
  const groupCallGroupIdRef = useRef<string | null>(null);
  const [groupCallState, setGroupCallState] = useState<GroupCallState | null>(
    null
  );
  // Best-effort passive occupancy (who's in each group's voice room), tracked
  // from announces seen while online so we can show a "join" prompt with a
  // count before joining: groupId -> Set<userId>.
  const voiceRoomsRef = useRef<Map<string, Set<string>>>(new Map());
  const [voiceOccupants, setVoiceOccupants] = useState<Record<string, number>>(
    {}
  );
  // Release the mic + mesh connections if the shell unmounts (lock/logout)
  // while still in a voice room.
  useEffect(() => {
    return () => {
      groupCallCtrlRef.current?.leave();
      groupCallCtrlRef.current = null;
    };
  }, []);
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
  const [threadSeen, setThreadSeen] = useState<ThreadSeenMap>(() =>
    loadThreadSeen()
  );

  // Reset open thread when switching chats so it doesn't bleed across DM/group/peer.
  useEffect(() => {
    setOpenThreadCid(null);
  }, [peer?.id, group?.id, tab]);

  // Refresh thread-seen state whenever the panel closes (it writes on close).
  useEffect(() => {
    if (!openThreadCid) setThreadSeen(loadThreadSeen());
  }, [openThreadCid]);
  const [folderEdit, setFolderEdit] = useState<ChatFolder | null>(null);
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);

  useEffect(() => subscribeFolders(setFolders), []);
  const [unreadByPeer, setUnreadByPeer] = useState<Record<string, number>>({});
  // Bumped whenever the in-memory DM store (rawDmRef) mutates, so derived
  // memos (list preview, recency sort, starred peers) recompute even when a
  // message lands in a chat that isn't currently open.
  const [dmRev, setDmRev] = useState(0);
  const [unreadByGroup, setUnreadByGroup] = useState<Record<string, number>>(
    {}
  );
  // Same idea as dmRev, for the group store (rawGroupRef).
  const [groupRev, setGroupRev] = useState(0);
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
  // Live mirrors so the WS handler closure always sees current acceptance
  // state without re-subscribing the socket on every set change.
  const acceptedPeersRef = useRef<Set<string>>(acceptedPeers);
  const blockedPeersRef = useRef<Set<string>>(blockedPeers);
  const requestPeersRef = useRef<Set<string>>(requestPeers);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const groupTypingClearTimers = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
  const seen = useRef(new Set<string>());
  /**
   * Drives the "New messages" divider (Discord/WhatsApp style). `at` is the
   * peer's `seen:dm:` timestamp snapshotted the moment the chat opens — BEFORE
   * we overwrite it with `Date.now()`. `cap` is that open moment: messages
   * newer than `cap` arrive live while the chat is open and must NOT spawn a
   * surprise divider, so the divider only spans (at, cap]. The marker stays
   * anchored above the first message in that window for the whole session.
   */
  const dmUnreadDividerAtRef = useRef<number>(0);
  const dmUnreadDividerCapRef = useRef<number>(0);
  const groupUnreadDividerAtRef = useRef<number>(0);
  const groupUnreadDividerCapRef = useRef<number>(0);
  /**
   * Set true the moment a chat opens so the next render scrolls to the
   * "New messages" divider (if any) instead of jumping straight to the
   * bottom — like Slack/Discord. Consumed (cleared) by the auto-scroll effect.
   */
  const dmScrollToUnreadRef = useRef<boolean>(false);
  const groupScrollToUnreadRef = useRef<boolean>(false);
  /**
   * Buffered group ciphertexts that arrived BEFORE the group key was
   * known. We retry them once the matching `group_key` DM lands so the
   * race between `group_key` distribution and the first chat message
   * does not silently drop messages.
   */
  const pendingGroupCipherRef = useRef<
    Map<string, Array<{ id: string; ciphertext: string; createdAt: number }>>
  >(new Map());
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
  acceptedPeersRef.current = acceptedPeers;
  blockedPeersRef.current = blockedPeers;
  requestPeersRef.current = requestPeers;
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
    const displayBody = showPreview ? body : t("chat.newMessageNotif");
    // Only notify when the window isn't focused (minimized / in tray / bg tab).
    if (document.visibilityState === "visible") return;
    // Desktop app: WebView2 doesn't reliably expose Web Notifications, so go
    // through the native OS notification channel.
    if (isTauri()) {
      void sendDesktopNotification(title, displayBody);
      void flashDesktopWindow();
      return;
    }
    if (!("Notification" in window)) return;
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

  // Load contacts from local DM history (persisted at rest), unioned with the
  // in-memory set, plus any pending request senders / accepted peers so they
  // survive a reload. `peerId` is an unencrypted index field, so enumerating
  // it does not require the local key.
  const loadContacts = useCallback(async () => {
    const localIds = await idbListDmPeerIds().catch(() => [] as string[]);
    const contactIds = Array.from(
      new Set<string>([
        ...rawDmRef.current.keys(),
        ...localIds,
        ...requestPeersRef.current,
        ...acceptedPeersRef.current,
      ])
    ).filter((id) => id && id !== session.user.id);

    // One-time migration: before this feature shipped there was no concept of
    // "accepted". Treat every pre-existing conversation as accepted so we never
    // dump established chats into the requests area on upgrade.
    try {
      if (!localStorage.getItem("vaultchat.requests.migrated")) {
        if (localIds.length > 0) {
          setAcceptedPeers((prev) => {
            const next = new Set(prev);
            for (const id of localIds) if (id !== session.user.id) next.add(id);
            saveStringSet("vaultchat.accepted.peers", next);
            return next;
          });
        }
        localStorage.setItem("vaultchat.requests.migrated", "1");
      }
    } catch {
      /* localStorage unavailable — skip migration flag */
    }

    if (contactIds.length === 0) {
      setUsers([]);
      return;
    }
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
  }, [session.token, session.user.id]);

  /** Content kinds that constitute a real, user-visible incoming message
   *  (as opposed to receipts, typing, key distribution, etc.) and therefore
   *  trigger a message request from an unknown sender. */
  const isRequestContentKind = useCallback((kind: string | undefined) => {
    return (
      kind === "text" ||
      kind === "file" ||
      kind === "voice" ||
      kind === "poll" ||
      kind === "system"
    );
  }, []);

  /** Mark a peer as accepted (engaged): remove from requests, add to accepted. */
  const markAccepted = useCallback((userId: string) => {
    setAcceptedPeers((prev) => {
      if (prev.has(userId)) return prev;
      const next = new Set(prev);
      next.add(userId);
      saveStringSet("vaultchat.accepted.peers", next);
      return next;
    });
    setRequestPeers((prev) => {
      if (!prev.has(userId)) return prev;
      const next = new Set(prev);
      next.delete(userId);
      saveStringSet("vaultchat.requests.peers", next);
      return next;
    });
  }, []);

  /** Record a pending message request from an unknown sender. */
  const addRequestPeer = useCallback((userId: string) => {
    setRequestPeers((prev) => {
      if (prev.has(userId)) return prev;
      const next = new Set(prev);
      next.add(userId);
      saveStringSet("vaultchat.requests.peers", next);
      return next;
    });
  }, []);

  /** Block a requesting sender and drop them from the requests area. */
  const blockRequestPeer = useCallback((userId: string) => {
    const uname = usersRef.current.find((u) => u.id === userId)?.username;
    if (uname) rememberBlockedName(userId, uname);
    setBlockedPeers((prev) => {
      const next = new Set(prev);
      next.add(userId);
      saveStringSet("vaultchat.blocked.peers", next);
      return next;
    });
    setRequestPeers((prev) => {
      if (!prev.has(userId)) return prev;
      const next = new Set(prev);
      next.delete(userId);
      saveStringSet("vaultchat.requests.peers", next);
      return next;
    });
  }, []);

  /** Delete a request conversation entirely without accepting. If the sender
   *  writes again it will surface as a fresh request. */
  const deleteRequestConversation = useCallback(async (userId: string) => {
    const rows = rawDmRef.current.get(userId) ?? [];
    for (const r of rows) await idbDeleteDm(r.id).catch(() => {});
    rawDmRef.current.delete(userId);
    // Reset the read marker so that if this sender writes again, the new
    // request reliably shows an unread badge (a stale high marker from a
    // prior open could otherwise suppress it).
    await metaSet(`seen:dm:${userId}`, "0").catch(() => {});
    setRequestPeers((prev) => {
      if (!prev.has(userId)) return prev;
      const next = new Set(prev);
      next.delete(userId);
      saveStringSet("vaultchat.requests.peers", next);
      return next;
    });
    setUsers((prev) => prev.filter((u) => u.id !== userId));
    setUnreadByPeer((m) => {
      if (!(userId in m)) return m;
      const copy = { ...m };
      delete copy[userId];
      return copy;
    });
    if (peerRef.current?.id === userId) {
      setPeer(null);
      setInfoOpen(false);
    }
  }, []);

  /** Cache a blocked peer's display name so the blocked-contacts manager can
   *  show it after reloads / after the peer leaves the contact list. */
  const rememberBlockedName = useCallback((userId: string, username: string) => {
    if (!username) return;
    setBlockedNames((prev) => {
      if (prev[userId] === username) return prev;
      const next = { ...prev, [userId]: username };
      try {
        localStorage.setItem("vaultchat.blocked.names", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  /** Mark a conversation as unread (Signal/WhatsApp-style). Rewinds the "seen"
   *  marker to just before the last incoming message and shows a badge; the
   *  chat is deselected so the badge is visible in the list. Persists across
   *  reload via the seen marker. */
  const markChatUnread = useCallback((p: api.ApiUser) => {
    const rows = rawDmRef.current.get(p.id) ?? [];
    let lastIncomingAt = 0;
    for (const r of rows) {
      if (!r.fromMe && r.at > lastIncomingAt) lastIncomingAt = r.at;
    }
    if (lastIncomingAt === 0) return; // nothing incoming to mark
    void metaSet(`seen:dm:${p.id}`, String(lastIncomingAt - 1)).catch(() => {});
    setUnreadByPeer((m) => ({ ...m, [p.id]: Math.max(1, m[p.id] ?? 0) }));
    setPeer(null);
    setInfoOpen(false);
  }, []);

  /** Unblock a peer (from the central blocked-contacts manager). */
  const unblockPeer = useCallback((userId: string) => {
    setBlockedPeers((prev) => {
      if (!prev.has(userId)) return prev;
      const next = new Set(prev);
      next.delete(userId);
      saveStringSet("vaultchat.blocked.peers", next);
      return next;
    });
  }, []);

  /** Entschlüsselt verschlüsselte Gruppen-Metadaten (Name/Beschreibung/Avatar,
   *  alle GMETA1) für die Anzeige. Ohne GMK (z.B. neues Mitglied) → Name wird
   *  zum lokalisierten Platzhalter, Beschreibung/Avatar werden ausgeblendet
   *  (kein kaputtes Bild); sobald der GMK ankommt, lädt der Receive-Handler die
   *  Liste neu. Legacy-Klartext-Felder (kein GMETA1-Präfix) bleiben unberührt. */
  const decryptGroupList = useCallback(
    async (list: api.ApiGroup[]): Promise<api.ApiGroup[]> => {
      return Promise.all(
        list.map(async (g) => {
          let next = g;
          if (isEncryptedGroupMeta(g.name)) {
            const dn = await decryptGroupMeta(g.id, g.name).catch(() => null);
            next = { ...next, name: dn ?? t("chat.encryptedGroup") };
          }
          if (isEncryptedGroupMeta(g.description)) {
            const dd = await decryptGroupMeta(g.id, g.description!).catch(
              () => null
            );
            // Unentschlüsselbar → Feld leeren, nicht den Ciphertext zeigen.
            next = { ...next, description: dd ?? undefined };
          }
          if (isEncryptedGroupMeta(g.avatar)) {
            const da = await decryptGroupMeta(g.id, g.avatar!).catch(() => null);
            // Unentschlüsselbar → kein Avatar (Initialen-Fallback), kein
            // kaputtes <img src="GMETA1:...">.
            next = { ...next, avatar: da ?? undefined };
          }
          return next;
        })
      );
    },
    []
  );

  const loadGroups = useCallback(async () => {
    const { groups: g } = await api.listGroups(session.token);
    setGroups(await decryptGroupList(g));
  }, [session.token, decryptGroupList]);

  const refreshPendingCount = useCallback(async () => {
    try {
      const rows = await outboxList();
      setPendingCount(rows.length);
    } catch {
      setPendingCount(0);
    }
  }, []);

  /** Rebuild unread badges from persisted history so counts survive a reload.
   *  Uses only unencrypted index fields (peerId/fromMe/at) vs. the per-peer
   *  "last seen" marker — no decryption, no live-state clobbering. */
  const initUnread = useCallback(async () => {
    const ids = await idbListDmPeerIds().catch(() => [] as string[]);
    const seen: Record<string, number> = {};
    for (const id of ids) {
      if (id === session.user.id) continue;
      const raw = await metaGet(`seen:dm:${id}`).catch(() => null);
      seen[id] = raw ? Number(raw) || 0 : 0;
    }
    const counts = await idbCountUnreadByPeer(seen).catch(
      () => ({}) as Record<string, number>
    );
    const openId = peerRef.current?.id;
    setUnreadByPeer((prev) => {
      const next = { ...prev };
      for (const [pid, c] of Object.entries(counts)) {
        if (pid === openId || c <= 0) continue;
        // Only seed where we don't already have a (live) count.
        if (next[pid] === undefined || next[pid] === 0) next[pid] = c;
      }
      return next;
    });

    // Same reconstruction for group unread badges.
    const gids = await idbListGroupIds().catch(() => [] as string[]);
    const gSeen: Record<string, number> = {};
    for (const gid of gids) {
      const raw = await metaGet(`seen:group:${gid}`).catch(() => null);
      gSeen[gid] = raw ? Number(raw) || 0 : 0;
    }
    const gCounts = await idbCountUnreadByGroup(gSeen, session.user.id).catch(
      () => ({}) as Record<string, number>
    );
    const openGid = groupRef.current?.id;
    setUnreadByGroup((prev) => {
      const next = { ...prev };
      for (const [gid, c] of Object.entries(gCounts)) {
        if (gid === openGid || c <= 0) continue;
        if (next[gid] === undefined || next[gid] === 0) next[gid] = c;
      }
      return next;
    });
  }, [session.user.id]);

  useEffect(() => {
    void loadContacts();
    void loadGroups();
    void idbPurgeExpired().catch(() => {});
    void refreshPendingCount();
    void initUnread();
  }, [loadContacts, loadGroups, refreshPendingCount, initUnread]);

  /** Title-bar badge: shows total unread count when the tab is in the
   *  background, e.g. "(3) VaultChat". Reverts to plain "VaultChat"
   *  on unmount or when there is nothing unread. */
  useEffect(() => {
    const sum = (r: Record<string, number>) =>
      Object.values(r).reduce((s, n) => s + (n || 0), 0);
    const total = sum(unreadByPeer) + sum(unreadByGroup);
    const base = "Umbra";
    document.title =
      total > 0 ? `(${total > 99 ? "99+" : total}) ${base}` : base;
    return () => {
      document.title = base;
    };
  }, [unreadByPeer, unreadByGroup]);

  /**
   * Olm-Identity + 50 OTKs initial publishen. Phase 5: keine Legacy-
   * X3DH-Keys mehr — `buildUploadBodyWithOlm` postet nur noch das
   * `olm`-Feld.
   */
  useEffect(() => {
    // Defer the Olm bundle build (WASM init + 50 one-time-key generation) so
    // the chat UI paints first — otherwise this heavy main-thread work blocks
    // the first frame and the app feels frozen right after unlock.
    const run = () =>
      void (async () => {
        try {
          const body = await buildUploadBodyWithOlm();
          await api.uploadPreKeys(session.token, body);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("[vaultchat] prekey upload", e);
        }
      })();
    const t = window.setTimeout(run, 80);
    return () => window.clearTimeout(t);
  }, [session.token]);

  /**
   * Olm-OTK-Refill alle 30 min. `getOlmPublishBundle(50)` generiert frisch
   * und markiert sie auf dem persistierten Olm-Account als published —
   * Identity-Keys bleiben stabil.
   */
  useEffect(() => {
    const OLM_OTK_LOW_WATERMARK = 20;
    const REFILL_INTERVAL_MS = 30 * 60_000;
    let disposed = false;

    const refill = async () => {
      if (disposed) return;
      try {
        const body = await buildUploadBodyWithOlm();
        const resp = await api.uploadPreKeys(session.token, body);
        if (
          typeof resp.remainingOlm === "number" &&
          resp.remainingOlm < OLM_OTK_LOW_WATERMARK
        ) {
          // eslint-disable-next-line no-console
          console.debug("[vaultchat:olm] otk_refill_threshold", {
            remaining: resp.remainingOlm,
          });
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.debug("[vaultchat:olm] otk_refill_failed", {
          err: e instanceof Error ? e.message : String(e),
        });
      }
    };

    const t = setInterval(refill, REFILL_INTERVAL_MS);
    return () => {
      disposed = true;
      clearInterval(t);
    };
  }, [session.token]);

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

  // In-memory: an welche {groupId × memberId} haben wir den aktuellen Megolm-
  // Session-Key schon via Olm-1:1 verschickt? Bei Rotation wird der Eintrag
  // gelöscht (membership-add/remove/leave) und neu verteilt.
  const megolmDistributedRef = useRef<Map<string, Set<string>>>(new Map());
  // Selbstheilung (Matrix-Style): Drosseln für Megolm-Key-Requests.
  // keyRequestSentRef: `${groupId}:${sessionId}` → ts der letzten Anfrage WIR→Absender.
  // keyRequestServedRef: `${requesterId}:${groupId}` → ts der letzten Antwort WIR→Anfragender.
  const keyRequestSentRef = useRef<Map<string, number>>(new Map());
  const keyRequestServedRef = useRef<Map<string, number>>(new Map());

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
      // Snapshot the prior last-seen BEFORE overwriting it, so the
      // "New messages" divider can anchor above the first unread message.
      const prevSeenRaw = await metaGet(`seen:dm:${peer.id}`).catch(() => null);
      dmUnreadDividerAtRef.current = prevSeenRaw ? Number(prevSeenRaw) || 0 : 0;
      dmUnreadDividerCapRef.current = Date.now();
      dmScrollToUnreadRef.current = dmUnreadDividerAtRef.current > 0;
      await loadDmLocal(peer);
      // Mark read up to the latest message actually present. Using
      // max(now, newest incoming `at`) keeps the marker in the stored-`at`
      // clock domain so a server/peer clock ahead of ours can't leave a
      // just-read message counted as unread after a reload.
      let seenUpTo = dmUnreadDividerCapRef.current;
      for (const r of rawDmRef.current.get(peer.id) ?? []) {
        if (!r.fromMe && r.at > seenUpTo) seenUpTo = r.at;
      }
      await metaSet(`seen:dm:${peer.id}`, String(seenUpTo)).catch(() => {});
      setUnreadByPeer((m) => ({ ...m, [peer.id]: 0 }));
    })();
  }, [peer, session.secretKey, loadDmLocal]);

  // Per-chat composer drafts (Discord/Signal-style): switching conversations
  // preserves each chat's unsent text instead of bleeding it across chats.
  // Kept in-memory only — drafts must not survive a lock/logout (no at-rest
  // plaintext draft leak).
  const draftsRef = useRef<Map<string, string>>(new Map());
  const lastDraftPeerIdRef = useRef<string | null>(null);
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => {
    const prevId = lastDraftPeerIdRef.current;
    const nextId = peer?.id ?? null;
    if (prevId === nextId) return;
    // Save the outgoing chat's draft (textRef still holds the pre-switch text).
    if (prevId) draftsRef.current.set(prevId, textRef.current);
    // Restore the incoming chat's draft (empty if none).
    setText(nextId ? draftsRef.current.get(nextId) ?? "" : "");
    // A reply target belongs to the chat it was started in — don't let it
    // bleed into the next conversation.
    if (prevId) setReplyDm(null);
    lastDraftPeerIdRef.current = nextId;
  }, [peer?.id]);

  useEffect(() => {
    if (!group) {
      setGroupMessages([]);
      setReplyGroup(null);
      return;
    }
    void (async () => {
      // Snapshot prior last-seen for the "New messages" divider, then mark read.
      const prevSeenRaw = await metaGet(`seen:group:${group.id}`).catch(
        () => null
      );
      groupUnreadDividerAtRef.current = prevSeenRaw
        ? Number(prevSeenRaw) || 0
        : 0;
      groupUnreadDividerCapRef.current = Date.now();
      groupScrollToUnreadRef.current = groupUnreadDividerAtRef.current > 0;
      await loadGroupLocal(group);
      let seenUpTo = groupUnreadDividerCapRef.current;
      for (const r of rawGroupRef.current.get(group.id) ?? []) {
        if (r.fromUserId !== session.user.id && r.at > seenUpTo) seenUpTo = r.at;
      }
      await metaSet(`seen:group:${group.id}`, String(seenUpTo)).catch(() => {});
      setUnreadByGroup((m) => ({ ...m, [group.id]: 0 }));
    })();
  }, [group, loadGroupLocal, session.user.id]);

  // Per-group composer drafts + reply hygiene, mirroring the DM behaviour:
  // switching groups preserves each group's unsent text and never carries a
  // reply target into the next group. In-memory only (no at-rest draft leak).
  const groupDraftsRef = useRef<Map<string, string>>(new Map());
  const lastDraftGroupIdRef = useRef<string | null>(null);
  const groupTextRef = useRef(groupText);
  groupTextRef.current = groupText;
  useEffect(() => {
    const prevId = lastDraftGroupIdRef.current;
    const nextId = group?.id ?? null;
    if (prevId === nextId) return;
    if (prevId) groupDraftsRef.current.set(prevId, groupTextRef.current);
    setGroupText(nextId ? groupDraftsRef.current.get(nextId) ?? "" : "");
    if (prevId) setReplyGroup(null);
    lastDraftGroupIdRef.current = nextId;
  }, [group?.id]);

  // Auto-scroll: nur wenn der User bereits unten war ODER neue Nachricht reinkommt
  // Mit smooth scrolling und verbesserter Bottom-Erkennung
  useEffect(() => {
    const el = dmScrollRef.current;
    if (!el) return;
    // First render after opening a chat with unread messages: land on the
    // "New messages" divider rather than the very bottom.
    if (dmScrollToUnreadRef.current) {
      dmScrollToUnreadRef.current = false;
      const divider = el.querySelector(".unread-divider");
      if (divider) {
        requestAnimationFrame(() =>
          divider.scrollIntoView({ block: "center", behavior: "auto" })
        );
        setDmScrolledUp(true);
        return;
      }
    }
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
    if (groupScrollToUnreadRef.current) {
      groupScrollToUnreadRef.current = false;
      const divider = el.querySelector(".unread-divider");
      if (divider) {
        requestAnimationFrame(() =>
          divider.scrollIntoView({ block: "center", behavior: "auto" })
        );
        setGroupScrolledUp(true);
        return;
      }
    }
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

  // Reflect total unread in the window/tab title + taskbar badge
  // (Discord-style "(3) Umbra"). Browser tab everywhere, native window/badge
  // under Tauri.
  useEffect(() => {
    const sum = (r: Record<string, number>) =>
      Object.values(r).reduce((a, b) => a + (b || 0), 0);
    void setUnreadBadge(sum(unreadByPeer) + sum(unreadByGroup));
  }, [unreadByPeer, unreadByGroup]);

  // Clear the title badge when the chat unmounts (logout / lock).
  useEffect(() => {
    return () => {
      void setUnreadBadge(0);
    };
  }, []);

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
      suppressLocal = false,
      // quiet: keine Fehler-Toasts. Für Hintergrund-Ops (Megolm-Key-Verteilung
      // / Key-Requests), bei denen ein noch-nicht-gebooteter Empfänger keinen
      // sichtbaren Fehler auslösen soll.
      quiet = false
    ): Promise<string | null> => {
      if (blockedPeers.has(toUser.id)) {
        if (!quiet) setError(t("chat.errContactBlocked"));
        return null;
      }
      // Phase 5: auditiertes Olm (Matrix.org) ist der einzige Krypto-Pfad
      // für DMs. Wenn der Empfänger kein Olm-Bundle hat (z.B. noch nicht
      // gebootet seit der Migration), fail-fast statt schleichender
      // Fallback auf selbstgeschriebenen DR.
      let innerB64: string;
      try {
        innerB64 = await olmEncryptJson(
          toUser.id,
          tokenRef.current,
          JSON.stringify(payload)
        );
      } catch (olmErr) {
        const reason =
          olmErr instanceof Error ? olmErr.message : String(olmErr);
        if (!quiet) {
          setError(
            reason === "no_olm_bundle"
              ? t("chat.errNoOlmBundle")
              : t("chat.errOlmFailed", { reason })
          );
        }
        return null;
      }
      const envelope = await sealSender(
        session.user.id,
        innerB64,
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
        setDmRev((x) => x + 1);
        if (peerRef.current?.id === toUser.id) rebuildDm(toUser.id);
        // Sending a real message to someone implies accepting them — keep them
        // out of the requests area. Receipts/typing (suppressLocal) don't count.
        if (toUser.id !== session.user.id && isRequestContentKind(payload.kind)) {
          markAccepted(toUser.id);
        }
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
    [
      session.secretKey,
      session.user.id,
      rebuildDm,
      refreshPendingCount,
      blockedPeers,
      isRequestContentKind,
      markAccepted,
    ]
  );

  const commitForward = useCallback(async () => {
    const src = forwardTarget;
    if (!src) return;
    const dmPeerId = tab === "dm" && peer ? peer.id : null;
    if (forwardPick.size === 0) {
      setError(t("chat.errSelectContact"));
      return;
    }
    if (src.plain.kind !== "text" && src.plain.kind !== "file") {
      setError(t("chat.errForwardKind"));
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
        sent === 1
          ? t("chat.toastForwarded1")
          : t("chat.toastForwardedN", { n: sent }),
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
        if (!quiet) setError(t("chat.errNoConnection"));
        return null;
      }
      const p: PlainPayload = { ...payload, senderUserId: session.user.id };

      // Phase 5: auditiertes Megolm (Matrix.org) als einziger Group-Pfad.
      // 1) Distribution: für jeden noch-unbeschickten Member ein
      //    `megolm_session_key`-Frame über Olm-1:1.
      // 2) Eigentliche Nachricht via Megolm-Ratchet (VCG6).
      const distribution = await buildSessionKeyDistribution(g.id);
      // Geteiltes Gruppen-Geheimnis (GMK) auf der Verteilung mitschicken, falls
      // wir es haben — so erhalten alle Mitglieder den Schlüssel zum
      // Entschlüsseln der Gruppen-Metadaten (Name/Avatar). Nur der Ersteller
      // erzeugt es (createGroup); andere übernehmen es passiv (adoptGroupSecret).
      const gmk = await getGroupSecret(g.id).catch(() => null);
      const sent = megolmDistributedRef.current.get(g.id) ?? new Set<string>();
      const needed = g.memberIds.filter(
        (mid) => mid !== session.user.id && !sent.has(mid)
      );
      // DIAGNOSE: welche sessionId + welchen Ratchet-Index verteilen wir? Index
      // 0 = deckt die erste Nachricht ab. >0 = frühere Nachrichten gehen für
      // spät empfangende Mitglieder verloren.
      // eslint-disable-next-line no-console
      console.log("[vaultchat:megolm] dist", {
        groupId: g.id.slice(0, 8),
        sessionId: distribution.sessionId.slice(0, 12),
        idx: distribution.messageIndex,
        needed: needed.length,
      });
      if (needed.length > 0) {
        // Resolve member profiles. CRITICAL: a group member may NOT be in our
        // local contact list (usersRef) — e.g. they were added by someone else
        // and we never DM'd them. They STILL need our Megolm session key or they
        // cannot decrypt our messages. This was the root cause of "A's messages
        // reach B but not C" and "newly-added members see nothing": the old code
        // did `usersRef.find(...) ?? continue`, silently skipping any member who
        // wasn't already a local contact. Fetch the missing profiles instead.
        const profiles = new Map(usersRef.current.map((u) => [u.id, u]));
        const missing = needed.filter((id) => !profiles.has(id));
        if (missing.length > 0) {
          try {
            const { users: fetched } = await api.listUsers(
              session.token,
              missing
            );
            for (const u of fetched) profiles.set(u.id, u);
          } catch {
            /* best-effort — unresolved members are retried on the next send */
          }
        }
        for (const memberId of needed) {
          const member = profiles.get(memberId);
          // Profile still unresolved (server hiccup / not yet registered) — do
          // NOT mark as sent, so the next send retries the distribution.
          if (!member) continue;
          const keyPayload: PlainPayload = {
            v: 2,
            cid: newCid(),
            kind: "megolm_session_key",
            groupId: g.id,
            megolmSessionId: distribution.sessionId,
            megolmSessionKey: distribution.sessionKey,
            senderUserId: session.user.id,
            ...(gmk
              ? { groupSecretKey: gmk.keyB64, groupSecretEpoch: gmk.epoch }
              : {}),
          };
          // Best-effort + quiet: a member without an Olm bundle doesn't block
          // the group and must NOT pop a user-facing error toast.
          const res = await sendDmWire(member, keyPayload, true, true).catch(
            (err: unknown) => {
              // eslint-disable-next-line no-console
              console.debug("[vaultchat:megolm] dist_failed", {
                member: memberId.slice(0, 8),
                err: err instanceof Error ? err.message : String(err),
              });
              return null;
            }
          );
          // Only mark as distributed on ACTUAL success — otherwise retry on the
          // next send (Signal: sender-key distribution is idempotent + retried
          // on failure). sendDmWire returns null on failure (e.g. no Olm bundle)
          // WITHOUT throwing, so check the return value, not just the catch.
          if (res) sent.add(memberId);
        }
        megolmDistributedRef.current.set(g.id, sent);
      }
      const ciphertext = await megolmEncryptGroup(
        g.id,
        session.user.id,
        JSON.stringify(p)
      );

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
        // Eigene cid vormarkieren: im Sealed-Pfad (#26) verteilt der Server an
        // ALLE inkl. uns selbst — so wird das Echo der eigenen Nachricht per
        // Dedup verworfen statt doppelt angezeigt. (Im WS-Pfad ein No-op, da
        // der Server den Absender dort ausschließt.)
        if (p.cid) isGroupMessageDuplicate(g.id, p.cid);
      }
      // Sealed-Sender (#26, opt-in): Ciphertext OHNE Auth-Token über HTTP
      // senden → der Server lernt den Absender nicht. Standard bleibt der
      // (authentifizierte) WS-Pfad. Bei Sealed-Fehler Fallback auf WS.
      let sealedSent = false;
      try {
        if (localStorage.getItem("vaultchat.privacy.sealedGroup") === "on") {
          await api.sendSealedGroup(g.id, ciphertext);
          sealedSent = true;
        }
      } catch {
        sealedSent = false;
      }
      if (!sealedSent) {
        ws.send(JSON.stringify({ type: "group", groupId: g.id, ciphertext }));
      }
      coverRef.current?.markRealActivity();
      return tmpId;
    },
    [rebuildGroup, session.user.id, sendDmWire]
  );

  /**
   * Selbstheilung bei fehlendem Gruppen-Schlüssel (Matrix/Signal-Prinzip):
   * Können wir einen Gruppen-Cipher nicht entschlüsseln, weil uns die
   * Megolm-Inbound-Session des Absenders fehlt, fragen wir den Schlüssel
   * GEZIELT beim Absender an (der VCG6-Header trägt senderUuid+sessionId im
   * Klartext). Der Absender antwortet — nur wenn wir echtes Mitglied sind —
   * mit einem megolm_session_key-Frame; die gepufferten Cipher werden dann
   * automatisch erneut entschlüsselt. Gedrosselt (20s je Session), damit kein
   * Request-Sturm entsteht.
   */
  const requestMissingGroupKey = useCallback(
    async (groupId: string, cipherB64: string) => {
      const env = parseMegolmEnvelope(cipherB64);
      if (!env) return;
      const { senderUuid, sessionId } = env;
      if (!senderUuid || senderUuid === session.user.id) return;
      if (blockedPeersRef.current.has(senderUuid)) return;
      const throttleKey = `${groupId}:${sessionId}`;
      const now = Date.now();
      if (now - (keyRequestSentRef.current.get(throttleKey) ?? 0) < 20_000) {
        return;
      }
      keyRequestSentRef.current.set(throttleKey, now);
      let sender = usersRef.current.find((u) => u.id === senderUuid) ?? null;
      if (!sender) {
        try {
          const { users } = await api.listUsers(session.token, [senderUuid]);
          sender = users[0] ?? null;
        } catch {
          return;
        }
      }
      if (!sender) return;
      const reqPayload: PlainPayload = {
        v: 2,
        cid: newCid(),
        kind: "megolm_key_request",
        groupId,
        megolmSessionId: sessionId,
        senderUserId: session.user.id,
      };
      await sendDmWire(sender, reqPayload, true, true).catch(() => {});
    },
    [session.user.id, session.token, sendDmWire]
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
    let disposed = false;
    const url = getWsUrl();
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => {
      if (disposed) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        return;
      }
      const activeWs = wsRef.current;
      if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
      activeWs.send(JSON.stringify({ type: "auth", token: tokenRef.current }));
      setHasEverConnected(true);
      setWsHadError(false);
      setConnected(true);
      setReconnectAttempt(0);
      void flushOutbox().catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("local_key_missing")) {
          // ChatShell is being torn down (lock in flight); benign.
          return;
        }
        // eslint-disable-next-line no-console
        console.warn("[vaultchat] flushOutbox failed:", msg);
      });

      // Auf (Re)Connect Kontakte + Gruppen auffrischen: passiert offline eine
      // Mitgliedschaftsänderung (z.B. ein Mitglied wird einer Gruppe
      // hinzugefügt), verpassen wir das WS-Event. Ohne Refresh würden wir den
      // Gruppen-Schlüssel weiter an einen veralteten Member-Satz verteilen und
      // neue Mitglieder nie beschicken.
      void loadContacts().catch(() => {});
      void loadGroups().catch(() => {});

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
      if (disposed) return;
      // Auto-reconnect with exponential backoff (max 30 seconds)
      const attempts = reconnectAttempts.current;
      const delay = Math.min(1000 * Math.pow(2, attempts), 30000);
      reconnectAttempts.current = attempts + 1;
      setReconnectAttempt(attempts + 1);
      reconnectTimer.current = setTimeout(() => {
        if (disposed) return;
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
      setError(t("chat.errWebsocket"));
    };
    ws.onmessage = (ev) => {
      void (async () => {
        try {
          const data = JSON.parse(String(ev.data)) as Record<string, unknown>;

          // Offline-Mailbox quittieren: der Server hält geflushte Frames vor,
          // bis wir sie acken. Ohne Ack würde jeder Reconnect/Reload dieselben
          // Nachrichten erneut zustellen und der Server-Mailbox-Speicher bis
          // zum 7-Tage-TTL anwachsen. Wir acken beim Empfang (die Bytes sind
          // bereits da) für dm- und group-Frames inklusive Session-Keys.
          if (
            data.mailbox === true &&
            typeof data.id === "string" &&
            (data.type === "dm" || data.type === "group")
          ) {
            wsRef.current?.send(
              JSON.stringify({
                type: "mailbox_ack",
                kind: data.type === "group" ? "group" : "dm",
                id: data.id,
              })
            );
          }

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
            const payload = data.payload as RtcPayload;
            // While a group voice room is active, every rtc frame belongs to
            // its P2P mesh — route to the controller and skip the 1:1 path
            // (no incoming-call ring during a group call).
            if (groupCallCtrlRef.current) {
              await groupCallCtrlRef.current.onRtc(fromId, payload);
              return;
            }
            const u = usersRef.current.find((x) => x.id === fromId);
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
            const { groups: latestRaw } = await api.listGroups(session.token);
            const latest = await decryptGroupList(latestRaw);
            setGroups(latest);
            const updatedGroup = latest.find((x) => x.id === gid);
            if (
              updatedGroup &&
              updatedGroup.memberIds.includes(session.user.id)
            ) {
              // SECURITY (Signal-Sender-Keys-Modell): bei JEDER
              // Mitgliedschaftsänderung — auch beim Hinzufügen — rotiert JEDES
              // bestehende Mitglied seine Outbound-Session. So beginnt eine neue
              // Schlüssel-Epoche AB dem Beitrittspunkt; der gecachte Index-0-Key
              // ist dann der Beitrittspunkt → das neue Mitglied kann NUR ab
              // Beitritt lesen, nicht die History davor (strenge
              // Join-Forward-Secrecy wie bei Signal). Das neue Mitglied selbst
              // (newMemberId === self) rotiert nicht — es hat keine Vor-Epoche.
              if (newMemberId !== session.user.id) {
                try {
                  await rotateForMemberRemoval(updatedGroup.id);
                  megolmDistributedRef.current.delete(updatedGroup.id);
                } catch {
                  /* Olm not available — group send will surface the error */
                }
              }
              // Nur der Ersteller postet die System-Nachricht (sonst N-fach).
              if (
                updatedGroup.createdByUserId === session.user.id &&
                newMemberId &&
                newMemberId !== session.user.id
              ) {
                const memberLabel =
                  usersRef.current.find((u) => u.id === newMemberId)?.username ??
                  t("chat.memberFallback");
                await sendGroupSystemMessage(
                  updatedGroup,
                  t("chat.sysJoinedViaInvite", { member: memberLabel })
                );
              }
            }
            return;
          }
          if (
            data.type === "group_member_removed" &&
            typeof data.groupId === "string"
          ) {
            const gid = data.groupId;
            // Refresh the group list so the removed member disappears.
            const { groups: latestRaw } = await api.listGroups(session.token);
            const latest = await decryptGroupList(latestRaw);
            setGroups(latest);
            // SECURITY: forward secrecy on removal. The departed member still
            // holds every member's OLD Megolm key, so EVERY remaining member
            // (not just the creator) rotates their own outbound session and
            // clears the distribution marker — the next send re-distributes a
            // fresh key to the current member set only, excluding the removed
            // user.
            const updatedGroup = latest.find((x) => x.id === gid);
            if (
              updatedGroup &&
              updatedGroup.memberIds.includes(session.user.id)
            ) {
              try {
                await rotateForMemberRemoval(gid);
                megolmDistributedRef.current.delete(gid);
              } catch {
                /* Olm not available — next group send surfaces the error */
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
            if (
              plain.kind === "megolm_session_key" &&
              plain.groupId &&
              plain.megolmSessionId &&
              plain.megolmSessionKey
            ) {
              // Megolm-Inbound-Session aus dem 1:1-Olm-Channel aufbauen.
              try {
                const ing = await ingestSessionKey(
                  plain.groupId,
                  dec.senderUserId,
                  plain.megolmSessionKey
                );
                // DIAGNOSE: welche sessionId haben wir von wem übernommen?
                // eslint-disable-next-line no-console
                console.log("[vaultchat:megolm] ingest_ok", {
                  groupId: plain.groupId.slice(0, 8),
                  from: dec.senderUserId.slice(0, 8),
                  sessionId: ing.sessionId.slice(0, 12),
                });
              } catch (err) {
                // eslint-disable-next-line no-console
                console.debug("[vaultchat:megolm] ingest_failed", {
                  groupId: plain.groupId.slice(0, 8),
                  err: err instanceof Error ? err.message : String(err),
                });
                return;
              }
              // Geteiltes Gruppen-Geheimnis (GMK) übernehmen, falls mitgeschickt
              // — damit wir Gruppen-Metadaten (Name/Avatar) entschlüsseln können.
              if (
                typeof plain.groupSecretKey === "string" &&
                plain.groupSecretKey &&
                typeof plain.groupSecretEpoch === "number"
              ) {
                await adoptGroupSecret(
                  plain.groupId,
                  plain.groupSecretKey,
                  plain.groupSecretEpoch
                ).catch(() => {});
                // Gruppenliste neu aufbauen, damit ein bisher als Platzhalter
                // angezeigter verschlüsselter Name jetzt entschlüsselt erscheint.
                void loadGroups().catch(() => {});
              }
              // Pending VCG6-Cipher für diese Gruppe nochmal versuchen.
              const pending = pendingGroupCipherRef.current.get(plain.groupId);
              if (pending && pending.length > 0) {
                pendingGroupCipherRef.current.delete(plain.groupId);
                // Cipher, deren Key WEITERHIN fehlt (z.B. anderer Sender oder
                // eine andere Session-Generation als der gerade eingelöste Key),
                // dürfen NICHT verworfen werden — sie werden re-gepuffert und ihr
                // passender Key gezielt nachgefordert. Sonst gehen genau die
                // frühen Nachrichten verloren, deren Key zeitlich nach dem Cipher
                // ankommt (Ursache des "erste Nachricht fehlt"-Bugs nach Rotation
                // / bei mehreren parallelen Sendern).
                const stillPending: Array<{
                  id: string;
                  ciphertext: string;
                  createdAt: number;
                }> = [];
                for (const buf of pending) {
                  if (!isMegolmGroupCiphertext(buf.ciphertext)) {
                    // Nicht-Megolm bleiben dem alten Pfad überlassen.
                    stillPending.push(buf);
                    continue;
                  }
                  if (seen.current.has(buf.id)) continue; // schon angezeigt
                  try {
                    const r = await megolmDecryptGroup(plain.groupId, buf.ciphertext);
                    const retried = JSON.parse(r.plaintext) as PlainPayload;
                    if (!retried.senderUserId) retried.senderUserId = r.senderUuid;
                    if (
                      typeof retried.cid === "string" &&
                      retried.cid.length > 0 &&
                      isGroupMessageDuplicate(plain.groupId, retried.cid)
                    ) {
                      continue;
                    }
                    seen.current.add(buf.id);
                    const fromUid = retried.senderUserId ?? "";
                    // Ephemeral voice coordination — route, never store.
                    if (retried.kind === "voice_announce" && retried.voiceKind) {
                      handleVoiceAnnounce(
                        plain.groupId,
                        fromUid,
                        retried.voiceKind,
                        buf.createdAt || Date.now()
                      );
                      continue;
                    }
                    await idbPutGroupMsg({
                      id: buf.id,
                      groupId: plain.groupId,
                      fromUserId: fromUid,
                      plainJson: JSON.stringify(retried),
                      at: buf.createdAt,
                      ...(retried.ttlMs
                        ? { expiresAt: buf.createdAt + retried.ttlMs }
                        : {}),
                    });
                    const arr = rawGroupRef.current.get(plain.groupId) ?? [];
                    if (arr.some((x) => x.id === buf.id)) continue;
                    arr.push({
                      id: buf.id,
                      fromMe: false,
                      fromUserId: fromUid,
                      plainJson: JSON.stringify(retried),
                      at: buf.createdAt,
                      ...(retried.ttlMs
                        ? { expiresAt: buf.createdAt + retried.ttlMs }
                        : {}),
                    });
                    rawGroupRef.current.set(plain.groupId, arr);
                    setGroupRev((x) => x + 1);
                    if (groupRef.current?.id === plain.groupId) {
                      rebuildGroup(plain.groupId);
                    }
                  } catch {
                    // Key dieser sessionId fehlt noch → NICHT verwerfen.
                    stillPending.push(buf);
                  }
                }
                if (stillPending.length > 0) {
                  // Re-puffern (Cap beibehalten) — ggf. mit Ciphern mischen, die
                  // während der awaits oben frisch eingetroffen sind.
                  const merged =
                    pendingGroupCipherRef.current.get(plain.groupId) ?? [];
                  for (const b of stillPending) {
                    if (merged.length >= 256) break;
                    if (!merged.some((x) => x.id === b.id)) merged.push(b);
                  }
                  pendingGroupCipherRef.current.set(plain.groupId, merged);
                  // Für jede noch fehlende Session genau EINEN gezielten
                  // Key-Request feuern (selbst gedrosselt, 20s je Session).
                  const askedSessions = new Set<string>();
                  for (const b of stillPending) {
                    const env = parseMegolmEnvelope(b.ciphertext);
                    if (env && !askedSessions.has(env.sessionId)) {
                      askedSessions.add(env.sessionId);
                      void requestMissingGroupKey(plain.groupId, b.ciphertext);
                    }
                  }
                }
              }
              return;
            }
            // Phase 5: legacy `group_key`-DMs (eigene v2-Group-Crypto) werden
            // ignoriert. Megolm hat ihre Funktion mit der Session-Key-
            // Distribution oben übernommen.
            if (plain.kind === "group_key") {
              return;
            }
            // Selbstheilung (Antwort-Seite): ein Mitglied bittet um UNSEREN
            // Megolm-Session-Key, weil es einen unserer Gruppen-Cipher nicht
            // entschlüsseln konnte. SICHERHEIT: nur antworten, wenn der
            // Anfragende ECHTES aktuelles Mitglied der Gruppe ist (sonst
            // Key-Leak an Nicht-Mitglieder). Gedrosselt (10s je Anfragender).
            if (
              plain.kind === "megolm_key_request" &&
              plain.groupId &&
              plain.megolmSessionId
            ) {
              const requesterId = dec.senderUserId;
              const grp = groupsRef.current.find((x) => x.id === plain.groupId);
              if (!grp || !grp.memberIds.includes(requesterId)) return;
              const sk = `${requesterId}:${plain.groupId}`;
              const now = Date.now();
              if (now - (keyRequestServedRef.current.get(sk) ?? 0) < 10_000) {
                return;
              }
              keyRequestServedRef.current.set(sk, now);
              try {
                const dist = await buildSessionKeyDistribution(plain.groupId);
                const keyPayload: PlainPayload = {
                  v: 2,
                  cid: newCid(),
                  kind: "megolm_session_key",
                  groupId: plain.groupId,
                  megolmSessionId: dist.sessionId,
                  megolmSessionKey: dist.sessionKey,
                  senderUserId: session.user.id,
                };
                await sendDmWire(peerUser, keyPayload, true, true).catch(
                  () => {}
                );
                const set =
                  megolmDistributedRef.current.get(plain.groupId) ??
                  new Set<string>();
                set.add(requesterId);
                megolmDistributedRef.current.set(plain.groupId, set);
              } catch {
                /* Olm/Megolm nicht verfügbar — best effort */
              }
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
            // Durable dedup: a re-delivered mailbox frame (older than the
            // replay window, or after the in-session `seen` set was reset on
            // a chat switch) must not be appended twice. The ack above
            // already fired, so returning here is safe.
            if (arr.some((x) => x.id === id)) return;
            arr.push({
              id,
              fromMe: false,
              plainJson: JSON.stringify(plain),
              at: createdAt,
              ...(ttl ? { expiresAt: createdAt + ttl } : {}),
            });
            rawDmRef.current.set(peerUser.id, arr);
            setDmRev((x) => x + 1);
            if (peerRef.current?.id === peerUser.id) {
              rebuildDm(peerUser.id);
              // Seen live in the open chat: advance the read marker past this
              // message. Use max(now, createdAt) so it stays in the same clock
              // domain as the stored `at` (a server/peer clock ahead of ours
              // would otherwise resurrect a just-read message as unread on
              // reload) while remaining monotonic against re-delivered frames.
              void metaSet(
                `seen:dm:${peerUser.id}`,
                String(Math.max(Date.now(), createdAt))
              ).catch(() => {});
            }

            // Message request gate: a real message from a sender we haven't
            // accepted (and haven't blocked) surfaces in the requests area,
            // not the main chat list. Group-key/receipt/typing frames don't
            // count — only user-visible content does. Until the one-time
            // migration has seeded existing contacts as accepted, treat every
            // sender as accepted so an established contact can't be transiently
            // mislabeled as a request (and have its receipt suppressed) in the
            // brief window before migration commits.
            const migrated =
              localStorage.getItem("vaultchat.requests.migrated") === "1";
            const treatAsAccepted =
              !migrated || acceptedPeersRef.current.has(peerUser.id);
            const isUnacceptedSender =
              !treatAsAccepted && !blockedPeersRef.current.has(peerUser.id);
            if (isUnacceptedSender && isRequestContentKind(plain.kind)) {
              addRequestPeer(peerUser.id);
            }

            // Update unread (if chat not currently open).
            if (peerRef.current?.id !== peerUser.id) {
              if (!mutedPeers.has(peerUser.id)) {
                maybeNotify(
                  peerUser.username,
                  isUnacceptedSender
                    ? t("requests.notif")
                    : previewForPayload(plain)
                );
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

            // Privacy: do NOT auto-acknowledge (read/delivered) to a sender we
            // haven't accepted — that would confirm activity to a stranger.
            // (Pre-migration, treatAsAccepted is true so established contacts
            // still get their receipts.)
            if (
              sendReadReceipts &&
              plain.kind !== "receipt" &&
              plain.cid &&
              treatAsAccepted
            ) {
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
              // Phase 5: nur Megolm (VCG6). Andere Magic = Verwerfen.
              if (!isMegolmGroupCiphertext(ct)) {
                throw new Error("non_megolm_group_dropped");
              }
              const r = await megolmDecryptGroup(gid, ct);
              plain = JSON.parse(r.plaintext) as PlainPayload;
              if (!plain.senderUserId) plain.senderUserId = r.senderUuid;
            } catch {
              // DIAGNOSE: warum konnten wir nicht entschlüsseln? Loggt den
              // (Klartext-)VCG6-Header des Ciphers — senderUuid + sessionId —
              // damit man sieht, ob uns der Key dieser sessionId fehlt.
              // eslint-disable-next-line no-console
              console.log("[vaultchat:megolm] decrypt_miss", {
                groupId: gid.slice(0, 8),
                env: parseMegolmEnvelope(ct),
              });
              // Buffer this ciphertext: der passende Session-Key
              // (megolm_session_key oder group_key) ist evtl. noch nicht
              // angekommen. Wird beim Eintreffen erneut verarbeitet.
              const buf = pendingGroupCipherRef.current.get(gid) ?? [];
              if (buf.length < 256) {
                buf.push({ id, ciphertext: ct, createdAt: Number(data.createdAt) || Date.now() });
                pendingGroupCipherRef.current.set(gid, buf);
              }
              // Selbstheilung: Schlüssel gezielt beim Absender anfragen, statt
              // nur passiv zu puffern und auf den nächsten Send zu hoffen.
              void requestMissingGroupKey(gid, ct);
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
            // Voice-room coordination is ephemeral: hand it to the group-call
            // layer and never persist or render it as a message.
            if (plain.kind === "voice_announce" && plain.voiceKind) {
              handleVoiceAnnounce(gid, fromUserId, plain.voiceKind, at || Date.now());
              return;
            }
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
            // Durable dedup against re-delivered mailbox frames (see DM path).
            if (arr.some((x) => x.id === id)) return;
            arr.push({
              id,
              fromMe: fromUserId === session.user.id,
              fromUserId,
              plainJson: JSON.stringify(plain),
              at,
              ...(ttl ? { expiresAt: at + ttl } : {}),
            });
            rawGroupRef.current.set(gid, arr);
            setGroupRev((x) => x + 1);
            const isGroupContent =
              fromUserId !== session.user.id &&
              (plain.kind === "text" ||
                plain.kind === "file" ||
                plain.kind === "voice" ||
                plain.kind === "poll" ||
                plain.kind === "system");
            if (groupRef.current?.id === gid) {
              rebuildGroup(gid);
              // Seen live: advance the read marker (same clock domain as `at`).
              void metaSet(
                `seen:group:${gid}`,
                String(Math.max(Date.now(), at))
              ).catch(() => {});
            } else if (isGroupContent) {
              void (async () => {
                const seenRaw = await metaGet(`seen:group:${gid}`).catch(
                  () => null
                );
                const seenAt = seenRaw ? Number(seenRaw) || 0 : 0;
                if (at > seenAt) {
                  setUnreadByGroup((m) => ({
                    ...m,
                    [gid]: (m[gid] ?? 0) + 1,
                  }));
                }
              })();
            }
            // @mention: notify the mentioned user even if the group is muted
            // (Discord behaviour). Word-boundary, case-insensitive match on
            // the decrypted body — the mention lives inside the E2EE payload.
            const myName = session.user.username;
            const mentioned =
              plain.kind === "text" &&
              typeof plain.body === "string" &&
              new RegExp(
                `@${myName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`,
                "i"
              ).test(plain.body);
            if (
              groupRef.current?.id !== gid &&
              (!mutedGroups.has(gid) || mentioned)
            ) {
              const groupName = groupsRef.current.find((x) => x.id === gid)?.name ?? t("chat.groupFallback");
              maybeNotify(
                mentioned ? `${groupName} · Erwähnung` : groupName,
                previewForPayload(plain)
              );
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
      // Re-Heal: für Gruppen mit weiterhin unentschlüsselbaren Ciphern den
      // fehlenden Megolm-Key erneut beim Absender anfragen. Deckt den Fall ab,
      // dass sowohl die initiale Distribution als auch der erste Self-Heal-
      // Request scheiterten (z.B. Absender war offline) und der Absender nicht
      // erneut sendet — ohne diesen Tick bliebe die frühe Nachricht für immer
      // im Puffer. `requestMissingGroupKey` ist intern auf 20s/Session
      // gedrosselt, daher kein Request-Sturm.
      for (const [gid, bufs] of pendingGroupCipherRef.current) {
        const asked = new Set<string>();
        for (const b of bufs) {
          const env = parseMegolmEnvelope(b.ciphertext);
          if (env && !asked.has(env.sessionId)) {
            asked.add(env.sessionId);
            void requestMissingGroupKey(gid, b.ciphertext);
          }
        }
      }
    }, 15_000);

    // Fast-Reconnect: wenn der Tab wieder sichtbar wird oder das Netz
    // online ist, kürzen wir den exponential-backoff. Mobile pausiert
    // Hintergrund-Tabs aggressiv — ohne diesen Hook braucht ein wieder-
    // sichtbarer Tab bis zu 30s, bis der nächste Backoff-Tick reconnectet.
    const triggerFastReconnect = (reason: string) => {
      if (disposed) return;
      if (wsRef.current?.readyState === WebSocket.OPEN) return;
      if (!reconnectTimer.current) return;
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
      reconnectAttempts.current = 0;
      setReconnectAttempt(0);
      // eslint-disable-next-line no-console
      console.debug("[vaultchat:ws] fast_reconnect", { reason });
      // Trigger sofortige Reconnect via close→re-open Pattern. ws.onclose
      // wäre der reguläre Pfad — wir schedulen aber direkt für den nächsten
      // Tick statt 1s exponential-backoff.
      reconnectTimer.current = setTimeout(() => {
        if (disposed) return;
        const newWs = new WebSocket(getWsUrl());
        wsRef.current = newWs;
        newWs.onopen = ws.onopen;
        newWs.onclose = ws.onclose;
        newWs.onerror = ws.onerror;
        newWs.onmessage = ws.onmessage;
      }, 50);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") triggerFastReconnect("visible");
    };
    const onOnline = () => triggerFastReconnect("online");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      try {
        ws.close();
      } catch {
        /* socket already closing/closed */
      }
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

  /**
   * Guard every outbound DM path against a SILENT key change. If the peer's
   * identity key changed (TOFU "mismatch") and the user hasn't re-verified,
   * we refuse to send — otherwise an attacker who swapped the key could read
   * the message. Returns false (and surfaces an error) when blocked.
   */
  function ensurePeerKeyTrusted(): boolean {
    if (!peer) return false;
    if (peer.id !== session.user.id && peerPin?.state === "mismatch") {
      setError(t("chat.errKeyChanged"));
      return false;
    }
    return true;
  }

  async function sendDmText() {
    if (!peer || !text.trim()) return;
    if (!ensurePeerKeyTrusted()) return;
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
    if (peer.id === session.user.id) {
      await appendSelfMessage(payload);
    } else {
      await sendDmWire(peer, payload);
    }
    setText("");
    draftsRef.current.delete(peer.id);
    resetTextarea(dmInputRef.current);
    setReplyDm(null);
    setViewOnceDm(false);
  }

  async function sendDmFile(file: File) {
    if (!peer) return;
    if (!ensurePeerKeyTrusted()) return;
    /**
     * Ziel: echte Dateien bis ca. 128 MiB. Data-URL, JSON, Padding,
     * Double-Ratchet-Wire und Sealed-Sender-Envelope wachsen deutlich darüber;
     * der Serverrahmen ist deshalb standardmäßig auf 320 MiB gesetzt.
     */
    const maxFile = 128 * 1024 * 1024;
    if (file.size > maxFile) {
      setError(
        t("chat.errFileTooLarge", { mb: Math.floor(maxFile / (1024 * 1024)) })
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
    if (!ensurePeerKeyTrusted()) return;
    if (voice.recording) {
      const rec = await voice.stop();
      if (!rec) return;
      if (voice.consumeHitLimit()) {
        pushToast(t("chat.toastVoiceLimit"), "warning");
      }
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
      if (!ok) setError(t("chat.errMicDenied"));
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
    groupDraftsRef.current.delete(group.id);
    resetTextarea(groupInputRef.current);
    setReplyGroup(null);
    setViewOnceGroup(false);
  }

  async function sendGroupFile(file: File) {
    if (!group) return;
    const maxFile = 128 * 1024 * 1024;
    if (file.size > maxFile) {
      setError(
        t("chat.errFileTooLarge", { mb: Math.floor(maxFile / (1024 * 1024)) })
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
      if (groupVoice.consumeHitLimit()) {
        pushToast(t("chat.toastVoiceLimit"), "warning");
      }
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
      if (!ok) setError(t("chat.errMicDenied"));
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

  /**
   * Durably purge a just-revealed view-once message from IndexedDB without
   * touching the rendered list — the in-memory copy stays visible for the
   * short reveal countdown, but it can no longer be resurrected by a reload.
   */
  async function purgeRevealedViewOnceDm(m: ChatMsg) {
    await idbDeleteDm(m.id).catch(() => {});
  }
  async function purgeRevealedViewOnceGroup(m: ChatMsg) {
    await idbDeleteGroupMsg(m.id).catch(() => {});
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

  function copyText(text: string) {
    if (!text) return;
    void navigator.clipboard
      ?.writeText(text)
      .then(() => pushToast(t("common.copied"), "success"))
      .catch(() => pushToast(t("common.copyFailed"), "danger"));
  }

  // Phase 5: distributeGroupKey/rotateGroupKey sind entfernt — Megolm
  // verteilt seinen Session-Key über Olm-1:1-DMs im sendGroupWire-Pfad
  // und rotiert via rotateForMemberRemoval bei Membership-Wechseln.

  async function createGroup() {
    if (!newGroupName.trim() || newGroupMembers.length === 0) {
      setError(t("chat.errGroupNameMembers"));
      return;
    }
    setError(null);
    const memberIds = [...new Set([...newGroupMembers, session.user.id])];
    const memberLimit = getLimits().groupMemberMax;
    if (memberIds.length > memberLimit) {
      setError(
        t("chat.errGroupTooLarge", { n: memberIds.length, limit: memberLimit })
      );
      return;
    }
    const description = newGroupDescription.trim();
    const realName = newGroupName.trim();
    // Phase 1: Gruppe mit Platzhalter-Namen anlegen (Server sieht den echten
    // Namen NIE), dann GMK erzeugen, Namen verschlüsseln und als Ciphertext
    // nachreichen. Worst case (Krypto-Hiccup): Fallback auf Klartext-Name.
    // Server bekommt NIE Klartext: mit Platzhalter-Namen anlegen (ohne
    // Beschreibung/Avatar im Klartext), dann GMK erzeugen und Name +
    // Beschreibung + Avatar verschlüsselt nachreichen.
    const { group: g } = await api.createGroup(session.token, {
      name: GROUP_NAME_PLACEHOLDER,
      memberIds,
    });
    try {
      await ensureGroupSecret(g.id);
      const encName = await encryptGroupMeta(g.id, realName);
      const encDesc = description
        ? await encryptGroupMeta(g.id, description)
        : null;
      const encAvatar = newGroupAvatar
        ? await encryptGroupMeta(g.id, newGroupAvatar)
        : null;
      await api.updateGroupProfile(session.token, g.id, {
        name: encName ?? realName,
        ...(description ? { description: encDesc ?? description } : {}),
        ...(newGroupAvatar ? { avatar: encAvatar ?? newGroupAvatar } : {}),
      });
    } catch {
      // Krypto-Hiccup → Klartext-Fallback, damit die Gruppe nutzbar bleibt.
      await api
        .updateGroupProfile(session.token, g.id, {
          name: realName,
          ...(description ? { description } : {}),
          ...(newGroupAvatar ? { avatar: newGroupAvatar } : {}),
        })
        .catch(() => {});
    }
    // Bootstrap: "Gruppe erstellt"-Systemnachricht verteilt GMK + Megolm-Key
    // sofort an alle initialen Mitglieder — so sehen sie den echten Namen/
    // Avatar (statt Platzhalter) ohne auf die erste echte Nachricht zu warten.
    await sendGroupSystemMessage(
      g,
      t("chat.sysGroupCreated", { user: session.user.username })
    ).catch(() => {});
    await loadGroups();
    setNewGroupName("");
    setNewGroupMembers([]);
    setNewGroupDescription("");
    setNewGroupAvatar("");
    // Lokal Klartext anzeigen (Server hat nur Platzhalter+Ciphertext).
    setGroup({
      ...g,
      name: realName,
      ...(description ? { description } : {}),
      ...(newGroupAvatar ? { avatar: newGroupAvatar } : {}),
    });
    setTab("group");
    await loadGroups();
  }

  async function sendDmPoll() {
    if (!peer || !pollDm) return;
    const question = pollDm.question.trim();
    const options = pollDm.options.map((o) => o.trim()).filter(Boolean);
    if (!question || options.length < 2) {
      setError(t("chat.errPollNeed"));
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
      setError(t("chat.errPollNeed"));
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
        pushToast(t("chat.toastInviteCreatedCopied"), "success");
      } catch {
        pushToast(t("chat.toastInviteCreated"), "success");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "create_failed";
      pushToast(t("chat.toastInviteCreateFailed", { msg }), "danger");
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
      pushToast(t("chat.toastInviteRevokeFailed", { msg }), "danger");
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
        const { groups: latestRaw } = await api.listGroups(session.token);
        const latest = await decryptGroupList(latestRaw);
        setGroups(latest);
        const target = latest.find((g) => g.id === groupId);
        if (target) {
          setTab("group");
          setPeer(null);
          setGroup(target);
          pushToast(
            t("chat.toastJoinedGroup", { name: target.name }),
            "success"
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "join_failed";
        const friendly =
          msg === "expired"
            ? t("chat.errInviteExpired")
            : msg === "exhausted"
              ? t("chat.errInviteExhausted")
              : msg === "already_member"
                ? t("chat.errAlreadyMember")
                : msg === "unknown_token"
                  ? t("chat.errInviteInvalid")
                  : t("chat.errJoinFailed", { msg });
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
      pushToast(t("chat.errGroupNameEmpty"), "danger");
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
      // Name + Beschreibung + Avatar verschlüsseln (GMETA1) — der Server
      // speichert nur Ciphertext. Fallback auf Klartext, falls (noch) kein GMK.
      const encName = await encryptGroupMeta(group.id, trimmedName).catch(
        () => null
      );
      const encDesc = trimmedDesc
        ? await encryptGroupMeta(group.id, trimmedDesc).catch(() => null)
        : null;
      let avatarToSend = avatarUpdate;
      if (avatarUpdate && avatarUpdate !== "") {
        const encAv = await encryptGroupMeta(group.id, avatarUpdate).catch(
          () => null
        );
        avatarToSend = encAv ?? avatarUpdate;
      }
      const { group: updated } = await api.updateGroupProfile(
        session.token,
        group.id,
        {
          name: encName ?? trimmedName,
          description: trimmedDesc ? encDesc ?? trimmedDesc : "",
          ...(avatarUpdate !== undefined ? { avatar: avatarToSend } : {}),
        }
      );
      // Lokal Klartext anzeigen (Server hat nur Ciphertext). Bei UNVERÄNDERTEM
      // Avatar den bisherigen lokalen Klartext behalten — `updated.avatar` wäre
      // sonst der GMETA1-Ciphertext (kaputtes Bild).
      setGroup((prev) =>
        prev && prev.id === updated.id
          ? {
              ...updated,
              name: trimmedName,
              description: trimmedDesc || undefined,
              avatar:
                avatarUpdate !== undefined
                  ? avatarUpdate || undefined
                  : prev.avatar,
            }
          : prev
      );
      await loadGroups();
      setGroupEditMode(false);
      setGroupEditAvatar("");
      setGroupEditAvatarRemoved(false);
      pushToast(t("chat.toastGroupUpdated"), "success");
      const changes: string[] = [];
      if (previousName !== trimmedName) {
        changes.push(t("chat.sysChangeName", { name: trimmedName }));
      }
      if (previousDesc !== trimmedDesc) {
        changes.push(
          trimmedDesc ? t("chat.sysChangeDesc") : t("chat.sysChangeDescRemoved")
        );
      }
      if (avatarUpdate !== undefined) {
        const newAvatarPresent = avatarUpdate !== "";
        if (previousAvatar !== newAvatarPresent) {
          changes.push(
            newAvatarPresent
              ? t("chat.sysChangeImage")
              : t("chat.sysChangeImageRemoved")
          );
        } else if (newAvatarPresent) {
          changes.push(t("chat.sysChangeImage"));
        }
      }
      if (changes.length > 0) {
        await sendGroupSystemMessage(
          updated,
          t("chat.sysChanged", {
            user: session.user.username,
            what: changes.join(` ${t("chat.and")} `),
          })
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown_error";
      pushToast(
        msg === "cannot_update"
          ? t("chat.errCannotUpdateGroup")
          : t("chat.errGroupUpdateFailed", { msg }),
        "danger"
      );
    } finally {
      setGroupEditBusy(false);
    }
  }

  async function addMember() {
    if (!group || !addMemberId) return;
    const memberLabel =
      users.find((u) => u.id === addMemberId)?.username ?? t("chat.memberFallback");
    try {
      const { group: g2 } = await api.addGroupMember(
        session.token,
        group.id,
        addMemberId
      );
      setGroup(g2);
      await loadGroups();
      // Megolm-Rotation: neue Outbound + Distribution-Tracking leeren,
      // damit der neue Key an alle (auch neue Mitglieder) verteilt wird.
      await rotateForMemberRemoval(g2.id);
      megolmDistributedRef.current.delete(g2.id);
      setAddMemberId("");
      await sendGroupSystemMessage(
        g2,
        t("chat.sysMemberAdded", {
          user: session.user.username,
          member: memberLabel,
        })
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "add_failed");
    }
  }

  async function removeMember(memberId: string) {
    if (!group) return;
    const memberLabel =
      users.find((u) => u.id === memberId)?.username ?? t("chat.memberFallback");
    try {
      const { group: g2 } = await api.removeGroupMember(
        session.token,
        group.id,
        memberId
      );
      setGroup(g2);
      await loadGroups();
      // Megolm-Rotation: ZWINGEND nach member-removal, damit der entfernte
      // User keine zukünftigen Frames mehr lesen kann.
      await rotateForMemberRemoval(g2.id);
      megolmDistributedRef.current.delete(g2.id);
      await sendGroupSystemMessage(
        g2,
        t("chat.sysMemberRemoved", {
          user: session.user.username,
          member: memberLabel,
        })
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
        t("chat.sysLeft", { user: session.user.username })
      );
      await api.leaveGroup(session.token, group.id);
      setGroup(null);
      await loadGroups();
    } catch (e) {
      setError(e instanceof Error ? e.message : "leave_failed");
    }
  }

  // ── Group voice room (Discord-style, P2P mesh) ──────────────────────────

  /** Apply an inbound voice announce: maintain the passive occupancy set and,
   *  if we're in this group's call, hand it to the mesh controller. */
  function handleVoiceAnnounce(
    gid: string,
    fromUserId: string,
    kind: VoiceAnnounce["kind"],
    at: number
  ) {
    if (!fromUserId || fromUserId === session.user.id) return;
    let set = voiceRoomsRef.current.get(gid);
    if (!set) {
      set = new Set<string>();
      voiceRoomsRef.current.set(gid, set);
    }
    if (kind === "voice_leave") set.delete(fromUserId);
    else set.add(fromUserId); // join or present
    setVoiceOccupants((prev) => ({ ...prev, [gid]: set!.size }));
    // Discord-style presence feedback for the group you're viewing or in.
    // "present" acks are silent (they'd flood toasts on your own join).
    if (
      (kind === "voice_join" || kind === "voice_leave") &&
      (groupRef.current?.id === gid || groupCallGroupIdRef.current === gid)
    ) {
      const name =
        usersRef.current.find((u) => u.id === fromUserId)?.username ?? t("chat.someone");
      pushToast(
        kind === "voice_join"
          ? t("chat.toastVoiceJoined", { name })
          : t("chat.toastVoiceLeft", { name })
      );
    }
    if (groupCallCtrlRef.current && groupCallGroupIdRef.current === gid) {
      // All union members share one shape; cast is safe.
      groupCallCtrlRef.current.onAnnounce({ kind, from: fromUserId, at } as VoiceAnnounce);
    }
  }

  async function joinGroupVoice() {
    const g = group;
    if (!g || groupCallCtrlRef.current) return;
    try {
      const ctrl = await GroupCallController.start(
        g.id,
        session.user.id,
        session.user.username,
        tokenRef.current,
        relayOnly,
        {
          onState: (s) => setGroupCallState(s),
          sendRtc: (toUserId, payload) => sendRtc(toUserId, payload),
          sendAnnounce: (msg) => {
            // Ephemeral coordination over the E2EE group channel — never
            // stored locally (suppressLocal) and silent on failure (quiet).
            void sendGroupWire(
              g,
              {
                v: 2,
                cid: newCid(),
                kind: "voice_announce",
                voiceKind: msg.kind,
              },
              true,
              true
            );
          },
          resolveUser: (uid) => {
            const u = usersRef.current.find((x) => x.id === uid);
            return u ? { id: u.id, username: u.username } : null;
          },
        }
      );
      groupCallCtrlRef.current = ctrl;
      groupCallGroupIdRef.current = g.id;
    } catch (e) {
      setError(
        e instanceof Error && e.message
          ? e.message
          : t("chat.errMicUnavailable")
      );
    }
  }

  function leaveGroupVoice() {
    const ctrl = groupCallCtrlRef.current;
    if (ctrl) ctrl.leave();
    groupCallCtrlRef.current = null;
    groupCallGroupIdRef.current = null;
    setGroupCallState(null);
  }

  function toggleGroupVoiceMute() {
    const ctrl = groupCallCtrlRef.current;
    if (ctrl) ctrl.setMuted(!ctrl.isMuted());
  }

  function toggleGroupScreenShare() {
    const ctrl = groupCallCtrlRef.current;
    if (!ctrl) return;
    if (ctrl.isScreenSharing()) ctrl.stopScreenShare();
    else void ctrl.startScreenShare();
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
      author: m.fromMe ? t("chat.you") : peer?.username ?? t("chat.peerFallback"),
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
      preview: lookup.get(cid) ?? t("pinned.message"),
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
  }, [messages.length, users.length, peer?.id, dmRev]);

  const lastGroupPreviewByGroup = useMemo(() => {
    const out = new Map<
      string,
      { text: string; at: number; fromMe: boolean; author: string }
    >();
    for (const [gid, msgs] of rawGroupRef.current.entries()) {
      const last = [...msgs].reverse().find((r) => {
        try {
          const p = JSON.parse(r.plainJson) as PlainPayload;
          return (
            p.kind === "text" ||
            p.kind === "file" ||
            p.kind === "voice" ||
            p.kind === "poll" ||
            p.kind === "system"
          );
        } catch {
          return false;
        }
      });
      if (!last) continue;
      let text = "";
      try {
        text = previewForPayload(JSON.parse(last.plainJson) as PlainPayload);
      } catch {
        text = "";
      }
      const fromMe = last.fromUserId === session.user.id;
      const author = fromMe
        ? t("chat.you")
        : usersRef.current.find((u) => u.id === last.fromUserId)?.username ??
          t("chat.memberFallback");
      out.set(gid, { text, at: last.at, fromMe, author });
    }
    return out;
  }, [groupMessages.length, groups.length, group?.id, groupRev, session.user.id]);

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
  }, [starredCids, messages.length, users.length, dmRev]);

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

  // Pending message requests: unknown senders we haven't accepted or blocked.
  const requestPeerIds = useMemo(() => {
    const out = new Set<string>();
    for (const id of requestPeers) {
      if (!acceptedPeers.has(id) && !blockedPeers.has(id)) out.add(id);
    }
    return out;
  }, [requestPeers, acceptedPeers, blockedPeers]);

  const requestUsers = useMemo(
    () =>
      [...filteredUsers.filter((u) => requestPeerIds.has(u.id))].sort((a, b) => {
        const ta = lastDmPreviewByPeer.get(a.id)?.at ?? 0;
        const tb = lastDmPreviewByPeer.get(b.id)?.at ?? 0;
        return tb - ta;
      }),
    [filteredUsers, requestPeerIds, lastDmPreviewByPeer]
  );

  // Flat list for the central "Blocked contacts" manager. Names resolve from
  // the live contact list first, then the persisted name cache, then a
  // truncated id as last resort.
  const blockedContacts = useMemo(
    () =>
      Array.from(blockedPeers)
        .map((id) => ({
          id,
          username:
            users.find((u) => u.id === id)?.username ??
            blockedNames[id] ??
            id.slice(0, 8),
        }))
        .sort((a, b) => a.username.localeCompare(b.username)),
    [blockedPeers, users, blockedNames]
  );

  const visibleUsers = useMemo(() => {
    let arr: api.ApiUser[];
    if (sidebarFilter === "group") return [];
    if (sidebarFilter === "requests") {
      arr = filteredUsers.filter((u) => requestPeerIds.has(u.id));
    } else if (sidebarFilter === "fav") {
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
    // Outside the requests view, pending requests never pollute the list.
    if (sidebarFilter !== "requests") {
      arr = arr.filter((u) => !requestPeerIds.has(u.id));
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
    requestPeerIds,
  ]);

  const visibleGroups = useMemo(() => {
    if (
      sidebarFilter === "dm" ||
      sidebarFilter === "fav" ||
      sidebarFilter === "requests"
    )
      return [];
    let arr: api.ApiGroup[];
    if (sidebarFilter === "unread") {
      arr = filteredGroups.filter((g) => (unreadByGroup[g.id] ?? 0) > 0);
    } else if (sidebarFilter === "star") {
      arr = filteredGroups.filter((g) => groupsWithStars.has(g.id));
    } else if (activeFolder) {
      const keys = new Set(activeFolder.chatKeys);
      arr = filteredGroups.filter((g) => keys.has(`group:${g.id}`));
    } else {
      arr = filteredGroups;
    }
    return [...arr].sort((a, b) => {
      const ta = lastGroupPreviewByGroup.get(a.id)?.at ?? a.createdAt ?? 0;
      const tb = lastGroupPreviewByGroup.get(b.id)?.at ?? b.createdAt ?? 0;
      return tb - ta;
    });
  }, [
    filteredGroups,
    sidebarFilter,
    groupsWithStars,
    activeFolder,
    unreadByGroup,
    lastGroupPreviewByGroup,
  ]);

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
                name: plain.fileName ?? t("chat.fileFallback"),
                href: safeMediaSrc(plain.body, "file") || "#",
                at: row.at,
              },
            ];
          }
          if (plain.kind === "voice") {
            return [
              {
                id: row.id,
                kind: "voice" as const,
                name: t("chat.voiceMessage"),
                href: safeMediaSrc(plain.body, "audio") || "#",
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
      const isReq = requestPeerIds.has(u.id);
      // Privacy: never surface a not-yet-accepted sender's message text in the
      // list — it could be abusive/unsolicited. Show a neutral prompt instead.
      const subtitle = isReq
        ? t("requests.previewHidden")
        : peer?.id === u.id && typing
          ? t("chat.typing")
          : prev
            ? prev.fromMe
              ? t("chat.selfPreview", { text: prev.text })
              : prev.text
            : t("chat.noMessages");
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
          isRequest={isReq}
          blurAvatar={isReq}
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
    requestPeerIds,
    togglePinPeer,
    fmtListTime,
  ]);

  const groupList = useMemo(
    () =>
      visibleGroups.map((g) => {
        const gTyping = groupTypingMap.get(g.id);
        const showGTyping = Boolean(gTyping && gTyping.size > 0);
        const gPrev = lastGroupPreviewByGroup.get(g.id);
        const gUnread = unreadByGroup[g.id] ?? 0;
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
            {safeMediaSrc(g.avatar, "image") ? (
              <img
                src={safeMediaSrc(g.avatar, "image")}
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
                    {t("chat.typing")}
                  </span>
                ) : gPrev ? (
                  `${gPrev.author}: ${gPrev.text}`
                ) : (
                  t("chat.memberCount", { n: g.memberIds.length })
                )}
              </p>
            </div>
            <div className="contact-meta">
              <span className="contact-time">{fmtListTime(gPrev?.at)}</span>
              {gUnread > 0 ? (
                <span className="unread-badge">
                  {gUnread > 99 ? "99+" : gUnread}
                </span>
              ) : null}
            </div>
          </button>
        );
      }),
    [
      visibleGroups,
      group,
      tab,
      groupTypingMap,
      lastGroupPreviewByGroup,
      unreadByGroup,
      fmtListTime,
    ]
  );

  return (
    <div className="flex h-full w-full flex-col bg-[var(--bg)] p-0 md:p-4">
      {notifyPromptOpen && (
        <div className="notify-prompt-banner" role="status">
          <span className="notify-prompt-icon" aria-hidden>
            <IconBell size={16} />
          </span>
          <div className="notify-prompt-text">
            <strong>{t("chat.enableNotifsTitle")}</strong>
            <span>{t("chat.notifHint")}</span>
          </div>
          <div className="notify-prompt-actions">
            <button
              type="button"
              className="btn btn-secondary !px-3 !py-1 !text-xs"
              onClick={handleDismissNotifyPrompt}
            >
              {t("chat.notifLater")}
            </button>
            <button
              type="button"
              className="btn btn-primary !px-3 !py-1 !text-xs"
              onClick={() => void handleEnableNotifications()}
            >
              {t("chat.notifAllow")}
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
          blockedContacts={blockedContacts}
          onUnblockContact={unblockPeer}
          onExportBackup={async () => {
            const local = loadLocalIdentity();
            if (!local) return;
            const passphrase = window.prompt(
              t("chat.backupPassPrompt")
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
            pushToast(t("chat.toastBackupDownloaded"), "success");
          }}
        />
      )}
      {forwardTarget && (
        <div
          className="u-modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => {
            setForwardTarget(null);
            setForwardPick(new Set());
          }}
        >
          <div
            className="app-surface u-modal-card w-full max-w-md rounded-2xl p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between gap-2">
              <h2 className="text-lg font-semibold" style={{ color: "var(--text)" }}>
                Weiterleiten
              </h2>
              <button
                type="button"
                className="rounded-lg p-1 hover:bg-[var(--bg-hover)]"
                aria-label={t("common.close")}
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
              {t("chat.forwardPickTitle")}
            </p>
            <div
              className="max-h-56 space-y-1 overflow-y-auto rounded-lg border p-2"
              style={{ borderColor: "var(--border)" }}
            >
              {users.filter((u) => !blockedPeers.has(u.id)).length === 0 ? (
                <p className="py-4 text-center text-sm" style={{ color: "var(--text-muted)" }}>
                  {t("chat.noContactsAvail")}
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
      <div className="app-surface u-shell flex min-h-0 w-full flex-1 flex-col overflow-visible rounded-2xl md:rounded-3xl">
      {!connected && (
        <div
          className={`connection-banner shrink-0 rounded-t-2xl md:rounded-t-3xl${wsHadError ? " error" : ""}`}
          role="status"
        >
          <IconWifiOff size={15} aria-hidden />
          <span>
            {hasEverConnected
              ? t("chat.connLostBanner")
              : t("chat.connecting")}
          </span>
        </div>
      )}
      {backupReminderVisible && (
        <BackupReminder
          onExport={() => setSecurityOpen(true)}
          onDismiss={() => {
            try {
              localStorage.setItem("vaultchat.backupReminder.dismissed", "1");
            } catch {
              /* localStorage write may fail in private mode */
            }
            setBackupReminderVisible(false);
          }}
        />
      )}
      <div className="u-row flex min-h-0 flex-1 overflow-visible">
      <nav className="u-rail">
        <button
          type="button"
          className="u-rail-logo"
          title={t("chat.allChatsTitle")}
          aria-label={t("chat.allChats")}
          onClick={() => {
            setSidebarFilter("all");
            setTab("dm");
            setPeer(null);
            setGroup(null);
            setInfoOpen(false);
          }}
        >
          <VaultChatLogo size={32} style={{ color: "var(--accent)" }} />
        </button>
        <div className="u-rail-spacer" />
        <div className="u-rail-theme">
          <ThemeToggle />
        </div>
        <button
          type="button"
          className="u-rail-btn"
          title={`${t("nav.lock")} (Ctrl/⌘+L)`}
          aria-label={t("nav.lock")}
          onClick={onLock}
        >
          <IconLock size={20} />
        </button>
        <button
          type="button"
          className="u-rail-btn"
          title={t("nav.help")}
          aria-label={t("nav.help")}
          onClick={() => setShortcutsHelpOpen(true)}
        >
          <IconHelpCircle size={20} />
        </button>
        <button
          type="button"
          className="u-rail-btn"
          title={t("nav.settings")}
          aria-label={t("nav.settings")}
          onClick={() => setSecurityOpen(true)}
        >
          <IconSettings size={20} />
        </button>
        <button
          type="button"
          className="u-rail-avatar"
          title={t("nav.account")}
          aria-label={t("nav.account")}
          onClick={() => setUserMenuOpen((v) => !v)}
        >
          {session.user.username.slice(0, 1).toUpperCase()}
        </button>
      </nav>
      <aside
        className={`${
          showSidebar ? "flex" : "hidden"
        } u-panel u-panel-list w-full min-w-0 flex-col border-[var(--border)] bg-[var(--bg-sidebar)] md:flex md:w-84 md:min-w-[20rem] md:border-r`}
      >
        <div className="sidebar-header flex items-center justify-between !py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <h2 className="u-list-title">{t("nav.chats")}</h2>
            {!connected && (
              <span
                className={`sidebar-status-pill ${
                  reconnectAttempt > 0 ? "reconnecting" : "offline"
                }`}
                title={
                  reconnectAttempt > 0
                    ? `Reconnect-Versuch ${reconnectAttempt} — Server wacht evtl. gerade auf`
                    : t("chat.disconnected")
                }
                role="status"
                aria-live="polite"
              >
                <span className="sidebar-status-dot" aria-hidden />
                {reconnectAttempt > 0 ? t("chat.reconnecting") : t("chat.offline")}
              </span>
            )}
            {pendingCount > 0 && (
              <span
                className="sidebar-status-pending"
                title={t("chat.pendingDelivery", { n: pendingCount })}
              >
                {pendingCount}
              </span>
            )}
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => void refreshLists()}
              className={`u-header-icon-btn ${refreshing ? "animate-spin" : ""}`}
              title={t("nav.refresh")}
              aria-label={t("nav.refresh")}
            >
              <IconRefreshCw size={18} />
            </button>
            <button
              type="button"
              onClick={() => setShowAddContact(true)}
              className="u-header-icon-btn u-header-compose"
              title={t("nav.newChat")}
              aria-label={t("nav.newChat")}
            >
              <IconPlus size={20} />
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
              placeholder={t("search.placeholder")}
              className="w-full border-0 bg-transparent text-sm outline-none"
              style={{ color: "var(--text)" }}
              aria-label={t("chat.searchAria")}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="shrink-0 rounded-full p-0.5 transition hover:bg-[var(--bg-hover)]"
                style={{ color: "var(--text-muted)" }}
                aria-label={t("common.clearSearch")}
                title={t("chat.clearEsc")}
              >
                <IconX size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="filter-chips mx-3 mt-3">
          {(() => {
            const countChats = (r: Record<string, number>) =>
              Object.values(r).reduce((a, b) => a + (b > 0 ? 1 : 0), 0);
            const dmUnread = countChats(unreadByPeer);
            const groupUnread = countChats(unreadByGroup);
            const totalUnread = dmUnread + groupUnread;
            return [
              ["all", t("filter.all"), totalUnread],
              ["dm", t("filter.dms"), dmUnread],
              ["group", t("filter.groups"), groupUnread],
              ["fav", t("filter.favorites"), 0],
              ["unread", t("filter.unread"), totalUnread],
              ["star", t("filter.starred"), 0],
            ] as const;
          })().map(([value, label, badgeCount]) => (
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
              {(value === "unread" || value === "all") && badgeCount > 0 && (
                <span className="filter-chip-badge">{badgeCount}</span>
              )}
            </button>
          ))}
          {folders.map((f) => {
            const value: SidebarFilter = `folder:${f.id}`;
            const folderUnread = f.chatKeys.reduce((acc, key) => {
              if (!key.startsWith("dm:")) return acc;
              const peerId = key.slice(3);
              return acc + ((unreadByPeer[peerId] ?? 0) > 0 ? 1 : 0);
            }, 0);
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
                {folderUnread > 0 && (
                  <span className="filter-chip-badge">{folderUnread}</span>
                )}
              </button>
            );
          })}
          <button
            type="button"
            className="filter-chip filter-chip-add"
            onClick={() => setFoldersManageOpen(true)}
            title={t("folders.manage")}
            aria-label={t("folders.manage")}
          >
            <IconPlus size={12} />
            <span>{t("chat.foldersTab")}</span>
          </button>
        </div>

        {(sidebarFilter === "all" ||
          sidebarFilter === "dm" ||
          sidebarFilter === "unread" ||
          sidebarFilter === "star" ||
          sidebarFilter === "requests" ||
          activeFolder !== null) && (
          <>
            <div
              className={`overflow-y-auto p-2 ${
                sidebarFilter === "all" || sidebarFilter === "star"
                  ? "max-h-[42%]"
                  : "flex-1"
              }`}
            >
              {sidebarFilter === "requests" && (
                <button
                  type="button"
                  onClick={() => setSidebarFilter("all")}
                  className="contact-item w-full !mx-0"
                >
                  <div
                    className="contact-avatar !h-9 !w-9"
                    style={{ background: "var(--bg-hover)", color: "var(--text-secondary)" }}
                  >
                    ←
                  </div>
                  <div className="contact-info min-w-0">
                    <span className="contact-name">{t("requests.title")}</span>
                    <p className="contact-preview" style={{ color: "var(--text-muted)" }}>
                      {t("common.back")}
                    </p>
                  </div>
                </button>
              )}
              {(sidebarFilter === "all" || sidebarFilter === "dm") && (
                <button
                  type="button"
                  onClick={() => {
                    setTab("dm");
                    setGroup(null);
                    setPeer({
                      id: session.user.id,
                      username: t("chat.savedMessages"),
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
                    <span className="contact-name">{t("chat.savedMessages")}</span>
                    <p
                      className="contact-preview"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {t("chat.notesForYou")}
                    </p>
                  </div>
                </button>
              )}
              {(sidebarFilter === "all" || sidebarFilter === "dm") &&
                requestUsers.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSidebarFilter("requests")}
                    className="contact-item w-full !mx-0"
                  >
                    <div
                      className="contact-avatar !h-9 !w-9"
                      style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
                    >
                      <IconBell size={16} />
                    </div>
                    <div className="contact-info min-w-0">
                      <span className="contact-name">{t("requests.entry")}</span>
                      <p className="contact-preview" style={{ color: "var(--text-muted)" }}>
                        {t("requests.entrySub", { n: requestUsers.length })}
                      </p>
                    </div>
                    <div className="contact-meta">
                      <span className="unread-badge">
                        {requestUsers.length > 99 ? "99+" : requestUsers.length}
                      </span>
                    </div>
                  </button>
                )}
              {sidebarFilter === "requests" && requestUsers.length === 0 && (
                <p
                  className="px-3 py-6 text-center text-sm"
                  style={{ color: "var(--text-muted)" }}
                >
                  {t("requests.empty")}
                </p>
              )}
              {peerList}
              {query.trim().length > 0 &&
                visibleUsers.length === 0 &&
                visibleGroups.length === 0 &&
                sidebarFilter === "all" && (
                  <button
                    type="button"
                    className="u-search-add"
                    onClick={() => setShowAddContact(true)}
                  >
                    <span className="u-newchat-plus" aria-hidden>
                      +
                    </span>
                    {t("chat.noMatchAdd", { query: query.trim() })}
                  </button>
                )}
              {sidebarFilter === "star" &&
                visibleUsers.length === 0 &&
                visibleGroups.length > 0 && (
                  <p
                    className="px-2 py-4 text-center text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {t("chat.starredEmptyDm")}
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
                  {t("chat.favEmptyHint")}
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
                  title={t("group.pickAvatar")}
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
                        pushToast(t("chat.toastImageReadFailed"), "danger");
                      }
                    }}
                  />
                </label>
                <input
                  className="app-input flex-1 !py-2 text-sm"
                  placeholder={t("group.name")}
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  aria-label={t("group.name")}
                />
              </div>
              {newGroupAvatar && (
                <button
                  type="button"
                  className="text-xs underline"
                  style={{ color: "var(--text-muted)" }}
                  onClick={() => setNewGroupAvatar("")}
                >
                  {t("group.removeImage")}
                </button>
              )}
              <textarea
                className="app-input w-full !py-2 text-xs"
                placeholder={t("group.description")}
                value={newGroupDescription}
                onChange={(e) =>
                  setNewGroupDescription(e.target.value.slice(0, 280))
                }
                rows={2}
                aria-label={t("group.description")}
                style={{ resize: "none" }}
              />
              <div
                className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border p-1"
                style={{ borderColor: "var(--border)" }}
                role="group"
                aria-label={t("group.selectMembers")}
              >
                {users.length === 0 ? (
                  <p
                    className="py-3 text-center text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {t("group.noContacts")}
                  </p>
                ) : (
                  users.map((u) => {
                    const checked = newGroupMembers.includes(u.id);
                    return (
                      <label
                        key={u.id}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition hover:bg-[var(--bg-hover)]"
                        style={{
                          color: checked ? "var(--accent)" : "var(--text)",
                          background: checked ? "var(--accent-soft)" : "transparent",
                          fontWeight: checked ? 600 : 400,
                        }}
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
                  {t("group.selectedCount", { n: newGroupMembers.length })}
                </p>
              )}
              <button
                type="button"
                onClick={() => void createGroup()}
                disabled={!newGroupName.trim() || newGroupMembers.length === 0}
                className="btn btn-primary w-full"
              >
                {t("group.create")}
              </button>
            </div>
          </>
        )}

        {(sidebarFilter === "all" ||
          sidebarFilter === "group" ||
          sidebarFilter === "star" ||
          sidebarFilter === "unread" ||
          activeFolder !== null) && (
          <div className="flex-1 overflow-y-auto p-2">
            {(sidebarFilter === "all" ||
              sidebarFilter === "star" ||
              sidebarFilter === "unread" ||
              activeFolder !== null) &&
              visibleGroups.length > 0 && (
              <p className="px-2 pb-1 pt-2 text-[11px] font-semibold" style={{ color: "var(--text-muted)" }}>
                {t("chat.groups")}
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
                  {t("chat.starredEmpty")}
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
            className="min-w-0 flex-1 truncate text-left font-medium inline-flex items-center gap-1.5"
            style={{ color: "var(--text)" }}
            title={myFp ? `Fingerprint: ${myFp}` : t("chat.ownProfile")}
          >
            <span className="truncate">{session.user.username}</span>
            {isPro() && (
              <span className="user-tile-pro-badge" title={`${PLAN_LABELS[loadPlan()]}-Plan aktiv`}>
                {loadPlan() === "team" ? "Team" : "Pro"}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setShortcutsHelpOpen(true)}
            className="sidebar-footer-action"
            title={t("nav.help")}
            aria-label={t("nav.help")}
          >
            <IconHelpCircle size={16} />
          </button>
          <button
            type="button"
            onClick={() => setSecurityOpen(true)}
            className="sidebar-footer-action"
            title={t("nav.settings")}
          >
            <IconSettings size={16} />
          </button>
          <button
            type="button"
            onClick={() => setUserMenuOpen((v) => !v)}
            className="sidebar-footer-action"
            title={t("chat.more")}
          >
            <IconMoreVertical size={16} />
          </button>
          {userMenuOpen && (
            <div className="user-menu">
              {!isPro() && (
                <button
                  type="button"
                  className="chat-menu-item user-menu-upgrade"
                  onClick={() => {
                    setUserMenuOpen(false);
                    setSecurityOpen(true);
                    // SecuritySettings will land on the last-active tab;
                    // user can click Plan & Abo from the tab list.
                  }}
                >
                  ✨ Pro werden — mehr Limits
                </button>
              )}
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
                className="chat-menu-item"
                onClick={async () => {
                  setUserMenuOpen(false);
                  const local = loadLocalIdentity();
                  if (!local) return;
                  const passphrase = window.prompt(
                    t("chat.backupPassPrompt")
                  );
                  if (!passphrase) return;
                  try {
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
                      localStorage.setItem(
                        "vaultchat.backupReminder.dismissed",
                        "1"
                      );
                    } catch {
                      /* ignore */
                    }
                    setBackupReminderVisible(false);
                    pushToast(t("chat.toastBackupDownloaded"), "success");
                  } catch {
                    pushToast(t("chat.toastBackupFailed"), "danger");
                  }
                }}
              >
                <IconDownload size={16} /> Backup exportieren
              </button>
              <button
                type="button"
                className="chat-menu-item"
                onClick={() => {
                  setUserMenuOpen(false);
                  void copyText(session.user.id);
                }}
              >
                <IconCopy size={16} /> Eigene ID kopieren
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
        } u-panel u-panel-chat min-h-0 min-w-0 flex-1 flex-col border-[var(--border)] bg-[var(--bg-chat)] md:flex md:border-0 h-full`}
      >
        {incomingOffer && (
          <div
            className="flex items-center justify-between border-b px-4 py-2 text-sm"
            style={{
              borderColor: "var(--border)",
              background: "var(--bg-elevated)",
              color: "var(--text)",
            }}
          >
            <span>{t("chat.callFrom", { name: incomingOffer.from.username })}</span>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-lg px-3 py-1 font-medium"
                style={{ background: "var(--success)", color: "white" }}
                onClick={() => void acceptIncoming()}
              >
                Annehmen
              </button>
              <button
                type="button"
                className="rounded-lg px-3 py-1"
                style={{ background: "var(--bg-hover)", color: "var(--text-secondary)" }}
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
              {relayOnly ? (
                <span style={{ color: "var(--success)" }}> · IP geschützt (Relay)</span>
              ) : (
                <span
                  style={{ color: "var(--warning)" }}
                  title={t("chat.relayWarning")}
                >
                  {" "}· IP für Gegenseite sichtbar
                </span>
              )}
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
                <div
                  className={`h-full transition-all duration-500 ${connected ? 'w-0 opacity-0' : 'w-1/2 animate-pulse'}`}
                  style={connected ? undefined : { background: 'var(--warning)' }}
                />
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
                      title={t("common.back")}
                      aria-label={t("common.back")}
                    >
                      ←
                    </button>
                  )}
                  <button
                    type="button"
                    className="header-identity"
                    onClick={() => setInfoOpen((v) => !v)}
                    title={t("chat.openProfile")}
                  >
                    <div className="header-avatar-wrap">
                      <div
                        className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-semibold text-white shadow-md${
                          requestPeerIds.has(peer.id) ? " avatar-blurred" : ""
                        }`}
                        style={{
                          background:
                            peer.id === session.user.id
                              ? "var(--accent)"
                              : userGradient(peer.id),
                        }}
                        aria-label={
                          requestPeerIds.has(peer.id)
                            ? t("requests.unknownSender")
                            : undefined
                        }
                      >
                        {peer.id === session.user.id ? (
                          <IconBookmark size={16} />
                        ) : (
                          peer.username.slice(0, 1).toUpperCase()
                        )}
                      </div>
                      {peer.id !== session.user.id &&
                        !requestPeerIds.has(peer.id) && (
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
                          {t("chat.notesForYou")}
                        </p>
                      ) : typing ? (
                        <p className="header-status typing">
                          <span className="typing-indicator">
                            <span></span>
                            <span></span>
                            <span></span>
                          </span>
                          {t("chat.typing")}
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
                            ? t("chat.online")
                            : connected
                              ? t("chat.lastSeenRecently")
                              : t("chat.offline")}
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
                      title={t("chat.call")}
                    >
                      <IconPhone size={18} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setInfoOpen((v) => !v)}
                    className={`btn btn-secondary btn-icon !h-9 !w-9 ${infoOpen ? "!border-[var(--accent)] !bg-[var(--accent-soft)] !text-[var(--accent)]" : ""}`}
                    title={t("chat.info")}
                  >
                    <IconInfo size={18} />
                  </button>
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setDmMenuOpen((v) => !v)}
                      className="btn btn-secondary btn-icon !h-9 !w-9"
                      title={t("chat.more")}
                    >
                      <IconMoreVertical size={18} />
                    </button>
                    {dmMenuOpen && (
                      <div className="chat-menu">
                        <label className="chat-menu-item cursor-default">
                          <span>{t("settings.disappearing")}</span>
                          <select
                            value={ttlDm}
                            onChange={(e) => void onChangeTtlDm(Number(e.target.value))}
                            className="chat-menu-select"
                            title={t("settings.disappearing")}
                          >
                            {TTL_OPTIONS.map((o) => (
                              <option key={o.ms} value={o.ms}>{t(o.labelKey)}</option>
                            ))}
                          </select>
                        </label>
                        <button type="button" className="chat-menu-item" onClick={() => { setDmMenuOpen(false); setSafetyOpen(true); }}>
                          <IconShieldCheck size={16} /> {t("chat.showSafetyNumber")}
                        </button>
                        <button type="button" className="chat-menu-item" onClick={() => { setDmMenuOpen(false); setInfoOpen(true); }}>
                          <IconFileText size={16} /> {t("chat.mediaFiles")}
                        </button>
                        {peer.id !== session.user.id && (
                          <button
                            type="button"
                            className="chat-menu-item"
                            onClick={() => {
                              setMutedPeers((prev) => {
                                const next = new Set(prev);
                                if (next.has(peer.id)) next.delete(peer.id);
                                else next.add(peer.id);
                                saveStringSet("vaultchat.muted.peers", next);
                                return next;
                              });
                              setDmMenuOpen(false);
                            }}
                          >
                            <IconVolumeMute size={16} />
                            {mutedPeers.has(peer.id)
                              ? t("chat.unmuteContact")
                              : t("chat.muteContact")}
                          </button>
                        )}
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
                          <IconPin size={16} /> {favoritePeers.has(peer.id) ? t("chat.unfavorite") : t("chat.favorite")}
                        </button>
                        <button type="button" className="chat-menu-item" onClick={() => { setDmMenuOpen(false); setSearchOpen(true); }}>
                          <IconSearch size={16} /> {t("chat.searchInConvo")}
                        </button>
                        {peer.id !== session.user.id && (
                          <button
                            type="button"
                            className="chat-menu-item"
                            onClick={() => {
                              setDmMenuOpen(false);
                              markChatUnread(peer);
                            }}
                          >
                            <IconBell size={16} /> {t("chat.markUnread")}
                          </button>
                        )}
                        <button
                          type="button"
                          className="chat-menu-item danger"
                          onClick={() => {
                            if (!blockedPeers.has(peer.id)) {
                              rememberBlockedName(peer.id, peer.username);
                            }
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
                          {blockedPeers.has(peer.id) ? t("chat.unblock") : t("chat.block")}
                        </button>
                        <button type="button" className="chat-menu-item" onClick={() => { setDmMenuOpen(false); setInfoOpen(true); }}>
                          <IconInfo size={16} /> {t("chat.infoProfile")}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {peerPin?.state === "mismatch" && (
                <div
                  className="mt-2 rounded-lg px-3 py-2 text-xs"
                  style={{
                    border: "1px solid var(--danger)",
                    background: "var(--danger-soft)",
                    color: "var(--danger)",
                  }}
                >
                  {t("chat.mismatchBanner")}
                </div>
              )}
              {blockedPeers.has(peer.id) && (
                <div
                  className="mt-2 rounded-lg px-3 py-2 text-xs"
                  style={{
                    border: "1px solid var(--warning)",
                    background: "var(--danger-soft)",
                    color: "var(--warning)",
                  }}
                >
                  {t("chat.contactBlockedBanner")}
                </div>
              )}
            </header>

            <div
              ref={dmScrollRef}
              role="log"
              aria-label={`Direktnachrichten mit ${peer.username}`}
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
                <div className="absolute inset-0 z-50 flex items-center justify-center rounded-lg bg-[var(--accent-soft)] backdrop-blur-sm border-2 border-dashed border-[var(--accent)] m-2">
                  <div className="text-center">
                    <p className="text-2xl mb-2">📎</p>
                    <p className="text-sm font-medium" style={{ color: "var(--accent)" }}>{t("chat.dropFiles")}</p>
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
                  aria-label={t("chat.scrollToBottom")}
                  title={t("chat.scrollToBottom")}
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
                    {t("chat.e2eeWith", { name: peer.username })}
                    {peerPin?.state !== "verified" && t("chat.verifyHint")}
                  </span>
                </div>
              )}
              {requestPeerIds.has(peer.id) && (
                <div className="request-notice" key="request-notice">
                  <IconBell size={14} />
                  <span>{t("requests.convNotice")}</span>
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
                        ? t("pinned.indexed", {
                            i: dmBannerIdx + 1,
                            n: pinnedDmList.length,
                          })
                        : t("pinned.label")}
                    </span>
                    <span className="pinned-banner-text">
                      {pinnedDmBanner.preview}
                    </span>
                  </span>
                </button>
              )}
              {(() => {
                const dmThreadCounts = new Map<string, number>();
                const dmThreadUnread = new Map<string, number>();
                for (const m of messages) {
                  const pCid = m.plain.threadParentCid;
                  if (pCid) {
                    dmThreadCounts.set(pCid, (dmThreadCounts.get(pCid) ?? 0) + 1);
                    const seenAt = threadSeen[pCid] ?? 0;
                    if (m.at > seenAt && !m.fromMe) {
                      dmThreadUnread.set(pCid, (dmThreadUnread.get(pCid) ?? 0) + 1);
                    }
                  }
                }
                const mainDmMsgs = messages.filter(
                  (m) => !m.plain.threadParentCid
                );
                if (mainDmMsgs.length === 0) {
                  const isSelf = peer.id === session.user.id;
                  return (
                    <div className="conversation-blank" key="dm-blank">
                      <span className="conversation-blank-icon" aria-hidden>
                        <IconShieldCheck size={26} />
                      </span>
                      <p className="conversation-blank-title">
                        {isSelf ? t("chat.savedNotes") : peer.username}
                      </p>
                      <p className="conversation-blank-text">
                        {isSelf
                          ? t("chat.selfNotesDesc")
                          : t("chat.firstMessage")}
                      </p>
                    </div>
                  );
                }
                const dividerAt = dmUnreadDividerAtRef.current;
                const dividerCap = dmUnreadDividerCapRef.current;
                const unreadDividerIdx =
                  dividerAt > 0
                    ? mainDmMsgs.findIndex(
                        (m) =>
                          m.at > dividerAt && m.at <= dividerCap && !m.fromMe
                      )
                    : -1;
                return mainDmMsgs.flatMap((m, i) => {
                const items: JSX.Element[] = [];
                if (
                  i === 0 ||
                  new Date(m.at).toDateString() !==
                    new Date(mainDmMsgs[i - 1].at).toDateString()
                ) {
                  items.push(
                    <div key={`date-${m.id}`} className="date-separator">
                      <span>{fmtDateLabel(m.at)}</span>
                    </div>
                  );
                }
                if (i === unreadDividerIdx) {
                  items.push(
                    <div key={`unread-${m.id}`} className="unread-divider">
                      <span>{t("chat.newMessages")}</span>
                    </div>
                  );
                }
                items.push(
                  <MessageBubble
                    key={m.plain.cid ?? m.id}
                    msg={m}
                    isGrouped={
                      i > 0 &&
                      mainDmMsgs[i - 1].fromMe === m.fromMe &&
                      m.at - mainDmMsgs[i - 1].at < MSG_GROUP_WINDOW_MS
                    }
                    isLastInGroup={
                      i === mainDmMsgs.length - 1 ||
                      mainDmMsgs[i + 1].fromMe !== m.fromMe ||
                      mainDmMsgs[i + 1].at - m.at >= MSG_GROUP_WINDOW_MS
                    }
                    threadReplyCount={
                      m.plain.cid ? dmThreadCounts.get(m.plain.cid) : undefined
                    }
                    threadUnreadCount={
                      m.plain.cid ? dmThreadUnread.get(m.plain.cid) : undefined
                    }
                    onOpenThread={(x) => {
                      if (x.plain.cid) setOpenThreadCid(x.plain.cid);
                    }}
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
                        author: x.fromMe ? t("chat.you") : peer.username,
                        text: previewForPayload(x.plain),
                        expiresAt: x.expiresAt,
                      })
                    }
                    onReact={(x, e) => void reactDm(x, e)}
                    onEdit={(x, body) => void editDm(x, body)}
                    onDelete={(x) => void deleteDm(x)}
                    onLocalDelete={(x) => void localDeleteDm(x)}
                    onReveal={(x) => void purgeRevealedViewOnceDm(x)}
                    onPollVote={(x, idx) => void votePollDm(x, idx)}
                    onCopy={copyText}
                    onForward={(x) => setForwardTarget(x)}
                    onJumpToCid={(cid) => jumpToCid(cid, dmScrollRef.current)}
                    onToggleStar={toggleStar}
                    onTogglePin={(x) => togglePinMessage(`dm:${peer.id}`, x)}
                  />
                );
                return items;
              });
              })()}
              {/* Typing-Indikator wird nun im Chat-Header angezeigt */}
            </div>

            {requestPeerIds.has(peer.id) ? (
              <footer className="chat-input-area !flex-col !items-stretch !pb-[calc(env(safe-area-inset-bottom,0px)+12px)] !pt-3">
                <div className="request-bar">
                  <p className="request-bar-title">
                    {t("requests.bannerTitle", { name: peer.username })}
                  </p>
                  <p className="request-bar-text">{t("requests.bannerText")}</p>
                  <div className="request-bar-actions">
                    <button
                      type="button"
                      className="btn btn-secondary !text-xs !text-[var(--danger)]"
                      onClick={() => blockRequestPeer(peer.id)}
                    >
                      {t("requests.block")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary !text-xs"
                      onClick={() => {
                        const id = peer.id;
                        void deleteRequestConversation(id);
                      }}
                    >
                      {t("requests.delete")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary !text-xs"
                      onClick={() => markAccepted(peer.id)}
                    >
                      {t("requests.accept")}
                    </button>
                  </div>
                </div>
              </footer>
            ) : (
            <footer className="chat-input-area !flex-wrap !pb-[calc(env(safe-area-inset-bottom,0px)+12px)] !pt-3">
              {error && (
                <p className="mb-2 text-sm" style={{ color: "var(--danger)" }}>
                  {error}
                </p>
              )}
              {pollDm && (
                <div className="poll-composer">
                  <p className="text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>
                    {t("poll.create")}
                  </p>
                  <input
                    className="app-input !py-1.5 text-sm"
                    placeholder={t("poll.question")}
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
                        placeholder={t("poll.option", { n: i + 1 })}
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
                          aria-label={t("poll.optionRemove", { n: i + 1 })}
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
                        {t("poll.addOption")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-secondary !px-2 !py-1 !text-xs"
                      onClick={() => setPollDm(null)}
                    >
                      {t("common.cancel")}
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
                      {t("common.send")}
                    </button>
                  </div>
                </div>
              )}
              {replyDm && (
                <div className="mb-2 flex items-center justify-between rounded-lg border-l-2 px-3 py-1 text-xs" style={{ borderColor: "var(--accent)", background: "var(--bg-elevated)", color: "var(--text-secondary)" }}>
                  <span>
                    <span style={{ color: "var(--accent)" }}>
                      {t("reply.to", { author: replyDm.author })}
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
                  aria-label={t("composer.emoji")}
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
                  title={t("composer.attach")}
                  aria-label={t("composer.attach")}
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
                <ComposerToolsMenu
                  viewOnce={viewOnceDm}
                  onToggleViewOnce={() => setViewOnceDm((v) => !v)}
                  pollActive={!!pollDm}
                  onTogglePoll={() =>
                    setPollDm((cur) =>
                      cur ? null : { question: "", options: ["", ""] }
                    )
                  }
                />
                <textarea
                  ref={dmInputRef}
                  className="chat-input-textarea"
                  aria-label={
                    peer && peer.id !== session.user.id
                      ? t("composer.toName", { name: peer.username })
                      : t("composer.note")
                  }
                  placeholder={
                    voice.recording
                      ? `${t("composer.recording")} ${formatElapsedMs(voice.elapsedMs)}`
                      : viewOnceDm
                        ? t("composer.viewOnce")
                        : peer && peer.id !== session.user.id
                          ? t("composer.toName", { name: peer.username })
                          : t("composer.note")
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
                    aria-label={t("common.send")}
                    title={t("common.send")}
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
                        aria-label={t("composer.discardRecording")}
                        title={t("composer.discardRecording")}
                      >
                        <IconX size={16} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void sendDmVoice()}
                      className={`btn-send${voice.recording ? " recording" : " mic"}`}
                      aria-label={voice.recording ? t("chat.sendRecording") : t("chat.recordVoice")}
                      title={voice.recording ? t("chat.sendRecording") : t("chat.recordVoice")}
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
            )}
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
                      title={t("common.back")}
                    >
                      ←
                    </button>
                  )}
                  {safeMediaSrc(group.avatar, "image") ? (
                    <img
                      src={safeMediaSrc(group.avatar, "image")}
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
                          users.find((u) => u.id === id)?.username ?? t("chat.memberFallback")
                      );
                      const label =
                        names.length === 1
                          ? t("chat.typingName", { name: names[0]! })
                          : names.length === 2
                            ? t("chat.typingTwo", { a: names[0]!, b: names[1]! })
                            : t("chat.typingMany", { n: String(names.length) });
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
                        {t("chat.groupE2eeInfo", { n: group.memberIds.length })}
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
                    title={t("group.members")}
                  >
                    <IconUsers size={18} />
                  </button>
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setGroupMenuOpen((v) => !v)}
                      className="btn btn-secondary btn-icon !h-9 !w-9"
                      title={t("chat.more")}
                    >
                      <IconMoreVertical size={18} />
                    </button>
                    {groupMenuOpen && (
                      <div className="chat-menu">
                        <label className="chat-menu-item cursor-default">
                          <span>{t("settings.disappearing")}</span>
                          <select
                            value={ttlGroup}
                            onChange={(e) => void onChangeTtlGroup(Number(e.target.value))}
                            className="chat-menu-select"
                            title={t("settings.disappearing")}
                          >
                            {TTL_OPTIONS.map((o) => (
                              <option key={o.ms} value={o.ms}>{t(o.labelKey)}</option>
                            ))}
                          </select>
                        </label>
                        <button type="button" className="chat-menu-item" onClick={() => { setGroupMenuOpen(false); setSearchOpen(true); }}>
                          <IconSearch size={16} /> {t("chat.searchInConvo")}
                        </button>
                        <button type="button" className="chat-menu-item" onClick={() => { setGroupMenuOpen(false); setGroupPanelOpen(true); }}>
                          <IconUsers size={16} /> {t("group.showMembers")}
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
                              title={t("chat.pickGroupImage")}
                            >
                              {(() => {
                                const showAvatar = groupEditAvatarRemoved
                                  ? null
                                  : groupEditAvatar ||
                                    safeMediaSrc(group.avatar, "image");
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
                                    pushToast(t("chat.toastImageReadFailed"), "danger");
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
                                {t("group.removeImage")}
                              </button>
                            )}
                          </div>
                          <input
                            className="app-input w-full !py-1 !text-xs"
                            value={groupEditName}
                            onChange={(e) => setGroupEditName(e.target.value)}
                            placeholder={t("group.name")}
                            maxLength={64}
                            aria-label={t("group.name")}
                          />
                          <textarea
                            className="app-input w-full !py-1 !text-xs"
                            value={groupEditDescription}
                            onChange={(e) =>
                              setGroupEditDescription(e.target.value.slice(0, 280))
                            }
                            placeholder={t("group.description")}
                            rows={2}
                            style={{ resize: "none" }}
                            aria-label={t("group.description")}
                          />
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setGroupEditMode(false)}
                              className="btn btn-secondary !px-2 !py-1 !text-[10px]"
                              disabled={groupEditBusy}
                            >
                              {t("common.cancel")}
                            </button>
                            <button
                              type="button"
                              onClick={() => void saveGroupProfile()}
                              className="btn btn-primary !px-2 !py-1 !text-[10px]"
                              disabled={groupEditBusy || !groupEditName.trim()}
                            >
                              {groupEditBusy ? "…" : t("common.save")}
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
                              {t("group.noDescription")}
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
                        {t("chat.inviteLinks")}
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
                                  aria-label={t("chat.inviteLinkAria")}
                                />
                                <button
                                  type="button"
                                  className="btn btn-secondary !px-1.5 !py-0.5 !text-[10px]"
                                  onClick={() =>
                                    void navigator.clipboard?.writeText(url).then(
                                      () =>
                                        pushToast(
                                          t("chat.linkCopied"),
                                          "success"
                                        )
                                    )
                                  }
                                  title={t("safety.copy")}
                                >
                                  {t("safety.copy")}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-danger !px-1.5 !py-0.5 !text-[10px]"
                                  onClick={() =>
                                    void handleRevokeInvite(inv.token)
                                  }
                                  title={
                                    expired
                                      ? t("chat.expired")
                                      : exhausted
                                        ? t("chat.exhausted")
                                        : t("chat.revoke")
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
                        {creatingInvite ? "…" : t("chat.newLink7d")}
                      </button>
                    </div>
                  )}
                  <ul className="mb-2 space-y-1">
                    {group.memberIds.map((mid) => {
                      const u = users.find((x) => x.id === mid);
                      const label = u?.username ?? (mid === session.user.id ? t("chat.you") : mid.slice(0, 8));
                      const isFounder =
                        Boolean(group.createdByUserId) &&
                        mid === group.createdByUserId;
                      const canManageMembers =
                        !group.createdByUserId ||
                        group.createdByUserId === session.user.id;
                      return (
                        <li key={mid} className="gmember-row">
                          <span
                            className="gmember-av"
                            style={{ background: userGradient(mid) }}
                            aria-hidden
                          >
                            {label.slice(0, 1).toUpperCase()}
                          </span>
                          <span className="gmember-name">{label}</span>
                          {isFounder ? (
                            <span className="gmember-role founder">
                              {t("group.founder")}
                            </span>
                          ) : mid === session.user.id ? (
                            <span className="gmember-role you">
                              {t("chat.you")}
                            </span>
                          ) : null}
                          {mid !== session.user.id && canManageMembers && (
                            <button
                              type="button"
                              onClick={() => void removeMember(mid)}
                              className="gmember-remove"
                              title={t("common.remove")}
                              aria-label={t("common.remove")}
                            >
                              <IconX size={15} />
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <div className="mt-2 flex gap-2">
                    <select
                      value={addMemberId}
                      onChange={(e) => setAddMemberId(e.target.value)}
                      className="app-input flex-1 !py-1.5 !text-xs"
                    >
                      <option value="">{t("group.pickMember")}</option>
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
                      className="btn btn-primary shrink-0 !px-3 !py-1.5 !text-xs disabled:opacity-40"
                    >
                      {t("common.add")}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => void leaveCurrentGroup()}
                    className="gmember-leave"
                  >
                    {t("group.leave")}
                  </button>
                </div>
              )}
            </header>
            <GroupCallBar
              state={
                groupCallState && groupCallGroupIdRef.current === group.id
                  ? groupCallState
                  : null
              }
              selfUserId={session.user.id}
              selfUsername={session.user.username}
              onJoin={() => void joinGroupVoice()}
              onLeave={leaveGroupVoice}
              onToggleMute={toggleGroupVoiceMute}
              onToggleScreenShare={toggleGroupScreenShare}
              occupants={voiceOccupants[group.id] ?? 0}
            />
            <div
              ref={groupScrollRef}
              role="log"
              aria-label={t("chat.groupChatAria", { name: group?.name ?? "" })}
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
                <div className="absolute inset-0 z-50 m-2 flex items-center justify-center rounded-lg border-2 border-dashed border-[var(--accent)] bg-[var(--accent-soft)] backdrop-blur-sm">
                  <div className="text-center">
                    <p className="mb-2 text-2xl">📎</p>
                    <p className="text-sm font-medium" style={{ color: "var(--accent)" }}>{t("chat.dropFilesGroup")}</p>
                  </div>
                </div>
              )}
              {groupMessages.length > 0 && (
                <div className="e2ee-hint" key="group-e2ee-hint">
                  <IconShieldCheck size={14} />
                  <span>{t("chat.e2eeGroup")}</span>
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
                        ? t("pinned.indexed", {
                            i: groupBannerIdx + 1,
                            n: pinnedGroupList.length,
                          })
                        : t("pinned.label")}
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
                  aria-label={t("chat.scrollToBottom")}
                  title={t("chat.scrollToBottom")}
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
                const threadUnread = new Map<string, number>();
                for (const m of groupMessages) {
                  const parentCid = m.plain.threadParentCid;
                  if (parentCid) {
                    threadCounts.set(parentCid, (threadCounts.get(parentCid) ?? 0) + 1);
                    const seenAt = threadSeen[parentCid] ?? 0;
                    if (m.at > seenAt && !m.fromMe) {
                      threadUnread.set(parentCid, (threadUnread.get(parentCid) ?? 0) + 1);
                    }
                  }
                }
                const mainMsgs = groupMessages.filter(
                  (m) => !m.plain.threadParentCid
                );
                const gDividerAt = groupUnreadDividerAtRef.current;
                const gDividerCap = groupUnreadDividerCapRef.current;
                const gUnreadDividerIdx =
                  gDividerAt > 0
                    ? mainMsgs.findIndex(
                        (m) =>
                          m.at > gDividerAt && m.at <= gDividerCap && !m.fromMe
                      )
                    : -1;
                return mainMsgs.flatMap((m, i) => {
                const items: JSX.Element[] = [];
                if (i === gUnreadDividerIdx) {
                  items.push(
                    <div key={`gunread-${m.id}`} className="unread-divider">
                      <span>{t("chat.newMessages")}</span>
                    </div>
                  );
                }
                items.push(
                <MessageBubble
                  key={m.plain.cid ?? m.id}
                  msg={m}
                  isGrouped={
                    i > 0 &&
                    mainMsgs[i - 1].fromUserId === m.fromUserId &&
                    mainMsgs[i - 1].fromMe === m.fromMe &&
                    m.at - mainMsgs[i - 1].at < MSG_GROUP_WINDOW_MS
                  }
                  isLastInGroup={
                    i === mainMsgs.length - 1 ||
                    mainMsgs[i + 1].fromUserId !== m.fromUserId ||
                    mainMsgs[i + 1].at - m.at >= MSG_GROUP_WINDOW_MS
                  }
                  threadReplyCount={
                    m.plain.cid ? threadCounts.get(m.plain.cid) : undefined
                  }
                  threadUnreadCount={
                    m.plain.cid ? threadUnread.get(m.plain.cid) : undefined
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
                  groupAvatar={
                    m.fromMe
                      ? undefined
                      : i > 0 &&
                          mainMsgs[i - 1].fromUserId === m.fromUserId &&
                          mainMsgs[i - 1].fromMe === m.fromMe
                        ? "space"
                        : "show"
                  }
                  groupReadTotal={Math.max(0, group.memberIds.length - 1)}
                  groupReadNames={(m.readByUserIds ?? [])
                    .map(
                      (uid) => users.find((u) => u.id === uid)?.username
                    )
                    .filter((n): n is string => Boolean(n))}
                  replyToPreview={replyPreviewForMessage(
                    groupMessages,
                    m,
                    users.find((u) => u.id === m.fromUserId)?.username ?? t("chat.memberFallback")
                  )}
                  onReply={(x) => {
                    const author = x.fromMe
                      ? t("chat.you")
                      : users.find((u) => u.id === x.fromUserId)?.username ?? t("chat.memberFallback");
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
                  onReveal={(x) => void purgeRevealedViewOnceGroup(x)}
                  onPollVote={(x, idx) => void votePollGroup(x, idx)}
                  onCopy={copyText}
                  onForward={(x) => setForwardTarget(x)}
                  onJumpToCid={(cid) => jumpToCid(cid, groupScrollRef.current)}
                  onToggleStar={toggleStar}
                  onTogglePin={(x) => togglePinMessage(`group:${group.id}`, x)}
                />
                );
                return items;
              });
              })()}
            </div>
            <footer className="chat-input-area !flex-wrap !pb-[calc(env(safe-area-inset-bottom,0px)+12px)] !pt-3">
              {error && (
                <p className="mb-2 text-sm" style={{ color: "var(--danger)" }}>
                  {error}
                </p>
              )}
              {pollGroup && (
                <div className="poll-composer">
                  <p className="text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>
                    {t("poll.create")}
                  </p>
                  <input
                    className="app-input !py-1.5 text-sm"
                    placeholder={t("poll.question")}
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
                        placeholder={t("poll.option", { n: i + 1 })}
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
                          aria-label={t("poll.optionRemove", { n: i + 1 })}
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
                        {t("poll.addOption")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-secondary !px-2 !py-1 !text-xs"
                      onClick={() => setPollGroup(null)}
                    >
                      {t("common.cancel")}
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
                      {t("common.send")}
                    </button>
                  </div>
                </div>
              )}
              {replyGroup && (
                <div className="mb-2 flex items-center justify-between rounded-lg border-l-2 px-3 py-1 text-xs" style={{ borderColor: "var(--accent)", background: "var(--bg-elevated)", color: "var(--text-secondary)" }}>
                  <span>
                    <span style={{ color: "var(--accent)" }}>
                      {t("reply.to", { author: replyGroup.author })}
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
                  aria-label={t("composer.emoji")}
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
                  title={t("composer.attach")}
                  aria-label={t("composer.attach")}
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
                <ComposerToolsMenu
                  viewOnce={viewOnceGroup}
                  onToggleViewOnce={() => setViewOnceGroup((v) => !v)}
                  pollActive={!!pollGroup}
                  onTogglePoll={() =>
                    setPollGroup((cur) =>
                      cur ? null : { question: "", options: ["", ""] }
                    )
                  }
                />
                <textarea
                  ref={groupInputRef}
                  className="chat-input-textarea"
                  aria-label={
                    group
                      ? t("composer.toName", { name: group.name })
                      : t("composer.group")
                  }
                  placeholder={
                    groupVoice.recording
                      ? `${t("composer.recording")} ${formatElapsedMs(groupVoice.elapsedMs)}`
                      : viewOnceGroup
                        ? t("composer.viewOnce")
                        : group
                          ? t("composer.toName", { name: group.name })
                          : t("composer.group")
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
                        // Must match the dropdown's filter exactly (incl. the
                        // self-exclusion + cap) or the highlighted index and
                        // the inserted pick disagree.
                        const candidates = users
                          .filter(
                            (u) =>
                              group.memberIds.includes(u.id) &&
                              u.id !== session.user.id &&
                              u.username
                                .toLowerCase()
                                .startsWith(mentionQuery.toLowerCase())
                          )
                          .slice(0, 6);
                        if (candidates.length === 0) {
                          setMentionOpen(false);
                        } else {
                        const pick = candidates[mentionIndex % candidates.length];
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
                    aria-label={t("common.send")}
                    title={t("common.send")}
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
                        aria-label={t("composer.discardRecording")}
                        title={t("composer.discardRecording")}
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
                          ? t("chat.sendRecording")
                          : t("chat.recordVoice")
                      }
                      title={
                        groupVoice.recording
                          ? t("chat.sendRecording")
                          : t("chat.recordVoice")
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

      {openThreadCid && (() => {
        const isGroupCtx = tab === "group" && !!group;
        const isDmCtx = tab === "dm" && !!peer;
        if (!isGroupCtx && !isDmCtx) return null;

        const allMsgs = isGroupCtx ? groupMessages : messages;
        const parent = allMsgs.find((m) => m.plain.cid === openThreadCid);
        if (!parent) return null;
        const replies = allMsgs.filter(
          (m) => m.plain.threadParentCid === openThreadCid
        );
        const resolveAuthor = isGroupCtx
          ? (m: ChatMsg) =>
              m.fromMe
                ? "Du"
                : users.find((u) => u.id === m.fromUserId)?.username ?? t("chat.memberFallback")
          : (m: ChatMsg) => (m.fromMe ? t("chat.you") : peer!.username);

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
              if (isGroupCtx) {
                await sendGroupWire(group!, payload);
              } else if (peer!.id === session.user.id) {
                await appendSelfMessage(payload);
              } else {
                await sendDmWire(peer!, payload);
              }
            }}
            onReact={(x, e) =>
              void (isGroupCtx ? reactGroup(x, e) : reactDm(x, e))
            }
            onEdit={(x, body) =>
              void (isGroupCtx ? editGroup(x, body) : editDm(x, body))
            }
            onDelete={(x) =>
              void (isGroupCtx ? deleteGroup(x) : deleteDm(x))
            }
            onLocalDelete={(x) =>
              void (isGroupCtx ? localDeleteGroupMsg(x) : localDeleteDm(x))
            }
            onCopy={copyText}
            onForward={(x) => setForwardTarget(x)}
            onJumpToCid={(cid) =>
              jumpToCid(
                cid,
                isGroupCtx ? groupScrollRef.current : dmScrollRef.current
              )
            }
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
              if (!blockedPeers.has(peer.id)) {
                rememberBlockedName(peer.id, peer.username);
              }
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
        <div className="u-modal-overlay fixed inset-0 z-50 bg-black/50 p-3" onClick={() => setInfoOpen(false)}>
          <div
            className="app-surface u-modal-sheet-right ml-auto h-full w-full max-w-sm overflow-y-auto rounded-2xl p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>{t("chat.details")}</p>
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
                if (!blockedPeers.has(peer.id)) {
                  rememberBlockedName(peer.id, peer.username);
                }
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
              {t("chat.groups")}
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
          // Adding a contact deliberately = accepting them.
          markAccepted(user.id);
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

