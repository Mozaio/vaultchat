import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { loadRuntimeConfig } from "./config.js";
import {
  loadRedeemedInviteCodeHashes,
  persistRedeemedInviteCodeHashes,
} from "./serverState.js";

function splitEnvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantTimeEqualHex(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

export function publicRegistrationConfig() {
  return {
    mode: loadRuntimeConfig().registrationMode,
    inviteRequired: loadRuntimeConfig().registrationMode === "invite",
  };
}

export function validateInviteCode(inviteCode: unknown): {
  ok: boolean;
  error?: "registration_closed" | "invite_required" | "invalid_invite";
} {
  const config = loadRuntimeConfig();
  if (config.registrationMode === "closed") return { ok: false, error: "registration_closed" };
  if (config.registrationMode === "open") return { ok: true };

  const parsed = z.string().min(8).max(256).safeParse(inviteCode);
  if (!parsed.success) return { ok: false, error: "invite_required" };

  const codeHash = sha256Hex(parsed.data);
  if (loadRuntimeConfig().stateFileConfigured) {
    const redeemed = loadRedeemedInviteCodeHashes();
    if (redeemed.some((hash) => constantTimeEqualHex(codeHash, hash))) {
      return { ok: false, error: "invalid_invite" };
    }
  }
  const plainCodes = splitEnvList(process.env.VAULTCHAT_INVITE_CODES).map(sha256Hex);
  const hashedCodes = splitEnvList(process.env.VAULTCHAT_INVITE_CODE_HASHES);
  const allowedHashes = [...plainCodes, ...hashedCodes];
  const ok = allowedHashes.some((allowed) => constantTimeEqualHex(codeHash, allowed));
  return ok ? { ok: true } : { ok: false, error: "invalid_invite" };
}

export function redeemInviteCode(inviteCode: unknown): void {
  if (loadRuntimeConfig().registrationMode !== "invite") return;
  if (!loadRuntimeConfig().stateFileConfigured) return;
  const parsed = z.string().min(8).max(256).safeParse(inviteCode);
  if (!parsed.success) return;
  const codeHash = sha256Hex(parsed.data);
  const redeemed = loadRedeemedInviteCodeHashes();
  if (redeemed.some((hash) => constantTimeEqualHex(codeHash, hash))) return;
  persistRedeemedInviteCodeHashes([...redeemed, codeHash]);
}
