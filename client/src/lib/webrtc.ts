import type { ApiUser } from "./api";
import { getRtcConfig } from "./api";

/**
 * Strukturierter Logger für RTC-Edge-Cases.
 * Bisher waren ICE/SDP-Fehler komplett silent (catch {}); damit Diagnose
 * unmöglich. Wir loggen jetzt auf console.debug — zur Laufzeit unsichtbar
 * für User, in DevTools sichtbar für Entwickler. Production-Build wird
 * console.debug typischerweise sowieso droppen.
 */
function rtcDebug(evt: string, fields: Record<string, unknown> = {}) {
  try {
    // eslint-disable-next-line no-console
    console.debug(`[vaultchat:rtc] ${evt}`, fields);
  } catch {
    /* noop */
  }
}

function shortError(e: unknown): string {
  if (e instanceof Error) return e.name + ": " + e.message.slice(0, 120);
  return String(e).slice(0, 120);
}

export type RtcPayload =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "candidate"; candidate: RTCIceCandidateInit };

let cached: { iceServers: RTCIceServer[]; forceRelay: boolean } | null = null;

export async function loadRtcConfig(token: string): Promise<{
  iceServers: RTCIceServer[];
  forceRelay: boolean;
}> {
  if (cached) return cached;
  try {
    const cfg = await getRtcConfig(token);
    cached = { iceServers: cfg.iceServers, forceRelay: cfg.forceRelay };
  } catch {
    throw new Error("rtc_config_unavailable");
  }
  return cached;
}

export function resetRtcConfig() {
  cached = null;
}

function buildPc(iceServers: RTCIceServer[], relayOnly: boolean): RTCPeerConnection {
  const cfg: RTCConfiguration = {
    iceServers,
    iceTransportPolicy: relayOnly ? "relay" : "all",
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
  };
  return new RTCPeerConnection(cfg);
}

async function getCallStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch {
    throw new Error("Mikrofon nicht verfuegbar oder Berechtigung verweigert");
  }
}

function isRelayCandidate(candidate: RTCIceCandidateInit): boolean {
  return /\btyp relay\b/.test(candidate.candidate ?? "");
}

async function addIceCandidateSafely(
  pc: RTCPeerConnection,
  candidate: RTCIceCandidateInit,
  pendingCandidates: RTCIceCandidateInit[],
  relayOnly: boolean
) {
  if (relayOnly && !isRelayCandidate(candidate)) return;
  if (!pc.remoteDescription) {
    pendingCandidates.push(candidate);
    return;
  }
  try {
    await pc.addIceCandidate(candidate);
  } catch (e) {
    rtcDebug("ice_add_failed", {
      err: shortError(e),
      type: candidate.candidate?.split(" ")[7] ?? null,
    });
  }
}

async function flushPendingCandidates(
  pc: RTCPeerConnection,
  pendingCandidates: RTCIceCandidateInit[],
  relayOnly: boolean
) {
  const pending = pendingCandidates.splice(0);
  let failed = 0;
  for (const candidate of pending) {
    if (relayOnly && !isRelayCandidate(candidate)) continue;
    try {
      await pc.addIceCandidate(candidate);
    } catch (e) {
      failed += 1;
      rtcDebug("ice_flush_failed", {
        err: shortError(e),
      });
    }
  }
  if (failed > 0) {
    rtcDebug("ice_flush_summary", {
      total: pending.length,
      failed,
    });
  }
}

/**
 * Robust lifecycle wiring shared by startCall + acceptCall.
 *
 * Bug fixes vs. v1:
 *  1. Did NOT end the call on iceConnectionState === "disconnected".
 *     That state is transient and often recovers on its own (Wi-Fi blip,
 *     handover, brief packet loss). v1 killed the call immediately,
 *     making real-world reliability terrible. We now give a 8 s grace
 *     window and only end if we are still disconnected/failed afterwards.
 *  2. Listen on the high-level connectionState in addition to
 *     iceConnectionState. connectionState aggregates ICE + DTLS and is
 *     the right signal for "the call is up" / "the call is down".
 *  3. Hard timeout of 45 s for getting to "connected" — otherwise we
 *     end the call as failed (instead of ringing forever or burning
 *     TURN allocations).
 *  4. onEnd fires exactly once.
 */
function wireLifecycle(
  pc: RTCPeerConnection,
  onEnd: () => void
): { onConnected: () => void; cancelTimers: () => void } {
  let ended = false;
  let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectTimeout: ReturnType<typeof setTimeout> | null = null;

  const finish = () => {
    if (ended) return;
    ended = true;
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }
    if (connectTimeout) {
      clearTimeout(connectTimeout);
      connectTimeout = null;
    }
    onEnd();
  };

  // 45-second connect timeout — if we never reach "connected"
  // we end the call rather than ringing/half-connecting forever.
  connectTimeout = setTimeout(() => {
    if (
      pc.connectionState !== "connected" &&
      pc.iceConnectionState !== "connected" &&
      pc.iceConnectionState !== "completed"
    ) {
      try {
        pc.close();
      } catch {
        /* noop */
      }
      finish();
    }
  }, 45_000);

  const handleDisconnect = () => {
    if (ended) return;
    if (disconnectTimer) return;
    // Give 8 s for the connection to recover before ending the call.
    disconnectTimer = setTimeout(() => {
      disconnectTimer = null;
      const s = pc.iceConnectionState;
      if (s === "disconnected" || s === "failed" || s === "closed") {
        try {
          pc.close();
        } catch {
          /* noop */
        }
        finish();
      }
    }, 8_000);
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    if (s === "failed") {
      // Try ICE restart once; if it does not recover the
      // connectionState listener will end the call.
      try {
        pc.restartIce();
      } catch {
        /* noop */
      }
      handleDisconnect();
    } else if (s === "disconnected") {
      handleDisconnect();
    } else if (s === "closed") {
      finish();
    } else if (s === "connected" || s === "completed") {
      if (disconnectTimer) {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
      }
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === "failed" || s === "closed") {
      finish();
    }
  };

  return {
    onConnected: () => {
      if (connectTimeout) {
        clearTimeout(connectTimeout);
        connectTimeout = null;
      }
    },
    cancelTimers: () => {
      if (disconnectTimer) {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
      }
      if (connectTimeout) {
        clearTimeout(connectTimeout);
        connectTimeout = null;
      }
    },
  };
}

export type CallController = {
  pc: RTCPeerConnection;
  localStream: MediaStream;
  handleRemote: (payload: RtcPayload) => Promise<void>;
  addIce: (c: RTCIceCandidateInit) => Promise<void>;
  setMuted: (muted: boolean) => void;
  isMuted: () => boolean;
  close: () => void;
};

export async function startCall(
  peer: ApiUser,
  token: string,
  relayOnly: boolean,
  sendRtc: (toUserId: string, payload: RtcPayload) => void,
  onRemoteStream: (s: MediaStream) => void,
  onEnd: () => void
): Promise<CallController> {
  const cfg = await loadRtcConfig(token);
  const effectiveRelayOnly = relayOnly || cfg.forceRelay;
  const pc = buildPc(cfg.iceServers, effectiveRelayOnly);
  const pendingCandidates: RTCIceCandidateInit[] = [];
  const stream = await getCallStream();

  for (const t of stream.getTracks()) pc.addTrack(t, stream);

  pc.ontrack = (ev) => {
    if (ev.streams[0]) onRemoteStream(ev.streams[0]);
  };

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    if (effectiveRelayOnly && ev.candidate.type !== "relay") return;
    sendRtc(peer.id, {
      type: "candidate",
      candidate: ev.candidate.toJSON(),
    });
  };

  const lifecycle = wireLifecycle(pc, () => {
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* noop */
    }
    onEnd();
  });

  // Mark "connected" once we have it so the connect-timeout disarms.
  const origOnConn = pc.onconnectionstatechange;
  pc.onconnectionstatechange = (ev: Event) => {
    if (origOnConn) origOnConn.call(pc, ev);
    if (pc.connectionState === "connected") lifecycle.onConnected();
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendRtc(peer.id, { type: "offer", sdp: offer.sdp ?? "" });

  return {
    pc,
    localStream: stream,
    handleRemote: async (payload: RtcPayload) => {
      try {
        if (payload.type === "answer") {
          if (pc.signalingState === "have-local-offer") {
            await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
            await flushPendingCandidates(pc, pendingCandidates, effectiveRelayOnly);
          }
        } else if (payload.type === "candidate") {
          await addIceCandidateSafely(
            pc,
            payload.candidate,
            pendingCandidates,
            effectiveRelayOnly
          );
        }
      } catch (e) {
        rtcDebug("remote_handle_failed", {
          payloadType: payload.type,
          err: shortError(e),
        });
      }
    },
    addIce: async (c: RTCIceCandidateInit) => {
      await addIceCandidateSafely(pc, c, pendingCandidates, effectiveRelayOnly);
    },
    setMuted: (muted: boolean) => {
      for (const t of stream.getAudioTracks()) t.enabled = !muted;
    },
    isMuted: () =>
      stream.getAudioTracks().some((t) => !t.enabled),
    close: () => {
      lifecycle.cancelTimers();
      stream.getTracks().forEach((t) => t.stop());
      try {
        pc.close();
      } catch {
        /* close() may be a no-op on an already-closed pc; harmless */
      }
      onEnd();
    },
  };
}

export async function acceptCall(
  peer: ApiUser,
  offerSdp: string,
  token: string,
  relayOnly: boolean,
  sendRtc: (toUserId: string, payload: RtcPayload) => void,
  onRemoteStream: (s: MediaStream) => void,
  onEnd: () => void
): Promise<CallController> {
  const cfg = await loadRtcConfig(token);
  const effectiveRelayOnly = relayOnly || cfg.forceRelay;
  const pc = buildPc(cfg.iceServers, effectiveRelayOnly);
  const pendingCandidates: RTCIceCandidateInit[] = [];
  const stream = await getCallStream();

  for (const t of stream.getTracks()) pc.addTrack(t, stream);

  pc.ontrack = (ev) => {
    if (ev.streams[0]) onRemoteStream(ev.streams[0]);
  };

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    if (effectiveRelayOnly && ev.candidate.type !== "relay") return;
    sendRtc(peer.id, {
      type: "candidate",
      candidate: ev.candidate.toJSON(),
    });
  };

  const lifecycle = wireLifecycle(pc, () => {
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* noop */
    }
    onEnd();
  });

  const origOnConn = pc.onconnectionstatechange;
  pc.onconnectionstatechange = (ev: Event) => {
    if (origOnConn) origOnConn.call(pc, ev);
    if (pc.connectionState === "connected") lifecycle.onConnected();
  };

  await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
  await flushPendingCandidates(pc, pendingCandidates, effectiveRelayOnly);

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendRtc(peer.id, { type: "answer", sdp: answer.sdp ?? "" });

  return {
    pc,
    localStream: stream,
    handleRemote: async (payload: RtcPayload) => {
      try {
        if (payload.type === "candidate") {
          await addIceCandidateSafely(
            pc,
            payload.candidate,
            pendingCandidates,
            effectiveRelayOnly
          );
        }
      } catch (e) {
        rtcDebug("accept_remote_handle_failed", {
          payloadType: payload.type,
          err: shortError(e),
        });
      }
    },
    addIce: async (c: RTCIceCandidateInit) => {
      await addIceCandidateSafely(pc, c, pendingCandidates, effectiveRelayOnly);
    },
    setMuted: (muted: boolean) => {
      for (const t of stream.getAudioTracks()) t.enabled = !muted;
    },
    isMuted: () =>
      stream.getAudioTracks().some((t) => !t.enabled),
    close: () => {
      lifecycle.cancelTimers();
      stream.getTracks().forEach((t) => t.stop());
      try {
        pc.close();
      } catch {
        /* close() may be a no-op on an already-closed pc; harmless */
      }
      onEnd();
    },
  };
}
