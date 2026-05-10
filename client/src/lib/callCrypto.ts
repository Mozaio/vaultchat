/**
 * VaultChat E2EE-Layer für WebRTC Audio (Insertable Streams).
 *
 * Status (2026-05-10): FOUNDATION — nicht in webrtc.ts aktiviert.
 *
 * Hintergrund:
 *   WebRTC selbst ist E2E-verschlüsselt zwischen den Peers (DTLS-SRTP). Wenn
 *   wir aber TURN-Relay zwingen (relay-only-Policy für IP-Schutz), kann der
 *   TURN-Server theoretisch terminieren. Mit "Insertable Streams" hängen wir
 *   eine zusätzliche Schicht XChaCha20-Poly1305 zwischen Codec und SRTP an —
 *   damit ist der Frame-Inhalt selbst dann opaque, wenn der Transport-Layer
 *   kompromittiert ist.
 *
 * Wieso noch nicht aktiv:
 *   1. Beide Peers müssen den Layer aktiv haben, sonst hört der eine Garbage.
 *      Ohne in-band Negotiation (SDP-Extension oder DataChannel-Handshake)
 *      brechen Anrufe asymmetrisch. Aktivierung braucht zuerst einen
 *      Capability-Handshake zwischen Caller und Callee.
 *   2. Browser-Support: Chrome/Edge ja, Safari noch eingeschränkt.
 *      Wir brauchen ein Feature-Detect und einen Fallback-Pfad, sonst
 *      lockt der Aufruf User mit Safari aus.
 *
 * Aktivierungs-Plan:
 *   a) DataChannel "vaultchat-call-meta" zwischen Caller/Callee aufmachen.
 *   b) Beide senden ihre Capability ({ supports_insertable: true|false }).
 *   c) Wenn beide true: Key wird über den existierenden DR-Kanal geteilt
 *      (sealed-sender DM mit Frame { kind: "call_key", keyB64, callId }),
 *      dann der Insertable-Streams-Pfad eingeschaltet.
 *   d) Sonst weiter mit reinem DTLS-SRTP.
 */

import { base64FromUint8 } from "./b64";
import { getSodium, sodiumReady } from "./sodium";

const MAGIC = new Uint8Array([0x56, 0x43, 0x52, 0x31]); // "VCR1" — VaultChat Realtime v1

/** Erzeugt einen zufälligen 32-Byte Call-Key für die XChaCha20-Schicht. */
export async function generateCallKey(): Promise<Uint8Array> {
  await sodiumReady();
  return getSodium().randombytes_buf(32);
}

export function callKeyToB64(key: Uint8Array): string {
  return base64FromUint8(key);
}

/**
 * Frame-Layout (XChaCha20-Poly1305):
 *   MAGIC(4) || nonce(24) || ciphertext+tag(N+16)
 *
 * AAD: nichts (Frame-Header ist von Codec gegeben, wir wrappen nur data).
 *
 * Performance-Hinweis:
 *   Bei 50 fps Audio = 50 encrypts/Sekunde, ~30-100 Bytes pro Frame.
 *   XChaCha20 in libsodium läuft bei ~800 MB/s in WASM — easy genug, auch
 *   in einem Worker.
 */
export async function encryptCallFrame(
  data: Uint8Array,
  key: Uint8Array
): Promise<Uint8Array> {
  await sodiumReady();
  const sodium = getSodium();
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
  );
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    data,
    null,
    null,
    nonce,
    key
  );
  const out = new Uint8Array(MAGIC.length + nonce.length + ct.length);
  out.set(MAGIC, 0);
  out.set(nonce, MAGIC.length);
  out.set(ct, MAGIC.length + nonce.length);
  return out;
}

export async function decryptCallFrame(
  wire: Uint8Array,
  key: Uint8Array
): Promise<Uint8Array> {
  await sodiumReady();
  const sodium = getSodium();
  const nonceLen = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  if (wire.length < MAGIC.length + nonceLen + 16) {
    throw new Error("call_frame_short");
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (wire[i] !== MAGIC[i]) throw new Error("call_frame_magic");
  }
  const nonce = wire.subarray(MAGIC.length, MAGIC.length + nonceLen);
  const ct = wire.subarray(MAGIC.length + nonceLen);
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ct,
    null,
    nonce,
    key
  );
}

/**
 * Browser-Capability-Detect: nutzt RTCRtpSender.createEncodedStreams (Chrome)
 * oder das ältere RTCRtpScriptTransform (neuer Standard, Safari).
 */
export function supportsInsertableStreams(): boolean {
  if (typeof RTCRtpSender === "undefined") return false;
  const proto = RTCRtpSender.prototype as unknown as {
    createEncodedStreams?: unknown;
    transform?: unknown;
  };
  return (
    typeof proto.createEncodedStreams === "function" ||
    typeof proto.transform !== "undefined"
  );
}
