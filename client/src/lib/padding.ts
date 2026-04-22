/**
 * Längen-Padding (Bucketing) gegen Metadaten-Leaks.
 * Ciphertext-Länge reveals nur die Bucket-Größe, nicht die echte Nachrichtenlänge.
 */
const BUCKETS = [64, 256, 1024, 4096, 16_384, 65_536, 262_144, 1_048_576];

/** Für optionales Cover-Traffic: zufällige Puffergröße. */
export function randomBucketSize(): number {
  const b = BUCKETS[Math.floor(Math.random() * BUCKETS.length)] ?? 256;
  return b;
}

function nextBucket(size: number): number {
  for (const b of BUCKETS) if (b >= size) return b;
  return Math.ceil(size / 1_048_576) * 1_048_576;
}

export function pad(payload: Uint8Array): Uint8Array {
  const totalNeeded = payload.length + 4;
  const bucket = nextBucket(totalNeeded);
  const out = new Uint8Array(bucket);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}

export function unpad(padded: Uint8Array): Uint8Array {
  if (padded.length < 4) throw new Error("bad_pad");
  const len = new DataView(
    padded.buffer,
    padded.byteOffset,
    4
  ).getUint32(0, false);
  if (len + 4 > padded.length) throw new Error("bad_pad_len");
  return padded.slice(4, 4 + len);
}
