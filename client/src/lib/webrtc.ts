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
    cached = {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      forceRelay: false,
    };
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

export async function startCall(
  peer: ApiUser,
  token: string,
  relayOnly: boolean,
  sendRtc: (toUserId: string, payload: RtcPayload) => void,
  onRemoteStream: (s: MediaStream) => void,
  onEnd: () => void
) {
  const cfg = await loadRtcConfig(token);
  const pc = buildPc(cfg.iceServers, relayOnly || cfg.forceRelay);
  
  // Get user media with better error handling
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: "user",
      },
    });
  } catch (err) {
    console.error("Failed to get media devices:", err);
    throw new Error("Kamera oder Mikrofon nicht verfügbar");
  }
  
  for (const t of stream.getTracks()) pc.addTrack(t, stream);

  pc.ontrack = (ev) => {
    if (ev.streams[0]) onRemoteStream(ev.streams[0]);
  };

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    // In relay-only mode, only send relay candidates
    if (relayOnly && ev.candidate.type && ev.candidate.type !== "relay") return;
    sendRtc(peer.id, {
      type: "candidate",
      candidate: ev.candidate.toJSON(),
    });
  };

  pc.oniceconnectionstatechange = () => {
    console.log("ICE connection state:", pc.iceConnectionState);
    if (pc.iceConnectionState === "failed") {
      // Try to restart ICE
      pc.restartIce();
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
        } else if (payload.type === "candidate") {
          await pc.addIceCandidate(payload.candidate);
        }
      } catch (err) {
        console.error("Error handling remote payload:", err);
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
  const pc = buildPc(cfg.iceServers, relayOnly || cfg.forceRelay);
  
  // Get user media with better error handling
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: "user",
      },
    });
  } catch (err) {
    console.error("Failed to get media devices:", err);
    throw new Error("Kamera oder Mikrofon nicht verfügbar");
  }
  
  for (const t of stream.getTracks()) pc.addTrack(t, stream);

  pc.ontrack = (ev) => {
    if (ev.streams[0]) onRemoteStream(ev.streams[0]);
  };

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    if (relayOnly && ev.candidate.type && ev.candidate.type !== "relay") return;
    sendRtc(peer.id, {
      type: "candidate",
      candidate: ev.candidate.toJSON(),
    });
  };

  pc.oniceconnectionstatechange = () => {
    console.log("ICE connection state:", pc.iceConnectionState);
    if (pc.iceConnectionState === "failed") {
      pc.restartIce();
    }
  };

  // Buffer ICE candidates until remote description is set
  const pendingCandidates: RTCIceCandidateInit[] = [];
  
  await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
  
  // Add any buffered candidates
  for (const candidate of pendingCandidates) {
    try {
      await pc.addIceCandidate(candidate);
    } catch {
      /* ignore */
    }
  }
  
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendRtc(peer.id, { type: "answer", sdp: answer.sdp ?? "" });

  return {
    pc,
    localStream: stream,
    handleRemote: async (payload: RtcPayload) => {
      try {
        if (payload.type === "candidate") {
          await pc.addIceCandidate(payload.candidate);
        }
      } catch (err) {
        console.error("Error adding ICE candidate:", err);
      }
    },
    addIce: async (c: RTCIceCandidateInit) => {
      if (relayOnly && (c as RTCIceCandidate).type && (c as RTCIceCandidate).type !== "relay") return;
      try {
        await pc.addIceCandidate(c);
      } catch {
        /* ignore */
      }
    },
    close: () => {
      stream.getTracks().forEach((t) => t.stop());
      pc.close();
      onEnd();
    },
  };
}
