/**
 * In-Memory Blob Store — Foundation für Chunked-File-Upload.
 *
 * Status: NICHT in der Client-Bestandsfunktion eingebaut. Endpoints
 * /api/blobs (POST/GET) + dieser Store sind Foundation für eine spätere
 * Migration weg von data:-URLs (siehe lib/fileChunks.ts auf Client-Seite).
 *
 * Eigenschaften:
 *  - Content-Addressed: ID = SHA-256(ciphertext) — gleicher Inhalt
 *    speichert nur einmal, Dedup für free.
 *  - Owner-Tagging: jedes Blob trägt eine Liste von userIds, die es
 *    geuploaded haben. GET prüft, dass der Requester drin ist.
 *  - TTL: 30 Tage default, configurable via VAULTCHAT_BLOB_TTL_MS.
 *  - Quota: pro User max VAULTCHAT_BLOB_MAX_PER_USER_BYTES (default 256 MB),
 *    älteste Blobs fliegen first raus wenn das überschritten wird.
 *  - Memory-only: Server-Restart = Blobs weg. Render-Free hat ohnehin
 *    ephemeral storage; persistente Variante (S3, Postgres+bytea) wäre
 *    separate Migration.
 *
 * Wire (Vorschlag):
 *   POST /api/blobs (auth)
 *     body: raw bytes (application/octet-stream), max BLOB_MAX_BYTES
 *     resp: { id, size }
 *   GET /api/blobs/:id (auth)
 *     prüft owner-list, returns bytes
 *   DELETE /api/blobs/:id (auth)
 *     entfernt user aus owner-list; wenn keine owner mehr, dropped
 */

import { createHash } from "node:crypto";

type Blob = {
  id: string;
  bytes: Buffer;
  owners: Set<string>;
  createdAt: number;
  expiresAt: number;
};

const blobs = new Map<string, Blob>();
const byOwner = new Map<string, Set<string>>(); // userId -> Set<blobId>

const BLOB_TTL_MS = Number(
  process.env.VAULTCHAT_BLOB_TTL_MS ?? 30 * 24 * 60 * 60 * 1000
);
const BLOB_MAX_BYTES = Number(
  process.env.VAULTCHAT_BLOB_MAX_BYTES ?? 32 * 1024 * 1024 // 32 MB pro Blob
);
const BLOB_PER_USER_BYTES = Number(
  process.env.VAULTCHAT_BLOB_PER_USER_BYTES ?? 256 * 1024 * 1024 // 256 MB quota
);

function hashId(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("base64url").slice(0, 32);
}

function ownerSize(userId: string): number {
  const ids = byOwner.get(userId);
  if (!ids) return 0;
  let total = 0;
  for (const id of ids) {
    const b = blobs.get(id);
    if (b) total += b.bytes.length;
  }
  return total;
}

function trimOwnerQuota(userId: string): void {
  let used = ownerSize(userId);
  if (used <= BLOB_PER_USER_BYTES) return;
  const ids = byOwner.get(userId);
  if (!ids) return;
  // Älteste-First: nach createdAt sortieren und droppen, bis unter quota.
  const ordered = Array.from(ids)
    .map((id) => blobs.get(id))
    .filter((b): b is Blob => Boolean(b))
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const b of ordered) {
    if (used <= BLOB_PER_USER_BYTES) break;
    b.owners.delete(userId);
    ids.delete(b.id);
    used -= b.bytes.length;
    if (b.owners.size === 0) blobs.delete(b.id);
  }
}

export type StoreResult =
  | { ok: true; id: string; size: number; deduped: boolean }
  | { ok: false; reason: "too_large" | "empty" };

export function storeBlob(userId: string, bytes: Buffer): StoreResult {
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  if (bytes.length > BLOB_MAX_BYTES) return { ok: false, reason: "too_large" };
  const id = hashId(bytes);
  let blob = blobs.get(id);
  let deduped = false;
  if (blob) {
    deduped = true;
    blob.owners.add(userId);
  } else {
    blob = {
      id,
      bytes,
      owners: new Set([userId]),
      createdAt: Date.now(),
      expiresAt: Date.now() + BLOB_TTL_MS,
    };
    blobs.set(id, blob);
  }
  let ids = byOwner.get(userId);
  if (!ids) {
    ids = new Set();
    byOwner.set(userId, ids);
  }
  ids.add(id);
  trimOwnerQuota(userId);
  return { ok: true, id, size: bytes.length, deduped };
}

export function getBlob(userId: string, id: string): Buffer | null {
  const b = blobs.get(id);
  if (!b) return null;
  if (b.expiresAt <= Date.now()) {
    deleteBlobEntry(b);
    return null;
  }
  if (!b.owners.has(userId)) return null;
  return b.bytes;
}

export function unlinkBlob(userId: string, id: string): boolean {
  const b = blobs.get(id);
  if (!b) return false;
  if (!b.owners.has(userId)) return false;
  b.owners.delete(userId);
  byOwner.get(userId)?.delete(id);
  if (b.owners.size === 0) blobs.delete(b.id);
  return true;
}

function deleteBlobEntry(b: Blob): void {
  for (const o of b.owners) byOwner.get(o)?.delete(b.id);
  blobs.delete(b.id);
}

export function sweepExpiredBlobs(): { removed: number } {
  const now = Date.now();
  let removed = 0;
  for (const [, b] of blobs) {
    if (b.expiresAt <= now) {
      deleteBlobEntry(b);
      removed += 1;
    }
  }
  return { removed };
}

export function blobStats() {
  let totalBytes = 0;
  for (const b of blobs.values()) totalBytes += b.bytes.length;
  return {
    blobs: blobs.size,
    owners: byOwner.size,
    totalBytes,
    maxPerBlob: BLOB_MAX_BYTES,
    maxPerUser: BLOB_PER_USER_BYTES,
    ttlMs: BLOB_TTL_MS,
  };
}
