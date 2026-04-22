import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { z } from "zod";

const JwtPayload = z.object({
  sub: z.string(),
  u: z.string(),
});

export type JwtUser = { userId: string; username: string };

const JWT_SECRET = process.env.VAULTCHAT_JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.warn(
    "[vaultchat] Set VAULTCHAT_JWT_SECRET (min 32 chars) in production."
  );
}

const secret = () =>
  JWT_SECRET ?? "dev-only-insecure-secret-change-me-in-production-please";

export async function hashPassword(password: string) {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
}

export async function verifyPassword(hash: string, password: string) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function signToken(user: JwtUser, ttlSec = 60 * 60 * 12) {
  return jwt.sign({ sub: user.userId, u: user.username }, secret(), {
    expiresIn: ttlSec,
    issuer: "vaultchat",
  });
}

export function verifyToken(token: string): JwtUser | null {
  try {
    const raw = jwt.verify(token, secret(), { issuer: "vaultchat" });
    const p = JwtPayload.parse(raw);
    return { userId: p.sub, username: p.u };
  } catch {
    return null;
  }
}
