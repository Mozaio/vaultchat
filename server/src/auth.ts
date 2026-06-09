import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { log } from "./logger.js";

const JwtPayload = z.object({
  sub: z.string(),
  u: z.string(),
});

export type JwtUser = { userId: string; username: string };

const JWT_SECRET = process.env.VAULTCHAT_JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  log.warn("auth_jwt_secret_missing", {
    msg: "Set VAULTCHAT_JWT_SECRET (min 32 chars) in production.",
  });
}

let _devSecretWarned = false;
const secret = () => {
  if (!JWT_SECRET || JWT_SECRET.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "VAULTCHAT_JWT_SECRET must be set in production and be at least 32 characters"
      );
    }
    if (!_devSecretWarned) {
      log.warn("auth_jwt_dev_secret", {
        msg: "Using insecure dev JWT secret. Set VAULTCHAT_JWT_SECRET in production.",
      });
      _devSecretWarned = true;
    }
    return "dev-only-insecure-secret-change-me-in-production-please";
  }
  return JWT_SECRET;
};

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

/**
 * Timing-Schutz gegen Username-Enumeration: Argon2id dominiert die
 * Login-Antwortzeit (~100-300 ms). Ohne Dummy-Verify antwortet der Server
 * bei unbekanntem Username in <5 ms — die Dauer verrät die Existenz des
 * Accounts trotz einheitlicher invalid_credentials-Meldung. Existiert der
 * User nicht, verifizieren wir deshalb gegen diesen Wegwerf-Hash mit
 * identischen Parametern und geben immer false zurück.
 */
const dummyHashPromise: Promise<string> = hashPassword(
  randomBytes(32).toString("hex")
);

export async function verifyPasswordOrDummy(
  hash: string | null | undefined,
  password: string
): Promise<boolean> {
  if (hash) return verifyPassword(hash, password);
  await verifyPassword(await dummyHashPromise, password);
  return false;
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
