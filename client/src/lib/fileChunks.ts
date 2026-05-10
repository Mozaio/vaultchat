/**
 * Chunked File Encryption — Foundation.
 *
 * Status: NICHT in der Bestandsfunktion eingebaut. Aktuelle Datei-Versendung
 * über data:-URLs in PlainPayload.body bleibt unverändert.
 *
 * Wozu:
 *   Bestehender Pfad: ganze Datei → Base64 → in einer DR-Nachricht senden.
 *   Limit: 320 MB Ciphertext-Cap (aus Sealed-Sender-Pfad), 33% Base64-Overhead,
 *   blockiert die UI während Encode/Send, kein Resume bei Verbindungsabbruch,
 *   keine Vorschau möglich bevor Download komplett ist.
 *
 *   Mit Chunked Upload:
 *   - 256 KB pro Chunk, jeder mit eigenem AEAD (XChaCha20-Poly1305) und
 *     Chunk-Index als AAD (verhindert Reorder-Angriffe).
 *   - Server speichert Ciphertext-Blobs Content-Addressed (SHA-256 → ID).
 *   - DM-Frame referenziert die Datei via { chunks: ChunkRef[], totalSize, ... }
 *     statt body.
 *   - Empfänger kann streamen (Frame als <video>/<audio> sobald genug Chunks da
 *     sind), Resume bei Abbruch, Deduplikation server-seitig.
 *
 * Was hier drin ist:
 *   - encryptChunk / decryptChunk: AEAD pro Chunk mit AAD = magic || chunkIdx32.
 *   - splitFile: Async-Generator, der eine Blob in Chunks zerteilt (Speicher-
 *     effizient via FileReader vs. ganze Datei in RAM).
 *   - rebuildFile: aus entschlüsselten Chunks eine Blob mit korrektem MIME bauen.
 *   - ChunkRef: Wire-Format für die DM-Reference (server-blind id + key + count).
 *
 * Aktivierungs-Plan (separates Ticket):
 *   1. Server: POST /api/blobs (multipart, returns { id }), GET /api/blobs/:id
 *      mit Auth-Token + Owner-Check. Optional: TTL-cleanup, max-size Limit.
 *   2. Client: encryptChunk → upload → ChunkRef sammeln → DR-Frame mit
 *      kind: "file_v2", chunks: ChunkRef[].
 *   3. Empfänger: chunks parallel downloaden (max 4 inflight), decryptChunk,
 *      rebuildFile, an UI weitergeben.
 *   4. Backwards-compat: alter file-kind weiter unterstützen (data:-URL).
 */

import { base64FromUint8 } from "./b64";
import { getSodium, sodiumReady } from "./sodium";

export const CHUNK_SIZE = 256 * 1024; // 256 KB
const CHUNK_MAGIC = new Uint8Array([0x56, 0x46, 0x43, 0x31]); // "VFC1"

export type ChunkRef = {
  /** Server-Blob-ID (SHA-256 des Ciphertexts, content-addressed). */
  id: string;
  /** Chunk-Index (0-basiert). */
  idx: number;
  /** Größe des Klartext-Chunks in Bytes (für Resume + Validation). */
  plainSize: number;
};

export type FileManifest = {
  /** 32-Byte Symmetric-Key, base64. Wird in der DM-Payload mitgesendet. */
  keyB64: string;
  /** Original-Dateiname. */
  fileName: string;
  /** Klartext-Total-Size. */
  totalSize: number;
  /** MIME-Type. */
  mime: string;
  /** SHA-256 der gesamten Klartext-Datei (Integritätscheck nach Reassembly). */
  sha256B64: string;
  /** Sortierte Liste aller Chunks. */
  chunks: ChunkRef[];
};

async function aadFor(chunkIdx: number): Promise<Uint8Array> {
  const buf = new Uint8Array(CHUNK_MAGIC.length + 4);
  buf.set(CHUNK_MAGIC, 0);
  new DataView(buf.buffer).setUint32(CHUNK_MAGIC.length, chunkIdx, false);
  return buf;
}

/**
 * Verschlüsselt einen einzelnen Chunk. Output: nonce(24) || ct+tag.
 * Caller liefert den (zufälligen) `key` einmal pro Datei.
 */
export async function encryptChunk(
  plain: Uint8Array,
  key: Uint8Array,
  chunkIdx: number
): Promise<Uint8Array> {
  await sodiumReady();
  const sodium = getSodium();
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
  );
  const aad = await aadFor(chunkIdx);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plain,
    aad,
    null,
    nonce,
    key
  );
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return out;
}

export async function decryptChunk(
  wire: Uint8Array,
  key: Uint8Array,
  chunkIdx: number
): Promise<Uint8Array> {
  await sodiumReady();
  const sodium = getSodium();
  const nonceLen = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  if (wire.length < nonceLen + 16) throw new Error("chunk_short");
  const nonce = wire.subarray(0, nonceLen);
  const ct = wire.subarray(nonceLen);
  const aad = await aadFor(chunkIdx);
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ct,
    aad,
    nonce,
    key
  );
}

/**
 * Async-Generator über eine Blob, der CHUNK_SIZE-Stücke ausliefert.
 * Speicher-effizient — die ganze Datei wird nie in RAM gehalten.
 */
export async function* splitFile(
  blob: Blob
): AsyncGenerator<{ idx: number; data: Uint8Array }, void, unknown> {
  let offset = 0;
  let idx = 0;
  while (offset < blob.size) {
    const end = Math.min(offset + CHUNK_SIZE, blob.size);
    const slice = blob.slice(offset, end);
    const buf = new Uint8Array(await slice.arrayBuffer());
    yield { idx, data: buf };
    offset = end;
    idx += 1;
  }
}

/**
 * Setzt entschlüsselte Chunks (in beliebiger Reihenfolge übergeben) zu einem
 * Blob zusammen. Validiert SHA-256 falls expected mitgegeben.
 */
export async function rebuildFile(
  chunks: { idx: number; data: Uint8Array }[],
  mime: string,
  expectedSha256B64?: string
): Promise<Blob> {
  const sorted = [...chunks].sort((a, b) => a.idx - b.idx);
  const blob = new Blob(sorted.map((c) => c.data), { type: mime });
  if (expectedSha256B64) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
    if (base64FromUint8(digest) !== expectedSha256B64) {
      throw new Error("file_integrity_failed");
    }
  }
  return blob;
}

export async function generateFileKey(): Promise<Uint8Array> {
  await sodiumReady();
  return getSodium().randombytes_buf(32);
}

export async function sha256OfBlob(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return base64FromUint8(digest);
}
