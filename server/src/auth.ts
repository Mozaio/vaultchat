import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { log } from "./logger.js";

const JwtPayload = z.object({
  sub: z.string(),
  u: z.string(),
  /** Session-Start (Unix-Sekunden) — wandert beim Refresh unverändert mit
   *  und begrenzt die absolute Lebensdauer einer Sliding-Session. */
  s0: z.number().optional(),
  /** Token-Epoch zur Revocation: liegt sie unter dem aktuellen Wert des
   *  Users (via Resolver), gilt das Token als entwertet ("auf allen
   *  Geräten abmelden"). Fehlt bei Alt-Tokens → wie 0 behandelt. */
  te: z.number().optional(),
});

export type JwtUser = {
  userId: string;
  username: string;
  sessionStart?: number;
  tokenEpoch?: number;
};

/**
 * Resolver für die aktuelle Token-Epoch eines Users (per DI gesetzt, damit
 * auth.ts nicht den memoryStore importieren muss → kein Zyklus). Ist er
 * nicht gesetzt, findet KEINE Revocation-Prüfung statt (Tokens gelten wie
 * bisher) — fail-open by design.
 */
let tokenEpochResolver: ((userId: string) => number) | null = null;
export function setTokenEpochResolver(fn: (userId: string) => number): void {
  tokenEpochResolver = fn;
}

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

export function signToken(
  user: JwtUser,
  ttlSec = 60 * 60 * 12,
  sessionStartSec?: number
) {
  const s0 = sessionStartSec ?? Math.floor(Date.now() / 1000);
  return jwt.sign(
    { sub: user.userId, u: user.username, s0, te: user.tokenEpoch ?? 0 },
    secret(),
    { expiresIn: ttlSec, issuer: "vaultchat" }
  );
}

export function verifyToken(token: string): JwtUser | null {
  try {
    const raw = jwt.verify(token, secret(), { issuer: "vaultchat" });
    const p = JwtPayload.parse(raw);
    const te = typeof p.te === "number" ? p.te : 0;
    if (tokenEpochResolver) {
      let current: number;
      try {
        current = tokenEpochResolver(p.sub);
      } catch {
        // Resolver-Fehler darf NICHT alle aussperren — Verfügbarkeit geht
        // hier vor einem Edge-Case-Revoke.
        current = te;
      }
      if (te < current) return null; // via logout-all entwertet
    }
    return {
      userId: p.sub,
      username: p.u,
      ...(typeof p.s0 === "number" ? { sessionStart: p.s0 } : {}),
      tokenEpoch: te,
    };
  } catch {
    return null;
  }
}
