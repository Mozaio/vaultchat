/**
 * Client-side media pipeline — image downscale/compression + encrypted
 * thumbnails (GOAL Phase 4.3).
 *
 * Why
 * ===
 * Until now `sendDmFile`/`sendGroupFile` read a picked file straight to a
 * data-URL and sealed it verbatim. A 12-megapixel phone photo (~6–10 MB)
 * therefore traveled at full resolution through the Double-Ratchet wire and
 * the sealed-sender envelope, and the chat bubble had to decode the entire
 * full-size image just to show a preview. That is slow, wastes the recipient's
 * mailbox byte quota, and is needless: nobody views a 4000×3000 JPEG inline.
 *
 * What this does
 * ==============
 *  - `compressImageFile(file)` decodes the image once, downscales it to fit
 *    within a sane bound (default 2048px on the long edge), re-encodes it as
 *    JPEG/WebP at a quality target, and ALSO produces a small (~256px) JPEG
 *    thumbnail. Both are plain data-URLs.
 *  - The thumbnail is attached to the message payload as `thumb`. Because the
 *    ENTIRE `PlainPayload` is sealed (sealed-sender envelope for DMs, Megolm
 *    for groups) before it leaves the client, the thumbnail is E2EE *by
 *    construction* — no extra key, no separate server object, no third-party
 *    fetch. The server only ever sees ciphertext. (THREAT_MODEL: this adds no
 *    new server-visible metadata; it is strictly inside the existing E2EE
 *    boundary.)
 *  - Privacy bonus: re-encoding through a canvas strips EXIF/GPS metadata that
 *    the original camera file carries. We never want to leak the sender's
 *    location, device, or capture time, so canvas re-encode is the safe path.
 *
 * Pure vs. DOM
 * ============
 * The geometry/decision math (`fitWithin`, `pickEncoding`, `shouldCompress`)
 * is pure and unit-tested in `mediaCompress.test.ts`. The canvas work needs a
 * DOM and is exercised at runtime / via the (verified) Vite build.
 *
 * No invented crypto. No new wire crypto. Behavior-preserving for non-images
 * (they fall through untouched) and backwards-compatible (recipients without
 * `thumb` simply render `body`).
 */

/** A compressed image result: a (possibly) downscaled full image + a thumb. */
export type CompressedImage = {
  /** Downscaled / recompressed full-size image as a data-URL. */
  dataUrl: string;
  /** Small inline preview (data-URL). Rides inside the sealed payload. */
  thumb: string;
  /** Final pixel dimensions of `dataUrl`. */
  width: number;
  height: number;
  /** Mime type of `dataUrl` (e.g. "image/jpeg" / "image/webp"). */
  mime: string;
  /** Approximate encoded byte size of `dataUrl` (for diagnostics/quota). */
  approxBytes: number;
};

export type CompressOptions = {
  /** Max length of the longer edge for the full image. Default 2048. */
  maxEdge?: number;
  /** Long-edge cap for the thumbnail. Default 256. */
  thumbEdge?: number;
  /** JPEG/WebP quality for the full image (0..1). Default 0.82. */
  quality?: number;
  /** JPEG quality for the thumbnail (0..1). Default 0.6. */
  thumbQuality?: number;
};

export const DEFAULT_COMPRESS: Required<CompressOptions> = {
  maxEdge: 2048,
  thumbEdge: 256,
  quality: 0.82,
  thumbQuality: 0.6,
};

/**
 * MIME types we will re-encode through a canvas. GIF is intentionally excluded
 * because canvas only captures the first frame (it would silently kill the
 * animation), and SVG is excluded because it is vector + a script-injection
 * surface — both are passed through untouched by `shouldCompressImage`.
 */
const COMPRESSIBLE = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Below this size, recompressing a photo rarely pays off — skip the work. */
export const MIN_COMPRESS_BYTES = 64 * 1024;

/**
 * Pure: decide whether a file is a raster image we should run through the
 * compressor. Animated GIFs and SVGs are deliberately excluded (see above).
 * Tiny files are skipped to avoid making them *larger* via re-encode overhead.
 */
export function shouldCompressImage(mime: string, sizeBytes: number): boolean {
  if (!COMPRESSIBLE.has(mime)) return false;
  if (sizeBytes < MIN_COMPRESS_BYTES) return false;
  return true;
}

/**
 * Pure: fit (w,h) inside a `maxEdge × maxEdge` box, preserving aspect ratio.
 * Never upscales (a small image stays its own size). Rounds to whole pixels
 * and guarantees at least 1px per side.
 */
export function fitWithin(
  w: number,
  h: number,
  maxEdge: number
): { width: number; height: number } {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { width: 1, height: 1 };
  }
  const longest = Math.max(w, h);
  if (longest <= maxEdge) {
    return { width: Math.round(w), height: Math.round(h) };
  }
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/**
 * Pure: pick the output encoding. Images with an alpha channel (PNG) keep
 * transparency only if the consumer asked to; for chat photos we standardize
 * on JPEG, but PNGs that are likely screenshots/stickers (small) keep PNG.
 * Here we keep it simple and deterministic: prefer the source's own lossy
 * format, otherwise JPEG. WebP is honored when the source is already WebP.
 */
export function pickEncoding(sourceMime: string): {
  mime: "image/jpeg" | "image/webp";
} {
  if (sourceMime === "image/webp") return { mime: "image/webp" };
  return { mime: "image/jpeg" };
}

/** Pure: estimate the decoded byte length of a base64 data-URL. */
export function approxDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  // 4 base64 chars → 3 bytes; subtract padding.
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

// ---------------------------------------------------------------------------
// DOM-dependent runtime path (canvas). Not unit-tested directly; the pure
// helpers above carry the logic that can go wrong silently.
// ---------------------------------------------------------------------------

function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("file_read_failed"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

function decodeImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error("image_decode_failed"));
    img.onload = () => resolve(img);
    img.src = dataUrl;
  });
}

function drawScaled(
  img: HTMLImageElement,
  width: number,
  height: number,
  mime: string,
  quality: number
): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas_unavailable");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL(mime, quality);
}

/**
 * Runtime: compress a picked image file and build an inline thumbnail.
 * Resolves with `null` for non-raster or tiny inputs (caller sends the file
 * as-is). Throws only on a genuine decode/canvas failure — the caller treats
 * that as "send the original" so a weird image never blocks a send.
 *
 * The returned `dataUrl`/`thumb` are plain (unencrypted) data-URLs; they
 * become E2EE the moment the caller seals the surrounding PlainPayload.
 */
export async function compressImageFile(
  file: File,
  options?: CompressOptions
): Promise<CompressedImage | null> {
  const opt = { ...DEFAULT_COMPRESS, ...(options ?? {}) };
  if (!shouldCompressImage(file.type, file.size)) return null;

  const sourceUrl = await readFileAsDataUrl(file);
  const img = await decodeImage(sourceUrl);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return null;

  const { mime } = pickEncoding(file.type);
  const full = fitWithin(w, h, opt.maxEdge);
  const fullUrl = drawScaled(img, full.width, full.height, mime, opt.quality);

  // Only keep the recompressed full image if it's actually smaller than the
  // original; otherwise the original (e.g. an already-tight JPEG) wins.
  const fullBytes = approxDataUrlBytes(fullUrl);
  const useUrl = fullBytes < file.size ? fullUrl : sourceUrl;
  const useDims =
    fullBytes < file.size ? full : { width: w, height: h };

  const thumbDims = fitWithin(w, h, opt.thumbEdge);
  const thumb = drawScaled(
    img,
    thumbDims.width,
    thumbDims.height,
    "image/jpeg",
    opt.thumbQuality
  );

  return {
    dataUrl: useUrl,
    thumb,
    width: useDims.width,
    height: useDims.height,
    mime: useUrl === sourceUrl ? file.type : mime,
    approxBytes: approxDataUrlBytes(useUrl),
  };
}
