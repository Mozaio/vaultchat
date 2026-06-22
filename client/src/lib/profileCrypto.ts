/**
 * E2E-encrypted user profile (display name + avatar) — GOAL Phase 1
 * "Kontakte & Profile: Anzeigename + Avatar, E2E-verschlüsselt geteilt".
 *
 * Design (Signal-style profile keys; mirrors the group-meta pattern #25 in
 * groupSecret.ts so we reuse a reviewed approach instead of inventing crypto):
 *  - Each user has a 32-byte "profile key". It is shared with contacts over the
 *    existing E2E channel (Olm) — NEVER with the server.
 *  - The profile {displayName, avatar} is serialised and encrypted client-side
 *    with the profile key using libsodium crypto_secretbox (XSalsa20-Poly1305 —
 *    NO homegrown crypto). The server only ever stores the ciphertext blob, the
 *    same way it stores `GMETA1:` group metadata.
 *  - Wire format: `PROFILE1:base64(nonce || ciphertext)`.
 *
 * SCOPE: this module is the cryptographic foundation ONLY and is currently
 * unwired (dormant). The remaining sub-steps — distributing the profile key
 * over Olm, the server ciphertext field, and the profile-editor / contact-
 * display UI — are tracked in GOAL.md and must be verified against a running
 * client (cloud/sandbox) before going live.
 */
import { base64FromUint8, uint8FromBase64 } from "./b64";
import { getSodium, sodiumReady } from "./sodium";

const PROFILE_PREFIX = "PROFILE1";

/**
 * Max avatar size (data-URL / base64 char length). Bounds the ciphertext blob
 * the server has to store, mirroring the group-avatar cap (~80–96 KB).
 */
export const MAX_PROFILE_AVATAR_CHARS = 96 * 1024;

export type ProfileData = {
  /** Display name shown to contacts. Empty/undefined = no custom name. */
  displayName?: string;
  /** Avatar as a `data:image/...;base64,...` URL, or undefined. */
  avatar?: string;
};

/** Generates a fresh 32-byte profile key, base64-encoded. */
export async function generateProfileKey(): Promise<string> {
  await sodiumReady();
  const sodium = getSodium();
  return base64FromUint8(
    sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES)
  );
}

function isProfileData(value: unknown): value is ProfileData {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.displayName !== undefined && typeof v.displayName !== "string") {
    return false;
  }
  if (v.avatar !== undefined && typeof v.avatar !== "string") return false;
  return true;
}

/** Detects an encrypted profile field (vs. legacy/absent plaintext). */
export function isEncryptedProfile(value: string | undefined | null): boolean {
  return typeof value === "string" && value.startsWith(`${PROFILE_PREFIX}:`);
}

/**
 * Encrypts a profile with the (base64) profile key → `PROFILE1:...` wire string.
 * Throws if the avatar exceeds the size cap (caller should surface a friendly
 * error / downscale before calling).
 */
export async function encryptProfile(
  profile: ProfileData,
  keyB64: string
): Promise<string> {
  if (profile.avatar && profile.avatar.length > MAX_PROFILE_AVATAR_CHARS) {
    throw new Error("profile_avatar_too_large");
  }
  await sodiumReady();
  const sodium = getSodium();
  const key = uint8FromBase64(keyB64);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ct = sodium.crypto_secretbox_easy(
    new TextEncoder().encode(JSON.stringify(profile)),
    nonce,
    key
  );
  const blob = new Uint8Array(nonce.length + ct.length);
  blob.set(nonce, 0);
  blob.set(ct, nonce.length);
  return `${PROFILE_PREFIX}:${base64FromUint8(blob)}`;
}

/**
 * Decrypts a `PROFILE1:` wire string with the (base64) profile key. Returns
 * null on wrong key / tampered / malformed input — never throws.
 */
export async function decryptProfile(
  wire: string,
  keyB64: string
): Promise<ProfileData | null> {
  if (!isEncryptedProfile(wire)) return null;
  try {
    await sodiumReady();
    const sodium = getSodium();
    const key = uint8FromBase64(keyB64);
    const blob = uint8FromBase64(wire.slice(PROFILE_PREFIX.length + 1));
    const nlen = sodium.crypto_secretbox_NONCEBYTES;
    const nonce = blob.subarray(0, nlen);
    const ct = blob.subarray(nlen);
    const pt = sodium.crypto_secretbox_open_easy(ct, nonce, key);
    const parsed = JSON.parse(new TextDecoder().decode(pt)) as unknown;
    return isProfileData(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
