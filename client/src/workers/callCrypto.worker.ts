/**
 * Insertable-Streams Pipeline-Worker.
 *
 * Wird via RTCRtpScriptTransform an einen RTCRtpSender/Receiver gehängt:
 *
 *   const w = new Worker(new URL("./callCrypto.worker.ts", import.meta.url));
 *   w.postMessage({ type: "init", role: "send", keyB64 });
 *   sender.transform = new RTCRtpScriptTransform(w, { side: "send" });
 *
 * Worker bekommt einen ReadableStream<RTCEncodedAudioFrame>, transformiert
 * jedes Frame mit der Symmetric-Key-Layer aus callCrypto.ts und schreibt
 * es weiter.
 */

import { encryptCallFrame, decryptCallFrame } from "../lib/callCrypto";
import { uint8FromBase64 } from "../lib/b64";

let _key: Uint8Array | null = null;

self.addEventListener(
  "message",
  async (ev: MessageEvent<{ type: "init"; keyB64: string }>) => {
    if (ev.data.type === "init") {
      _key = uint8FromBase64(ev.data.keyB64);
    }
  }
);

interface RTCTransformEvent extends Event {
  transformer: {
    readable: ReadableStream<RTCEncodedAudioFrame | RTCEncodedVideoFrame>;
    writable: WritableStream<RTCEncodedAudioFrame | RTCEncodedVideoFrame>;
    options?: { side?: "send" | "recv" };
  };
}

interface RTCEncodedAudioFrame {
  data: ArrayBuffer;
}
interface RTCEncodedVideoFrame {
  data: ArrayBuffer;
}

(self as unknown as { onrtctransform?: (ev: RTCTransformEvent) => void }).onrtctransform =
  (ev: RTCTransformEvent) => {
    const side = ev.transformer.options?.side ?? "send";
    const transformer = new TransformStream<
      RTCEncodedAudioFrame | RTCEncodedVideoFrame,
      RTCEncodedAudioFrame | RTCEncodedVideoFrame
    >({
      async transform(frame, controller) {
        if (!_key) {
          // Kein Key gesetzt → unverändert weiterreichen (Pipeline darf nicht stocken).
          controller.enqueue(frame);
          return;
        }
        try {
          const data = new Uint8Array(frame.data);
          const next =
            side === "send"
              ? await encryptCallFrame(data, _key)
              : await decryptCallFrame(data, _key);
          frame.data = next.buffer.slice(
            next.byteOffset,
            next.byteOffset + next.byteLength
          ) as ArrayBuffer;
          controller.enqueue(frame);
        } catch {
          // Frame verwerfen (besser als Garbage durchreichen).
        }
      },
    });
    ev.transformer.readable.pipeThrough(transformer).pipeTo(ev.transformer.writable);
  };
