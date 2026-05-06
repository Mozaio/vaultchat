import type { ApiUser } from "./api";
import { getRtcConfig } from "./api";

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
    throw new Error("Mikrofon nicht verfügbar oder Berechtigung verweigert");
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
  } catch {
    /* ignore single bad candidate */
  }
}

async function flushPendingCandidates(
  pc: RTCPeerConnection,
  pendingCandidates: RTCIceCandidateInit[],
  relayOnly: boolean
) {
  const pending = pendingCandidates.splice(0);
  for (const candidate of pending) {
    if (relayOnly && !isRelayCandidate(candidate)) continue;
    try {
      await pc.addIceCandidate(candidate);
    } catch {
      /* ignore single bad candidate */
    }
  }
}

export async function startCall(
  peer: ApiUser,
  token: string,
  relayOnly: boolean,
  sendRtc: (toUserId: string, payload: RtcPayload) => void,
  onRemoteStream: (s: MediaStream) => void,
  onEnd: () => void
) {
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
    // In relay-only mode, only send relay candidates.
    // Treat candidates without a known type as non-relay (fail closed).
    if (effectiveRelayOnly && ev.candidate.type !== "relay") return;
    sendRtc(peer.id, {
      type: "candidate",
      candidate: ev.candidate.toJSON(),
    });
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "failed") {
      pc.restartIce();
    }
    if (pc.iceConnectionState === "closed" || pc.iceConnectionState === "disconnected") {
      onEnd();
    }
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
          await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
          await flushPendingCandidates(pc, pendingCandidates, effectiveRelayOnly);
        } else if (payload.type === "candidate") {
          await addIceCandidateSafely(
            pc,
            payload.candidate,
            pendingCandidates,
            effectiveRelayOnly
          );
        }
      } catch {
        /* ignore — single bad remote payload should not abort the call */
      }
    },
    close: () => {
      stream.getTracks().forEach((t) => t.stop());
      pc.close();
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
) {
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
    // Treat candidates without a known type as non-relay (fail closed).
    if (effectiveRelayOnly && ev.candidate.type !== "relay") return;
    sendRtc(peer.id, {
      type: "candidate",
      candidate: ev.candidate.toJSON(),
    });
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "failed") {
      pc.restartIce();
    }
    if (pc.iceConnectionState === "closed" || pc.iceConnectionState === "disconnected") {
      onEnd();
    }
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
      } catch {
        /* ignore — single bad remote payload should not abort the call */
      }
    },
    addIce: async (c: RTCIceCandidateInit) => {
      await addIceCandidateSafely(pc, c, pendingCandidates, effectiveRelayOnly);
    },
    close: () => {
      stream.getTracks().forEach((t) => t.stop());
      pc.close();
      onEnd();
    },
  };
}
