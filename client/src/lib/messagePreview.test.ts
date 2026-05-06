import assert from "node:assert/strict";
import test from "node:test";
import type { PlainPayload } from "./crypto";
import {
  formatFileSize,
  fmtDuration,
  isImagePayload,
  previewForPayload,
  truncate,
} from "./messagePreview";

test("truncate shortens long text", () => {
  assert.equal(truncate("hello", 3), "he…");
  assert.equal(truncate("", 10), "");
});

test("fmtDuration formats seconds", () => {
  assert.equal(fmtDuration(undefined), "0:00");
  assert.equal(fmtDuration(500), "0:01");
  assert.equal(fmtDuration(65_000), "1:05");
});

test("formatFileSize", () => {
  assert.equal(formatFileSize(undefined), "");
  assert.equal(formatFileSize(512), "512 B");
  assert.match(formatFileSize(2048), /2\.0 KB/);
});

test("isImagePayload", () => {
  const img: PlainPayload = {
    v: 2,
    cid: "c1",
    kind: "file",
    mime: "image/png",
    body: "x",
  };
  const pdf: PlainPayload = {
    v: 2,
    cid: "c2",
    kind: "file",
    mime: "application/pdf",
  };
  assert.equal(isImagePayload(img), true);
  assert.equal(isImagePayload(pdf), false);
});

test("previewForPayload", () => {
  const text: PlainPayload = {
    v: 2,
    cid: "t",
    kind: "text",
    body: "a".repeat(100),
  };
  assert.ok(previewForPayload(text).endsWith("…"));

  const file: PlainPayload = {
    v: 2,
    cid: "f",
    kind: "file",
    fileName: "doc.pdf",
    mime: "application/pdf",
  };
  assert.equal(previewForPayload(file), "📎 doc.pdf");

  const pic: PlainPayload = {
    v: 2,
    cid: "p",
    kind: "file",
    fileName: "a.png",
    mime: "image/png",
  };
  assert.equal(previewForPayload(pic), "📷 Bild · a.png");

  const voice: PlainPayload = {
    v: 2,
    cid: "v",
    kind: "voice",
    durationMs: 90_000,
  };
  assert.equal(previewForPayload(voice), "🎤 Sprachnachricht 1:30");

  const reaction: PlainPayload = {
    v: 2,
    cid: "r",
    kind: "reaction",
    refCid: "x",
    emoji: "👍",
  };
  assert.equal(previewForPayload(reaction), "");
});
