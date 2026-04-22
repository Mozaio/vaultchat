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
    /**
     * Verhindert, dass lokale IPv6/IPv4-Hostkandidaten an den Peer gesendet
     * werden, sobald mindestens ein relay-Kandidat existiert. Chrome spricht
     * hier `iceTransportPolicy: "relay"` auch.
     */
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
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: true,
  });
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

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendRtc(peer.id, { type: "offer", sdp: offer.sdp ?? "" });

  const handlers: Record<string, (p: RtcPayload) => void | Promise<void>> = {
    answer: async (p) => {
      if (p.type !== "answer") return;
      await pc.setRemoteDescription({ type: "answer", sdp: p.sdp });
    },
    candidate: async (p) => {
      if (p.type !== "candidate") return;
      try {
        await pc.addIceCandidate(p.candidate);
      } catch {
        /* ignore */
      }
    },
  };

  return {
    pc,
    localStream: stream,
    handleRemote: async (payload: RtcPayload) => {
      const h = handlers[payload.type];
      if (h) await h(payload);
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
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: true,
  });
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

  await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendRtc(peer.id, { type: "answer", sdp: answer.sdp ?? "" });

  return {
    pc,
    localStream: stream,
    addIce: async (c: RTCIceCandidateInit) => {
      try {
        await pc.addIceCandidate(c);
      } catch {
        /* */
      }
    },
    close: () => {
      stream.getTracks().forEach((t) => t.stop());
      pc.close();
      onEnd();
    },
  };
}
