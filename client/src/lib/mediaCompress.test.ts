/**
 * Unit tests for the pure media-pipeline helpers (GOAL Phase 4.3).
 *
 * The canvas/DOM path of `compressImageFile` is exercised by the runtime app
 * + Vite build; here we pin the pure decision/geometry logic that would
 * otherwise fail silently (wrong scaling, accidental upscaling, wrong skip
 * decision, bad byte estimate).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  approxDataUrlBytes,
  DEFAULT_COMPRESS,
  fitWithin,
  MIN_COMPRESS_BYTES,
  pickEncoding,
  shouldCompressImage,
} from "./mediaCompress.ts";

test("fitWithin downscales a large landscape image to the long-edge cap", () => {
  const r = fitWithin(4000, 3000, 2048);
  assert.equal(r.width, 2048);
  assert.equal(r.height, 1536); // 3000 * (2048/4000) = 1536
});

test("fitWithin downscales a portrait image by its longer (height) edge", () => {
  const r = fitWithin(3000, 4000, 2048);
  assert.equal(r.height, 2048);
  assert.equal(r.width, 1536);
});

test("fitWithin never upscales a small image", () => {
  const r = fitWithin(640, 480, 2048);
  assert.deepEqual(r, { width: 640, height: 480 });
});

test("fitWithin preserves aspect ratio within rounding", () => {
  const r = fitWithin(1920, 1080, 256);
  // 1920 is the long edge → width 256, height 1080*(256/1920)=144
  assert.equal(r.width, 256);
  assert.equal(r.height, 144);
});

test("fitWithin guarantees at least 1px and handles degenerate input", () => {
  assert.deepEqual(fitWithin(0, 0, 256), { width: 1, height: 1 });
  assert.deepEqual(fitWithin(-5, 10, 256), { width: 1, height: 1 });
  assert.deepEqual(fitWithin(Number.NaN, 10, 256), { width: 1, height: 1 });
  // Extreme aspect ratio must not collapse the short side to 0.
  const r = fitWithin(10000, 1, 256);
  assert.equal(r.width, 256);
  assert.ok(r.height >= 1);
});

test("shouldCompressImage only accepts raster photo formats above the floor", () => {
  const big = MIN_COMPRESS_BYTES + 1;
  assert.equal(shouldCompressImage("image/jpeg", big), true);
  assert.equal(shouldCompressImage("image/png", big), true);
  assert.equal(shouldCompressImage("image/webp", big), true);
  // Animated GIF and SVG must NOT be re-encoded (would drop frames / are vector).
  assert.equal(shouldCompressImage("image/gif", big), false);
  assert.equal(shouldCompressImage("image/svg+xml", big), false);
  // Non-images are skipped.
  assert.equal(shouldCompressImage("application/pdf", big), false);
  assert.equal(shouldCompressImage("video/mp4", big), false);
});

test("shouldCompressImage skips tiny images to avoid re-encode bloat", () => {
  assert.equal(shouldCompressImage("image/jpeg", MIN_COMPRESS_BYTES - 1), false);
  assert.equal(shouldCompressImage("image/jpeg", 0), false);
});

test("pickEncoding keeps WebP, otherwise standardizes on JPEG", () => {
  assert.equal(pickEncoding("image/webp").mime, "image/webp");
  assert.equal(pickEncoding("image/png").mime, "image/jpeg");
  assert.equal(pickEncoding("image/jpeg").mime, "image/jpeg");
});

test("approxDataUrlBytes estimates decoded size from a data-URL", () => {
  // "data:...," prefix is ignored; "AAAA" (4 b64 chars) → 3 bytes, no padding.
  assert.equal(approxDataUrlBytes("data:image/jpeg;base64,AAAA"), 3);
  // One '=' pad → 2 bytes; "AAA=" decodes to 2 bytes.
  assert.equal(approxDataUrlBytes("data:image/jpeg;base64,AAA="), 2);
  // Two '=' pad → 1 byte.
  assert.equal(approxDataUrlBytes("data:image/jpeg;base64,AA=="), 1);
  // Bare base64 (no comma) is handled too.
  assert.equal(approxDataUrlBytes("AAAA"), 3);
});

test("DEFAULT_COMPRESS exposes sane, privacy-minded defaults", () => {
  assert.ok(DEFAULT_COMPRESS.maxEdge >= 1024 && DEFAULT_COMPRESS.maxEdge <= 4096);
  assert.ok(DEFAULT_COMPRESS.thumbEdge > 0 && DEFAULT_COMPRESS.thumbEdge <= 512);
  assert.ok(DEFAULT_COMPRESS.quality > 0 && DEFAULT_COMPRESS.quality <= 1);
  assert.ok(DEFAULT_COMPRESS.thumbQuality > 0 && DEFAULT_COMPRESS.thumbQuality <= 1);
  // The thumbnail should be lower quality than the full image (it's a preview).
  assert.ok(DEFAULT_COMPRESS.thumbQuality <= DEFAULT_COMPRESS.quality);
});
