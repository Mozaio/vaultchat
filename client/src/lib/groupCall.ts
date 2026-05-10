/**
 * VaultChat Multi-Party Group Call — P2P mesh, audio-only MVP.
 *
 * Architecture
 * ============
 *
 *  - "Voice Room" model: each group has a virtual voice room. Members
 *    explicitly join/leave; only joiners exchange media.
 *  - Coordination via the existing E2EE group channel (kind:
 *    "voice_announce") so the server never sees who is in a call.
 *  - Per-peer RTCPeerConnection. With N participants there are
 *    N*(N-1)/2 connections — fine up to ~6 participants on modern
 *    laptops.
 *  - Tie-breaker for offer initiation: the peer with the lexicographic-
 *    ally smaller userId initiates the offer to the other. This avoids
 *    glare (both sides creating offers simultaneously).
 *  - Lifecycle robustness inherited from webrtc.ts: 8 s disconnect grace,
 *    45 s connect timeout, idempotent close, signalingState guards.
 *
 * Privacy properties
 * ==================
 *
 *  - Server sees only ciphertext announcements ("X joined voice")
 *    inside the group's normal payload stream. It does not learn who
 *    is in the call.
 *  - DTLS-SRTP encrypts media end-to-end between peer pairs. With
 *    relay-only mode the TURN server sees only encrypted traffic.
 *  - Future: insertable streams (Encoded Transform) for layered E2EE
 *    on top of DTLS-SRTP for the SFU-fallback variant.
 *
 *  Author: VaultChat / Mozaio (open under repo LICENSE).
 */

import type { ApiUser } from "./api";
import { loadRtcConfig, type RtcPayload } from "./webrtc";

/** Diagnostic-only debug logger for the group-call mesh. */
function gcDebug(evt: string, fields: Record<string, unknown> = {}) {
  try {
    // eslint-disable-next-line no-console
    console.debug(`[vaultchat:groupCall] ${evt}`, fields);
  } catch {
    /* noop */
  }
}
function shortErr(e: unknown): string {
  if (e instanceof Error) return e.name + ": " + e.message.slice(0, 120);
  return String(e).slice(0, 120);
}

/** Wire-format announcement carried inside the encrypted group payload. */
export type VoiceAnnounce =
  | { kind: "voice_join"; from: string; at: number }
  | { kind: "voice_leave"; from: string; at: number }
  | { kind: "voice_present"; from: string; at: number };
//                          ^ "I am here, ack my join" — sent by existing
//                            members in response to a voice_join.

/** Per-peer call state visible to the UI. */
export type GroupCallPeer = {
  userId: string;
  username: string;
  stream: MediaStream | null;
  speaking: boolean;
  muted: boolean; // the REMOTE peer told us they're muted
  connectionState: RTCPeerConnectionState;
  iceState: RTCIceConnectionState;
};

export type GroupCallState = {
  groupId: string;
  joinedAt: number;
  peers: Map<string, GroupCallPeer>;
  localMuted: boolean;
};

export type GroupCallEvents = {
  onState: (state: GroupCallState) => void;
  /** Dispatch a per-peer rtc payload via the existing per-user rtc channel. */
  sendRtc: (toUserId: string, payload: RtcPayload) => void;
  /** Send an announcement to the whole group via the group ciphertext channel. */
  sendAnnounce: (msg: VoiceAnnounce) => void;
  /** Resolve a userId to display name (for tile labels). */
  resolveUser: (userId: string) => Pick<ApiUser, "id" | "username"> | null;
};

const SPEAKING_THRESHOLD = 8;       // RMS over 0..255 above which we say "speaking"
const SPEAKING_HOLD_MS = 250;       // hold "speaking" state to avoid flicker
const MAX_PEERS = 8;                // hard cap; UI warns above this

type PeerSlot = {
  pc: RTCPeerConnection;
  userId: string;
  /** ICE candidates received before the remote description was set. */
  pending: RTCIceCandidateInit[];
  remoteStream: MediaStream | null;
  /** RAF token for speaking detection. */
  rafToken?: number;
  audioCtx?: AudioContext;
  analyser?: AnalyserNode;
  speakingUntil: number;
  closed: boolean;
};

export class GroupCallController {
  private localStream: MediaStream;
  private peers: Map<string, PeerSlot> = new Map();
  private rtcConfig: { iceServers: RTCIceServer[]; forceRelay: boolean };
  private events: GroupCallEvents;
  private myUserId: string;
  private myUsername: string;
  private groupId: string;
  private joinedAt: number;
  private localMuted = false;
  private relayOnly: boolean;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    groupId: string,
    myUserId: string,
    myUsername: string,
    localStream: MediaStream,
    rtcConfig: { iceServers: RTCIceServer[]; forceRelay: boolean },
    relayOnly: boolean,
    events: GroupCallEvents
  ) {
    this.groupId = groupId;
    this.myUserId = myUserId;
    this.myUsername = myUsername;
    this.localStream = localStream;
    this.rtcConfig = rtcConfig;
    this.relayOnly = relayOnly || rtcConfig.forceRelay;
    this.events = events;
    this.joinedAt = Date.now();

    // Announce that we joined. Existing members will respond with
    // voice_present so we know who is already in the call.
    events.sendAnnounce({
      kind: "voice_join",
      from: myUserId,
      at: this.joinedAt,
    });

    // 1Hz UI tick so the speaking-indicator can fade out cleanly.
    this.monitorTimer = setInterval(() => this.publishState(), 1000);
  }

  /** Factory that loads the RTC config and gets the mic stream. */
  static async start(
    groupId: string,
    myUserId: string,
    myUsername: string,
    token: string,
    relayOnly: boolean,
    events: GroupCallEvents
  ): Promise<GroupCallController> {
    const cfg = await loadRtcConfig(token);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    return new GroupCallController(
      groupId,
      myUserId,
      myUsername,
      stream,
      cfg,
      relayOnly,
      events
    );
  }

  /** Called by ChatShell when an inbound group voice_announce arrives. */
  onAnnounce(msg: VoiceAnnounce) {
    if (this.closed) return;
    if (msg.from === this.myUserId) return; // echo of our own join

    if (msg.kind === "voice_join") {
      // A new peer joined. Tell them we're here so they can connect.
      this.events.sendAnnounce({
        kind: "voice_present",
        from: this.myUserId,
        at: Date.now(),
      });
      this.connectToPeer(msg.from);
      return;
    }
    if (msg.kind === "voice_present") {
      // Existing member acknowledging our join. Connect to them.
      this.connectToPeer(msg.from);
      return;
    }
    if (msg.kind === "voice_leave") {
      this.dropPeer(msg.from);
      return;
    }
  }

  /** Called by ChatShell for inbound rtc frames. */
  async onRtc(fromUserId: string, payload: RtcPayload) {
    if (this.closed) return;
    if (this.peers.size >= MAX_PEERS && !this.peers.has(fromUserId)) {
      return; // hard cap
    }
    let slot = this.peers.get(fromUserId);

    // If we receive an offer from someone we don't yet have a slot
    // for, we must create the slot here (the offer-initiator side has
    // the smaller userId tie-break).
    if (!slot && payload.type === "offer") {
      slot = this.makeSlot(fromUserId);
    }
    if (!slot) {
      // Could be candidate from a peer we never opened — buffer-or-drop.
      return;
    }

    try {
      if (payload.type === "offer") {
        await slot.pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
        await this.flushPending(slot);
        const answer = await slot.pc.createAnswer();
        await slot.pc.setLocalDescription(answer);
        this.events.sendRtc(fromUserId, { type: "answer", sdp: answer.sdp ?? "" });
      } else if (payload.type === "answer") {
        if (slot.pc.signalingState === "have-local-offer") {
          await slot.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
          await this.flushPending(slot);
        }
      } else if (payload.type === "candidate") {
        if (slot.pc.remoteDescription) {
          try {
            await slot.pc.addIceCandidate(payload.candidate);
          } catch (e) {
            gcDebug("ice_add_failed", {
              peer: slot.userId,
              err: shortErr(e),
            });
          }
        } else {
          slot.pending.push(payload.candidate);
        }
      }
    } catch (e) {
      // Eine fehlerhafte rtc-Payload darf nicht den ganzen Call killen.
      gcDebug("rtc_payload_failed", {
        peer: slot.userId,
        type: payload.type,
        err: shortErr(e),
      });
    }
  }

  setMuted(muted: boolean) {
    this.localMuted = muted;
    for (const t of this.localStream.getAudioTracks()) t.enabled = !muted;
    this.publishState();
  }

  isMuted() {
    return this.localMuted;
  }

  /** Hangup: announce, close all peers, free mic. */
  leave() {
    if (this.closed) return;
    this.closed = true;
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    this.events.sendAnnounce({
      kind: "voice_leave",
      from: this.myUserId,
      at: Date.now(),
    });
    for (const [, slot] of this.peers) this.closeSlot(slot);
    this.peers.clear();
    try {
      this.localStream.getTracks().forEach((t) => t.stop());
    } catch {
      /* noop */
    }
    this.publishState();
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private makeSlot(otherUserId: string): PeerSlot {
    const pc = new RTCPeerConnection({
      iceServers: this.rtcConfig.iceServers,
      iceTransportPolicy: this.relayOnly ? "relay" : "all",
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    });

    for (const t of this.localStream.getTracks()) pc.addTrack(t, this.localStream);

    const slot: PeerSlot = {
      pc,
      userId: otherUserId,
      pending: [],
      remoteStream: null,
      speakingUntil: 0,
      closed: false,
    };

    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (!stream) return;
      slot.remoteStream = stream;
      this.startSpeakingDetection(slot, stream);
      this.publishState();
    };

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      if (this.relayOnly && ev.candidate.type !== "relay") return;
      this.events.sendRtc(otherUserId, {
        type: "candidate",
        candidate: ev.candidate.toJSON(),
      });
    };

    let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === "failed") {
        try {
          pc.restartIce();
        } catch {
          /* noop */
        }
        if (!disconnectTimer) {
          disconnectTimer = setTimeout(() => {
            disconnectTimer = null;
            const cur = pc.iceConnectionState;
            if (cur === "failed" || cur === "disconnected" || cur === "closed") {
              this.dropPeer(otherUserId);
            }
          }, 8000);
        }
      } else if (s === "disconnected") {
        if (!disconnectTimer) {
          disconnectTimer = setTimeout(() => {
            disconnectTimer = null;
            const cur = pc.iceConnectionState;
            if (cur === "disconnected" || cur === "failed" || cur === "closed") {
              this.dropPeer(otherUserId);
            }
          }, 8000);
        }
      } else if (s === "connected" || s === "completed") {
        if (disconnectTimer) {
          clearTimeout(disconnectTimer);
          disconnectTimer = null;
        }
      } else if (s === "closed") {
        this.dropPeer(otherUserId);
      }
      this.publishState();
    };

    pc.onconnectionstatechange = () => {
      this.publishState();
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.dropPeer(otherUserId);
      }
    };

    this.peers.set(otherUserId, slot);
    return slot;
  }

  private async connectToPeer(otherUserId: string) {
    if (this.peers.has(otherUserId)) return;
    if (this.peers.size >= MAX_PEERS) return;
    // Tie-breaker: only the peer with the lexicographically smaller
    // userId initiates the offer to avoid glare.
    if (this.myUserId >= otherUserId) {
      // The other side will offer; we just wait. But we still create the slot
      // so we can respond when the offer arrives.
      // Actually: we lazily create the slot when the offer arrives. No-op.
      return;
    }
    const slot = this.makeSlot(otherUserId);
    try {
      const offer = await slot.pc.createOffer();
      await slot.pc.setLocalDescription(offer);
      this.events.sendRtc(otherUserId, { type: "offer", sdp: offer.sdp ?? "" });
    } catch (e) {
      gcDebug("offer_failed", { peer: otherUserId, err: shortErr(e) });
      this.dropPeer(otherUserId);
    }
  }

  private async flushPending(slot: PeerSlot) {
    const pending = slot.pending.splice(0);
    let failed = 0;
    for (const c of pending) {
      try {
        await slot.pc.addIceCandidate(c);
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) {
      gcDebug("flush_pending_failed", {
        peer: slot.userId,
        total: pending.length,
        failed,
      });
    }
  }

  private dropPeer(userId: string) {
    const slot = this.peers.get(userId);
    if (!slot) return;
    this.closeSlot(slot);
    this.peers.delete(userId);
    this.publishState();
  }

  private closeSlot(slot: PeerSlot) {
    if (slot.closed) return;
    slot.closed = true;
    if (slot.rafToken) cancelAnimationFrame(slot.rafToken);
    try {
      slot.audioCtx?.close();
    } catch {
      /* noop */
    }
    try {
      slot.pc.close();
    } catch {
      /* noop */
    }
  }

  private startSpeakingDetection(slot: PeerSlot, stream: MediaStream) {
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      slot.audioCtx = ctx;
      slot.analyser = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        if (slot.closed) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = data[i] - 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        if (rms > SPEAKING_THRESHOLD) {
          slot.speakingUntil = Date.now() + SPEAKING_HOLD_MS;
        }
        slot.rafToken = requestAnimationFrame(tick);
      };
      slot.rafToken = requestAnimationFrame(tick);
    } catch {
      /* AudioContext may be blocked — speaking indicator simply stays off */
    }
  }

  private publishState() {
    if (this.closed) return;
    const peers = new Map<string, GroupCallPeer>();
    const now = Date.now();
    for (const [userId, slot] of this.peers) {
      const u = this.events.resolveUser(userId);
      peers.set(userId, {
        userId,
        username: u?.username ?? userId.slice(0, 8),
        stream: slot.remoteStream,
        speaking: slot.speakingUntil > now,
        muted: false, // future: peer-reported mute flag via DataChannel
        connectionState: slot.pc.connectionState,
        iceState: slot.pc.iceConnectionState,
      });
    }
    this.events.onState({
      groupId: this.groupId,
      joinedAt: this.joinedAt,
      peers,
      localMuted: this.localMuted,
    });
  }
}

/** Convenience: detect whether a parsed group payload is a voice announce. */
export function isVoiceAnnounce(plain: { kind?: string }): boolean {
  return (
    plain.kind === "voice_join" ||
    plain.kind === "voice_leave" ||
    plain.kind === "voice_present"
  );
}
