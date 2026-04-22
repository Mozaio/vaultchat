import { randomBucketSize } from "./padding";
import { getSodium, sodiumReady } from "./sodium";

const MIN_IDLE_MS = 15_000;

/**
 * Optionales Tarn-Traffic (nur sinnvoll, wenn der Client sich per erstem
 * `auth`-Frame verbindet und bewusst Dummies sendet — ansonsten weglassen,
 * weil dummies als Envelope-Spam wirken und Empfänger-Clients belasten).
 */
export function startCoverTraffic(
  ws: WebSocket,
  peers: { id: string; publicKey: string }[],
  isActive: () => boolean
) {
  let timer: ReturnType<typeof setTimeout>;
  let lastRealMessage = Date.now();
  const markRealActivity = () => {
    lastRealMessage = Date.now();
  };
  const sendDummy = async () => {
    const idle = Date.now() - lastRealMessage;
    if (
      !isActive() ||
      ws.readyState !== ws.OPEN ||
      peers.length === 0 ||
      idle < MIN_IDLE_MS
    ) {
      schedule();
      return;
    }
    try {
      await sodiumReady();
      const sodium = getSodium();
      const peer = peers[Math.floor(Math.random() * peers.length)]!;
      const size = Math.min(randomBucketSize(), 2048);
      const dummy = sodium.randombytes_buf(size);
      const binary = String.fromCharCode(...new Uint8Array(dummy));
      const dummyB64 = btoa(binary);
      ws.send(
        JSON.stringify({
          type: "dm",
          toUserId: peer.id,
          envelope: dummyB64,
          cid: crypto.randomUUID(),
        })
      );
    } catch {
      /* ignore */
    }
    schedule();
  };
  const schedule = () => {
    const delay = 5000 + Math.random() * 15_000;
    timer = setTimeout(sendDummy, delay);
  };
  schedule();
  return {
    stop: () => clearTimeout(timer),
    markRealActivity,
  };
}
