import cors, { type CorsOptions } from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { createHmac, createPublicKey, randomUUID, verify as verifySignature } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import {
  addGroupMember,
  createGroup,
  createUser,
  deleteUserCompletely,
  findUserById,
  findUserByUsername,
  getDirectoryStats,
  getGroup,
  leaveGroup,
  listGroupsForUser,
  listUsersSafe,
  removeGroupMember,
  updateGroupProfile,
} from "./memoryStore.js";
import { hashPassword, signToken, verifyPassword, verifyToken } from "./auth.js";
import { getWsStats, registerClient, sendToUser } from "./wsHub.js";
import {
  enqueueMailboxDm,
  clearMailboxForUser,
  enqueueMailboxGroup,
  getMailboxStats,
  listMailboxDms,
  listMailboxGroups,
  removeMailboxDm,
  removeMailboxGroup,
  sweepExpiredMailbox,
} from "./mailboxStore.js";
import {
  deletePreKeyBundle,
  getPreKeyBundle,
  getPreKeyStats,
  getRemainingOlmKeyCount,
  getRemainingPreKeyCount,
  initPreKeyBundle,
  uploadOlmKeys,
  uploadOneTimePreKeys,
} from "./prekeyStore.js";
import {
  assertRuntimeConfig,
  loadRuntimeConfig,
  validateRuntimeConfig,
} from "./config.js";
import { getStateStatus } from "./serverState.js";
import { publicRegistrationConfig, redeemInviteCode, validateInviteCode } from "./registration.js";
import {
  createInvite,
  listInvites,
  redeemInvite,
  revokeInvite,
} from "./inviteStore.js";
import { clientIpTag, log, requestLogger } from "./logger.js";
import {
  clearReplayState,
  markIfNew as markEnvelopeIfNew,
  replayStats,
} from "./replayStore.js";
import {
  blobStats,
  getBlob,
  storeBlob,
  sweepExpiredBlobs,
  unlinkBlob,
} from "./blobStore.js";

assertRuntimeConfig();

const app = express();
const port = Number(process.env.PORT ?? 8787);

function splitEnvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

const clientOrigins = splitEnvList(process.env.VAULTCHAT_CLIENT_ORIGINS);
const corsOrigins = splitEnvList(process.env.VAULTCHAT_CORS_ORIGIN);
const apiOrigins = splitEnvList(process.env.VAULTCHAT_CONNECT_ORIGINS);
const connectSrc = [
  "'self'",
  ...clientOrigins,
  ...corsOrigins,
  ...apiOrigins,
  ...(process.env.NODE_ENV === "production" ? ["wss:"] : ["ws:", "wss:"]),
];
// The Tauri desktop app serves its bundled UI from a local WebView origin —
// WebView2 (Windows) uses http(s)://tauri.localhost, macOS/Linux use
// tauri://localhost. It is a first-party client, so its fixed origins are
// always permitted. This is NOT a wildcard: arbitrary web origins still must
// be listed in VAULTCHAT_CORS_ORIGIN.
const DESKTOP_ORIGINS = new Set<string>([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
]);
function isDesktopOrigin(origin: string): boolean {
  if (DESKTOP_ORIGINS.has(origin)) return true;
  try {
    return new URL(origin).hostname === "tauri.localhost";
  } catch {
    return false;
  }
}
const corsAllow = new Set<string>(corsOrigins);
const corsOrigin: CorsOptions["origin"] =
  process.env.NODE_ENV === "production"
    ? (origin, cb) => {
        // No Origin header (same-origin, health checks, server-to-server).
        if (!origin) return cb(null, true);
        cb(null, corsAllow.has(origin) || isDesktopOrigin(origin));
      }
    : true;

app.set("trust proxy", 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'self'"],
        // wasm-unsafe-eval erforderlich für libsodium-wrappers-sumo (Argon2-WASM)
        // und @matrix-org/olm (Olm/Megolm WASM, auditierte Krypto-Implementation).
        "script-src": ["'self'", "'wasm-unsafe-eval'"],
        "script-src-attr": ["'none'"],
        "style-src": ["'self'"],
        "style-src-attr": ["'unsafe-inline'"],
        "img-src": ["'self'", "data:", "blob:"],
        "media-src": ["'self'", "data:", "blob:"],
        "font-src": ["'self'", "data:"],
        "connect-src": Array.from(new Set(connectSrc)),
        "worker-src": ["'self'", "blob:"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"],
        "frame-ancestors": ["'none'"],
        "manifest-src": ["'self'"],
        "upgrade-insecure-requests": [],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "no-referrer" },
    hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
  })
);
app.use((_req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()");
  next();
});
app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  })
);
app.use(express.json({ limit: process.env.VAULTCHAT_JSON_LIMIT ?? "12mb" }));
app.use(requestLogger);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
});
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
const groupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
// Prekey fetches consume a one-time key per call (Olm needs an OTK to start
// a session). An unbounded loop could drain a victim's OTK pool and block
// new sessions (DoS). 120/min/IP is generous for legitimate bulk session
// setup (e.g. opening a large group) while capping a tight exhaustion loop.
// NOTE: a determined slow attacker can still deplete over time — the proper
// fix is per-(requester,target) OTK dedup or Olm fallback keys (tracked).
const keysLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
// Strenger Limiter für den UNAUTHENTIFIZIERTEN Sealed-Sender-Endpunkt (#26):
// begrenzt die DoS-Verstärkung (1 Request → N Zustellungen) pro IP.
const sealedGroupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api", apiLimiter);

app.get("/healthz", (_req, res) => {
  res.status(200).type("text/plain").send("ok");
});

app.get("/readyz", (_req, res) => {
  const config = loadRuntimeConfig();
  const configProblems = validateRuntimeConfig(config);
  const state = getStateStatus();
  const problems = [
    ...configProblems,
    ...(state.writable ? [] : [`state file is not writable: ${state.error ?? "unknown"}`]),
  ];
  res.status(problems.length ? 503 : 200).json({
    ok: problems.length === 0,
    profile: config.profile,
    state: {
      mode: state.mode,
      configured: state.mode === "persistent",
      writable: state.writable,
    },
    problems,
  });
});

/**
 * Aggregierte Runtime-Stats. Für Operations-Dashboards. KEINE PII —
 * nur Counter/Größen, keine User-IDs oder Inhalte.
 *
 * Endpoint ist offen (kein Auth), aber der Output wäre für jemanden
 * außerhalb von Operations belanglos. Falls Bedenken: VAULTCHAT_STATS_TOKEN
 * env var prüfen und 401 zurückgeben — aktuell nicht eingebaut.
 */
app.get("/api/stats", (_req, res) => {
  const ws = getWsStats();
  const mailbox = getMailboxStats();
  const directory = getDirectoryStats();
  const prekey = getPreKeyStats();
  const replay = replayStats();
  const blobs = blobStats();
  const memory = process.memoryUsage();
  res.json({
    uptime: Math.round(process.uptime()),
    ws,
    mailbox,
    directory,
    prekey,
    replay,
    blobs,
    memory: {
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
      external: Math.round(memory.external / 1024 / 1024),
    },
    nodeVersion: process.version,
  });
});

const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{1,31}$/;
const INVALID_USERNAME_PAIR_RE = /__|--|-_|_-/;
const Plan = z.enum(["personal", "pro", "team"]);

const RegisterBody = z.object({
  username: z
    .string()
    .min(2)
    .max(32)
    .regex(USERNAME_RE)
    .refine((name) => !/[_-]$/.test(name) && !INVALID_USERNAME_PAIR_RE.test(name)),
  password: z.string().min(10).max(256),
  publicKey: z.string().min(16),
  recoveryEmail: z.string().email().max(254).optional(),
  requestedPlan: Plan.optional(),
  inviteCode: z.string().max(256).optional(),
});

const LoginBody = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

// E2EE-Gruppen-Metadaten: Avatar/Name/Beschreibung werden client-seitig mit
// dem Group-Master-Key verschlüsselt und als `GMETA1:{epoch}:{base64}`-Blob
// abgelegt — der Server sieht weder Bild noch Text. Das Limit deckt einen
// verschlüsselten ~100-KB-Avatar ab (crypto_secretbox + base64 ≈ 1.34×).
const GMETA_CIPHERTEXT_RE = /^GMETA1:\d+:[A-Za-z0-9+\/=]+$/;
const MAX_GROUP_AVATAR_LENGTH = 150_000;
const AvatarString = z
  .string()
  .max(MAX_GROUP_AVATAR_LENGTH)
  .refine(
    (v) =>
      v === "" ||
      /^data:image\/(png|jpeg|webp);base64,/.test(v) ||
      GMETA_CIPHERTEXT_RE.test(v),
    { message: "avatar_must_be_data_image_or_e2ee_blob" }
  );

// Beschreibung: Klartext bleibt kurz (UI-seitig ≤280), der GMETA1-Ciphertext
// eines 280-Zeichen-Texts ist jedoch länger (Nonce+MAC+base64) — daher 1024.
const DescriptionString = z.string().max(1024);

// name darf bis 2048 Zeichen lang sein: bei E2EE-Gruppen enthält das Feld
// statt Klartext einen GMETA1-Ciphertext-Blob (Server kann den Namen nicht
// lesen). Plaintext-Namen sind UI-seitig weiterhin kurz.
const CreateGroupBody = z.object({
  name: z.string().min(1).max(2048),
  memberIds: z.array(z.string().uuid()).min(1),
  description: DescriptionString.optional(),
  avatar: AvatarString.optional(),
});

const UpdateGroupBody = z.object({
  name: z.string().min(1).max(2048).optional(),
  description: DescriptionString.optional(),
  avatar: AvatarString.optional(),
});

type GroupResponse = {
  id: string;
  name: string;
  memberIds: string[];
  createdByUserId: string;
  createdAt: number;
  description?: string;
  avatar?: string;
  updatedAt?: number;
};

function shapeGroup(g: {
  id: string;
  name: string;
  memberIds: string[];
  createdByUserId: string;
  createdAt: number;
  description?: string;
  avatar?: string;
  updatedAt?: number;
}): GroupResponse {
  const out: GroupResponse = {
    id: g.id,
    name: g.name,
    memberIds: g.memberIds,
    createdByUserId: g.createdByUserId,
    createdAt: g.createdAt,
  };
  if (g.description) out.description = g.description;
  if (g.avatar) out.avatar = g.avatar;
  if (g.updatedAt) out.updatedAt = g.updatedAt;
  return out;
}

function bearer(req: express.Request): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return null;
  return h.slice(7);
}

app.post("/api/register", authLimiter, async (req, res) => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const invite = validateInviteCode(parsed.data.inviteCode);
  if (!invite.ok) {
    res.status(invite.error === "registration_closed" ? 403 : 401).json({ error: invite.error });
    return;
  }
  const { username, password, publicKey } = parsed.data;
  const passwordHash = await hashPassword(password);
  const user = createUser({
    username,
    passwordHash,
    publicKey,
    plan: "personal",
    requestedPlan: parsed.data.requestedPlan,
    ...(parsed.data.recoveryEmail
      ? { recoveryEmailHash: recoveryEmailHash(parsed.data.recoveryEmail) }
      : {}),
  });
  if (!user) {
    log.info("auth_register_fail", {
      reqId: req.id,
      username: username.slice(0, 32),
      reason: "username_taken",
      ipTag: clientIpTag(req.ip),
    });
    res.status(409).json({ error: "username_taken" });
    return;
  }
  redeemInviteCode(parsed.data.inviteCode);
  log.info("auth_register_ok", {
    reqId: req.id,
    userId: user.id,
    username: user.username,
    plan: user.plan,
    requestedPlan: parsed.data.requestedPlan ?? null,
    ipTag: clientIpTag(req.ip),
  });
  const token = signToken({ userId: user.id, username: user.username });
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      publicKey: user.publicKey,
      plan: user.plan,
      recoveryEmailConfigured: Boolean(user.recoveryEmailHash),
    },
  });
});

app.post("/api/login", authLimiter, async (req, res) => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const { username, password } = parsed.data;
  const user = findUserByUsername(username);
  if (!user || !(await verifyPassword(user.passwordHash, password))) {
    log.info("auth_login_fail", {
      reqId: req.id,
      username: username.slice(0, 32),
      reason: user ? "wrong_password" : "user_not_found",
      ipTag: clientIpTag(req.ip),
    });
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }
  const token = signToken({ userId: user.id, username: user.username });
  log.info("auth_login_ok", {
    reqId: req.id,
    userId: user.id,
    username: user.username,
    ipTag: clientIpTag(req.ip),
  });
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      publicKey: user.publicKey,
      plan: user.plan ?? "personal",
      recoveryEmailConfigured: Boolean(user.recoveryEmailHash),
    },
  });
});

// ---------------------------------------------------------------------------
// Blob-Store für Chunked-File-Upload (Foundation, kein Client-Adopter yet).
// Verschlüsselte Ciphertext-Bytes vom Client; Server speichert lediglich
// content-addressed unter SHA-256 mit Owner-Tag.
// ---------------------------------------------------------------------------
const BLOB_MAX_REQ_BYTES = 32 * 1024 * 1024 + 4096;
app.post(
  "/api/blobs",
  express.raw({ type: "application/octet-stream", limit: BLOB_MAX_REQ_BYTES }),
  (req, res) => {
    const t = bearer(req);
    if (!t) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const jwtUser = verifyToken(t);
    if (!jwtUser) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body)) {
      res.status(400).json({ error: "expected_octet_stream" });
      return;
    }
    const result = storeBlob(jwtUser.userId, body);
    if (!result.ok) {
      res.status(result.reason === "too_large" ? 413 : 400).json({
        error: result.reason,
      });
      return;
    }
    res.json({ id: result.id, size: result.size, deduped: result.deduped });
  }
);

app.get("/api/blobs/:id", (req, res) => {
  const t = bearer(req);
  if (!t) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const jwtUser = verifyToken(t);
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const id = req.params.id ?? "";
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
    res.status(400).json({ error: "invalid_id" });
    return;
  }
  const bytes = getBlob(jwtUser.userId, id);
  if (!bytes) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.set("Content-Type", "application/octet-stream");
  res.set("Cache-Control", "private, max-age=0, no-store");
  res.send(bytes);
});

app.delete("/api/blobs/:id", (req, res) => {
  const t = bearer(req);
  if (!t) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const jwtUser = verifyToken(t);
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const id = req.params.id ?? "";
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
    res.status(400).json({ error: "invalid_id" });
    return;
  }
  const removed = unlinkBlob(jwtUser.userId, id);
  res.status(removed ? 204 : 404).end();
});

/**
 * Self-delete: User löscht den eigenen Account.
 *
 * - Entfernt den User aus allen Group-Memberships
 * - Droppt Gruppen, die danach leer sind
 * - Löscht Pre-Keys, Mailbox-Einträge und Replay-State
 * - Server-Daten sind weg; lokale Identity muss der Client selbst wipen
 *   (clearLocalIdentity + IDB delete) — das passiert UI-seitig nach
 *   erfolgreicher Response.
 *
 * Passwortbestätigung ist NICHT eingebaut weil JWT-Authentifizierung
 * bereits den Besitz nachweist. Der Client soll trotzdem einen
 * "Wirklich löschen?"-Dialog zeigen (siehe SecuritySettings).
 */
app.delete("/api/me", async (req, res) => {
  const t = bearer(req);
  if (!t) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const jwtUser = verifyToken(t);
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const removed = deleteUserCompletely(jwtUser.userId);
  if (!removed) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // Purge all remaining server-side state for this user so nothing lingers
  // after deletion (matches the contract documented above): prekey bundle,
  // queued inbox (DM + group), and replay state.
  deletePreKeyBundle(jwtUser.userId);
  clearMailboxForUser(jwtUser.userId);
  clearReplayState(jwtUser.userId);
  log.info("auth_account_deleted", {
    reqId: req.id,
    userId: jwtUser.userId,
    username: jwtUser.username,
    ipTag: clientIpTag(req.ip),
  });
  res.status(204).end();
});

app.get("/api/me", async (req, res) => {
  const t = bearer(req);
  if (!t) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const jwtUser = verifyToken(t);
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const user = findUserById(jwtUser.userId);
  if (!user) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({
    id: user.id,
    username: user.username,
    publicKey: user.publicKey,
    plan: user.plan ?? "personal",
    recoveryEmailConfigured: Boolean(user.recoveryEmailHash),
  });
});

app.get("/api/public-config", (_req, res) => {
  res.json({
    registration: publicRegistrationConfig(),
    product: publicProductConfig(),
  });
});

app.get("/api/server/status", async (req, res) => {
  const t = bearer(req);
  if (!t || !verifyToken(t)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const config = loadRuntimeConfig();
  const state = getStateStatus();
  res.json({
    profile: config.profile,
    state: {
      mode: state.mode,
      writable: state.writable,
    },
    directory: getDirectoryStats(),
    preKeys: getPreKeyStats(),
    mailbox: getMailboxStats(),
    realtime: getWsStats(),
    privacy: {
      sealedDmMailbox: true,
      sealedGroupMailbox: true,
      messageContentPersistentOnServer: false,
      recoveryEmailStoredAsHash: true,
      urlTokenAuthEnabled: process.env.VAULTCHAT_ALLOW_WS_URL_TOKEN === "1",
    },
    registration: publicRegistrationConfig(),
    product: publicProductConfig(),
  });
});

app.get("/api/users", async (req, res) => {
  const t = bearer(req);
  const jwtUser = t ? verifyToken(t) : null;
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const ids = (req.query.ids as string | undefined)
    ?.split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 50);
  if (!ids?.length) {
    res.json({ users: [] });
    return;
  }
  const users = ids.flatMap((id) => {
    const u = findUserById(id);
    return u ? [{ id: u.id, username: u.username, publicKey: u.publicKey }] : [];
  });
  res.json({ users });
});

// Username-Suche: EXAKTER Match only (privacy by design, Signal/Session-Stil).
// Kein Substring/Prefix-Browsing des Verzeichnisses — man muss den exakten
// Username bereits kennen. Das verhindert Enumeration/Scraping des gesamten
// Nutzerverzeichnisses (inkl. Public Keys). Da Usernames eindeutig sind,
// liefert der exakte Match höchstens einen Treffer; dessen Public-Key
// herauszugeben ist unkritisch, weil der Anfragende den Namen schon kannte.
app.get("/api/users/search", searchLimiter, async (req, res) => {
  const t = bearer(req);
  if (!t || !verifyToken(t)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const query = (req.query.q as string | undefined)?.trim().toLowerCase() ?? "";
  const currentUser = verifyToken(t);

  if (!query) {
    res.json({ users: [] });
    return;
  }

  const results = listUsersSafe().filter(
    (u) => u.username.toLowerCase() === query && u.id !== currentUser?.userId
  );

  res.json({ users: results });
});

app.post("/api/groups", groupLimiter, async (req, res) => {
  const t = bearer(req);
  const jwtUser = t ? verifyToken(t) : null;
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const parsed = CreateGroupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const memberIds = [...new Set([...parsed.data.memberIds, jwtUser.userId])];
  for (const mid of memberIds) {
    if (!findUserById(mid)) {
      res.status(400).json({ error: "unknown_member" });
      return;
    }
  }
  const g = createGroup({
    name: parsed.data.name,
    memberIds,
    createdByUserId: jwtUser.userId,
    ...(parsed.data.description ? { description: parsed.data.description } : {}),
    ...(parsed.data.avatar ? { avatar: parsed.data.avatar } : {}),
  });
  log.info("group_created", {
    reqId: req.id,
    groupId: g.id,
    createdBy: jwtUser.userId,
    memberCount: memberIds.length,
  });
  res.json({ group: shapeGroup(g) });
});

app.get("/api/groups", async (req, res) => {
  const t = bearer(req);
  const jwtUser = t ? verifyToken(t) : null;
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const list = listGroupsForUser(jwtUser.userId).map(shapeGroup);
  res.json({ groups: list });
});

// SEALED-SENDER für Gruppen (#26): BEWUSST UNAUTHENTIFIZIERT — der Server
// lernt so NIE, WER die Nachricht gesendet hat (Metadaten-Privatsphäre). Nur
// wer die (hochentropische) groupId kennt, kann senden; Missbrauch ist durch
// Rate-Limit + Größencap begrenzt, und Empfänger verwerfen nicht
// entschlüsselbaren Müll (Megolm). Der Server leitet nur opaken Ciphertext an
// alle Mitglieder weiter — online via WS, offline via Mailbox.
app.post("/api/groups/:id/sealed", sealedGroupLimiter, (req, res) => {
  const parsed = SealedGroupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const groupId = String(req.params.id);
  const g = getGroup(groupId);
  // Existenz nicht leaken: bei unbekannter Gruppe einfach 204 (no-op).
  if (!g) {
    res.status(204).end();
    return;
  }
  // Replay-Dedup pro Gruppe (OHNE Sender-Identität).
  if (!markEnvelopeIfNew(`sealed:${groupId}`, parsed.data.ciphertext)) {
    res.status(204).end();
    return;
  }
  const id = randomUUID();
  const createdAt = Date.now();
  // An ALLE Mitglieder verteilen — wir kennen den Absender nicht, also können
  // wir ihn nicht ausschließen; sein eigener Client dedupliziert per cid.
  for (const mid of g.memberIds) {
    const frame = {
      type: "group",
      id,
      groupId,
      ciphertext: parsed.data.ciphertext,
      createdAt,
    };
    const n = sendToUser(mid, frame);
    if (n === 0) {
      enqueueMailboxGroup({
        id,
        toUserId: mid,
        groupId,
        ciphertext: parsed.data.ciphertext,
        createdAt,
      });
    }
  }
  res.status(204).end();
});

app.patch("/api/groups/:id", groupLimiter, async (req, res) => {
  const t = bearer(req);
  const jwtUser = t ? verifyToken(t) : null;
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const parsed = UpdateGroupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const groupId = String(req.params.id);
  const g = updateGroupProfile(groupId, jwtUser.userId, parsed.data);
  if (!g) {
    res.status(403).json({ error: "cannot_update" });
    return;
  }
  res.json({ group: shapeGroup(g) });
});

const MemberBody = z.object({ memberId: z.string().uuid() });

app.post("/api/groups/:id/members", groupLimiter, async (req, res) => {
  const t = bearer(req);
  const jwtUser = t ? verifyToken(t) : null;
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const parsed = MemberBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const groupId = String(req.params.id);
  const g = addGroupMember(groupId, jwtUser.userId, parsed.data.memberId);
  if (!g) {
    res.status(400).json({ error: "cannot_add" });
    return;
  }
  // Notify all OTHER members AND the newly-added member so everyone refreshes
  // the member list and (re-)distributes the Megolm group key to the joiner.
  // Without this, a directly-added member sits in memberIds on the server but
  // nobody learns to send them the session key → they can never decrypt the
  // group's messages (root cause of "new members don't see anything"). Mirrors
  // the invite-redeem notification path.
  for (const memberId of g.memberIds) {
    if (memberId === jwtUser.userId) continue;
    sendToUser(memberId, {
      type: "group_member_added",
      groupId,
      memberId: parsed.data.memberId,
    });
  }
  log.info("group_member_added", {
    reqId: req.id,
    groupId,
    actorId: jwtUser.userId,
    memberId: parsed.data.memberId,
    memberCount: g.memberIds.length,
  });
  res.json({ group: shapeGroup(g) });
});

app.delete("/api/groups/:id/members/:memberId", groupLimiter, async (req, res) => {
  const t = bearer(req);
  const jwtUser = t ? verifyToken(t) : null;
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const groupId = String(req.params.id);
  const memberId = String(req.params.memberId);
  const g = removeGroupMember(groupId, jwtUser.userId, memberId);
  if (!g) {
    res.status(400).json({ error: "cannot_remove" });
    return;
  }
  // SECURITY: notify the REMAINING members so each rotates their group key
  // and re-distributes it to the current member set only — otherwise the
  // removed member, who still holds everyone's old Megolm key, could keep
  // reading their future messages (forward secrecy on membership change).
  // The actor (admin) already rotates locally, so skip them here.
  for (const remaining of g.memberIds) {
    if (remaining === jwtUser.userId) continue;
    sendToUser(remaining, {
      type: "group_member_removed",
      groupId,
      memberId,
    });
  }
  log.info("group_member_removed", {
    reqId: req.id,
    groupId,
    actorId: jwtUser.userId,
    memberId,
    memberCount: g.memberIds.length,
  });
  res.json({ group: shapeGroup(g) });
});

const CreateInviteBody = z.object({
  ttlMs: z.number().int().min(0).max(90 * 24 * 60 * 60 * 1000).optional(),
  maxUses: z.number().int().min(0).max(10_000).optional(),
});

app.post("/api/groups/:id/invites", groupLimiter, async (req, res) => {
  const t = bearer(req);
  const jwtUser = t ? verifyToken(t) : null;
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const parsed = CreateInviteBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const result = createInvite(String(req.params.id), jwtUser.userId, {
    ...(parsed.data.ttlMs !== undefined ? { ttlMs: parsed.data.ttlMs } : {}),
    ...(parsed.data.maxUses !== undefined ? { maxUses: parsed.data.maxUses } : {}),
  });
  if ("error" in result) {
    res.status(result.error === "forbidden" ? 403 : 404).json({ error: result.error });
    return;
  }
  res.json({ invite: result });
});

app.get("/api/groups/:id/invites", groupLimiter, async (req, res) => {
  const t = bearer(req);
  const jwtUser = t ? verifyToken(t) : null;
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const result = listInvites(String(req.params.id), jwtUser.userId);
  if (!Array.isArray(result)) {
    res.status(result.error === "forbidden" ? 403 : 404).json({ error: result.error });
    return;
  }
  res.json({ invites: result });
});

app.delete("/api/groups/invites/:token", groupLimiter, async (req, res) => {
  const t = bearer(req);
  const jwtUser = t ? verifyToken(t) : null;
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const result = revokeInvite(String(req.params.token), jwtUser.userId);
  if ("error" in result) {
    res.status(result.error === "forbidden" ? 403 : 404).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

app.post("/api/invites/:token/redeem", groupLimiter, async (req, res) => {
  const t = bearer(req);
  const jwtUser = t ? verifyToken(t) : null;
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const result = redeemInvite(String(req.params.token), jwtUser.userId);
  if ("error" in result) {
    const status = result.error === "unknown_token" ? 404 : 400;
    res.status(status).json({ error: result.error });
    return;
  }
  // Notify the rest of the group so a member (typically the creator) can
  // rotate and re-distribute the group key — the joiner is now in the
  // member list but does not yet have the group key.
  const g = getGroup(result.groupId);
  if (g) {
    for (const memberId of g.memberIds) {
      if (memberId === jwtUser.userId) continue;
      sendToUser(memberId, {
        type: "group_member_added",
        groupId: result.groupId,
        memberId: jwtUser.userId,
        byInvite: true,
      });
    }
  }
  res.json(result);
});

app.post("/api/groups/:id/leave", async (req, res) => {
  const t = bearer(req);
  const jwtUser = t ? verifyToken(t) : null;
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const g = leaveGroup(req.params.id, jwtUser.userId);
  if (!g) {
    res.status(400).json({ error: "cannot_leave" });
    return;
  }
  // SECURITY: the leaver still holds every remaining member's Megolm key, so
  // each remaining member must rotate + re-distribute to exclude the leaver
  // (forward secrecy). The leaver is no longer in g.memberIds.
  for (const remaining of g.memberIds) {
    sendToUser(remaining, {
      type: "group_member_removed",
      groupId: req.params.id,
      memberId: jwtUser.userId,
    });
  }
  log.info("group_left", {
    reqId: req.id,
    groupId: req.params.id,
    userId: jwtUser.userId,
    remainingMembers: g.memberIds.length,
  });
  res.json({ ok: true });
});

/**
 * ICE-Konfiguration für WebRTC. TURN via ENV-Vars:
 *   VAULTCHAT_TURN_URL, VAULTCHAT_TURN_USER, VAULTCHAT_TURN_PASS
 * Ohne TURN wird nur ein STUN-Server zurückgegeben (kann in NAT-Setups
 * scheitern). Für IP-Schutz sollte der Client zusätzlich "Relay-Only"
 * aktivieren.
 */
app.get("/api/rtc/config", async (req, res) => {
  const t = bearer(req);
  if (!t || !verifyToken(t)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const forceRelay = process.env.VAULTCHAT_FORCE_RELAY === "1";
  const turnUrls = splitEnvList(process.env.VAULTCHAT_TURN_URL);
  const stunUrls = forceRelay
    ? []
    : splitEnvList(process.env.VAULTCHAT_STUN_URL).length
      ? splitEnvList(process.env.VAULTCHAT_STUN_URL)
      : ["stun:stun.l.google.com:19302"];
  const servers: { urls: string | string[]; username?: string; credential?: string }[] =
    stunUrls.map((urls) => ({ urls }));
  for (const turnUrl of turnUrls) {
    servers.push({
      urls: turnUrl,
      username: process.env.VAULTCHAT_TURN_USER ?? "",
      credential: process.env.VAULTCHAT_TURN_PASS ?? "",
    });
  }
  res.json({
    iceServers: servers,
    forceRelay,
    warning: forceRelay && turnUrls.length === 0 ? "force_relay_without_turn" : undefined,
  });
});

app.get("/api/keys/:userId", keysLimiter, async (req, res) => {
  const t = bearer(req);
  if (!t || !verifyToken(t)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const bundle = getPreKeyBundle(String(req.params.userId));
  if (!bundle) {
    res.status(404).json({ error: "no_keys" });
    return;
  }
  res.json(bundle);
});

const PreKeyUploadBody = z.object({
  // Phase 5: signedPreKey + OTKs + pqKem sind die Legacy-X3DH-Felder,
  // werden auf dem Client nicht mehr generiert. Optional gemacht damit
  // der Endpoint nur noch das Nötige fordert. Olm-Felder sind ab jetzt
  // die einzige Pflicht.
  signedPreKey: z
    .object({
      keyId: z.number(),
      publicKey: z.string(),
      signature: z.string(),
      signingPublicKey: z.string().min(1),
    })
    .optional(),
  oneTimePreKeys: z
    .array(z.object({ keyId: z.number(), publicKey: z.string() }))
    .max(200)
    .optional(),
  pqKem: z
    .object({
      alg: z.literal("ML-KEM-1024"),
      publicKey: z.string().min(1).max(4096),
    })
    .optional(),
  /** Auditierte Olm-Schicht (Matrix.org) — alleiniger Krypto-Pfad. */
  olm: z.object({
    identityCurve25519: z.string().min(1).max(256),
    identityEd25519: z.string().min(1).max(256),
    oneTimeKeys: z
      .array(
        z.object({
          keyId: z.string().min(1).max(64),
          publicKey: z.string().min(1).max(256),
        })
      )
      .max(200),
  }),
});

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function verifySignedPreKey(input: {
  publicKey: string;
  signature: string;
  signingPublicKey?: string;
}): boolean {
  if (!input.signingPublicKey) return false;
  try {
    const publicKey = Buffer.from(input.publicKey, "base64");
    const signature = Buffer.from(input.signature, "base64");
    const signingPublicKey = Buffer.from(input.signingPublicKey, "base64");
    if (publicKey.length !== 32 || signature.length !== 64 || signingPublicKey.length !== 32) {
      return false;
    }
    const keyObject = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, signingPublicKey]),
      format: "der",
      type: "spki",
    });
    return verifySignature(null, publicKey, keyObject, signature);
  } catch {
    return false;
  }
}

app.post("/api/keys", async (req, res) => {
  const t = bearer(req);
  const jwtUser = t ? verifyToken(t) : null;
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const parsed = PreKeyUploadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const user = findUserById(jwtUser.userId);
  if (!user) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // Legacy-Felder bleiben optional verarbeitet — werden vom Olm-Client
  // nicht mehr geliefert, aber Server schluckt sie weiter für Test-Tools.
  if (parsed.data.signedPreKey) {
    if (!verifySignedPreKey(parsed.data.signedPreKey)) {
      res.status(400).json({ error: "invalid_signed_prekey_signature" });
      return;
    }
    initPreKeyBundle(
      jwtUser.userId,
      user.publicKey,
      parsed.data.signedPreKey.publicKey,
      parsed.data.signedPreKey.signature,
      parsed.data.signedPreKey.signingPublicKey,
      parsed.data.signedPreKey.keyId,
      parsed.data.pqKem
    );
    if (parsed.data.oneTimePreKeys) {
      uploadOneTimePreKeys(jwtUser.userId, parsed.data.oneTimePreKeys);
    }
  }
  // Hauptpfad: Olm-Identity + OTKs (auto-init wenn kein Legacy-Bundle da).
  uploadOlmKeys(jwtUser.userId, parsed.data.olm, user.publicKey);
  res.json({
    ok: true,
    remaining: getRemainingPreKeyCount(jwtUser.userId),
    remainingOlm: getRemainingOlmKeyCount(jwtUser.userId),
  });
});

const server = createServer(app);
/**
 * E2E-DM: base64(Envelope) / Gruppen-ciphertext. Zod-Maxlänge = erlaubter Umschlag.
 * WebSocket-Frame etwas größer (JSON-Metadaten um `envelope` herum).
 */
const MAX_B64_CIPHERTEXT = Number(
  process.env.VAULTCHAT_MAX_B64_CIPHERTEXT_BYTES ?? 16 * 1024 * 1024
);
const WS_MAX_FRAME_BYTES = MAX_B64_CIPHERTEXT + 4 * 1024 * 1024;

// Sealed-Sender-Body (#26): hier definiert, weil es MAX_B64_CIPHERTEXT braucht
// (das erst hier deklariert ist). Der Route-Handler oben nutzt es lazy.
const SealedGroupBody = z.object({
  ciphertext: z.string().min(1).max(MAX_B64_CIPHERTEXT),
});

const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: WS_MAX_FRAME_BYTES,
});

// Server-side heartbeat: wir senden alle 30s einen WebSocket-Ping (control
// frame, vom Client-Code unsichtbar — ws.on("pong") wird automatisch
// gefeuert). Wenn ein Client zwischen zwei Heartbeats keinen Pong schickt,
// terminieren wir die Verbindung. Schützt vor "Zombie-Sockets" wenn Wifi
// abgerissen ist und kein FIN/RST kam (typisch beim Mobile-Netzwerk-Wechsel
// oder NAT-Timeout).
const WS_HEARTBEAT_MS = 30_000;
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    const alive = (ws as WebSocket & { _vcAlive?: boolean })._vcAlive;
    if (alive === false) {
      // Letzter Ping wurde nicht beantwortet → killen.
      log.debug("ws_heartbeat_timeout", {});
      try {
        ws.terminate();
      } catch {
        /* socket already closed */
      }
      continue;
    }
    (ws as WebSocket & { _vcAlive?: boolean })._vcAlive = false;
    try {
      ws.ping();
    } catch {
      /* socket between OPEN and CLOSED — wird im nächsten Tick gehandled */
    }
  }
}, WS_HEARTBEAT_MS);
heartbeat.unref?.();
wss.on("close", () => clearInterval(heartbeat));

// Mailbox-Sweep alle 5 min: räumt expired Einträge inaktiver Recipients
// auf, ohne darauf zu warten dass jemand list/pop aufruft. Wichtig auf
// Render-Free wo Memory knapp ist.
const MAILBOX_SWEEP_MS = 5 * 60_000;
const mailboxSweep = setInterval(() => {
  const r = sweepExpiredMailbox();
  if (r.removedDms + r.removedGroups > 0) {
    log.info("mailbox_sweep", r);
  }
}, MAILBOX_SWEEP_MS);
mailboxSweep.unref?.();

// Blob-Sweep alle 15 min: TTL ist 30 Tage default, also reicht das.
const BLOB_SWEEP_MS = 15 * 60_000;
const blobSweep = setInterval(() => {
  const r = sweepExpiredBlobs();
  if (r.removed > 0) log.info("blob_sweep", r);
}, BLOB_SWEEP_MS);
blobSweep.unref?.();

// ---------------------------------------------------------------------------
// WebSocket-Frame-Schemas (modul-level für Performance — vorher wurden sie
// bei JEDER eingehenden Message neu kompiliert, was bei 100+ msg/s spürbar ist).
// ---------------------------------------------------------------------------
const WsDm = z.object({
  type: z.literal("dm"),
  toUserId: z.string().uuid(),
  /** Sealed-Sender-Envelope: Server sieht weder Absender noch Inhalt. */
  envelope: z.string().min(1).max(MAX_B64_CIPHERTEXT),
  /** Client-generierte Envelope-ID, damit Sender Delivery-Acks zuordnen kann. */
  cid: z.string().min(1).max(128),
});
const WsTypingDm = z.object({
  type: z.literal("typing"),
  toUserId: z.string().uuid(),
  state: z.enum(["start", "stop"]),
});
const WsTypingGroup = z.object({
  type: z.literal("typing"),
  groupId: z.string().uuid(),
  state: z.enum(["start", "stop"]),
});
const WsGroup = z.object({
  type: z.literal("group"),
  groupId: z.string().uuid(),
  ciphertext: z.string().min(1).max(MAX_B64_CIPHERTEXT),
});
const WsRtcPayload = z.union([
  z.object({ type: z.literal("offer"), sdp: z.string().min(1).max(256_000) }),
  z.object({ type: z.literal("answer"), sdp: z.string().min(1).max(256_000) }),
  z.object({
    type: z.literal("candidate"),
    candidate: z
      .object({
        candidate: z.string().max(16_384).optional(),
        sdpMid: z.string().max(64).nullable().optional(),
        sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
        usernameFragment: z.string().max(256).nullable().optional(),
      })
      .passthrough(),
  }),
]);
const WsRtc = z.object({
  type: z.literal("rtc"),
  toUserId: z.string().uuid(),
  payload: WsRtcPayload,
});
const WsPing = z.object({ type: z.literal("ping") });
const WsMailboxAck = z.object({
  type: z.literal("mailbox_ack"),
  kind: z.enum(["dm", "group"]),
  id: z.string().uuid(),
});
const WsFrame = z.union([
  WsDm,
  WsTypingDm,
  WsTypingGroup,
  WsGroup,
  WsRtc,
  WsPing,
  WsMailboxAck,
]);

function flushMailboxToSocket(userId: string, ws: WebSocket) {
  const pending = listMailboxDms(userId);
  for (const item of pending) {
    if (ws.readyState !== ws.OPEN) break;
    ws.send(
      JSON.stringify({
        type: "dm",
        id: item.id,
        toUserId: userId,
        ...(item.cid ? { cid: item.cid } : {}),
        envelope: item.envelope,
        createdAt: item.createdAt,
        mailbox: true,
      })
    );
  }
  const pendingGroups = listMailboxGroups(userId);
  for (const item of pendingGroups) {
    if (ws.readyState !== ws.OPEN) break;
    ws.send(
      JSON.stringify({
        type: "group",
        id: item.id,
        groupId: item.groupId,
        ciphertext: item.ciphertext,
        createdAt: item.createdAt,
        mailbox: true,
      })
    );
  }
}

function recoveryEmailHash(email: string): string {
  // Prefer a dedicated pepper; fall back to the JWT secret (always set and
  // >=32 chars in production). The hardcoded dev string is ONLY permitted
  // outside production — otherwise stored email hashes would be reversible
  // via dictionary attack. In production we refuse it outright.
  const pepper =
    process.env.VAULTCHAT_EMAIL_HASH_SECRET ??
    process.env.VAULTCHAT_JWT_SECRET ??
    (process.env.NODE_ENV === "production"
      ? null
      : "dev-email-hash-secret");
  if (!pepper) {
    throw new Error(
      "VAULTCHAT_EMAIL_HASH_SECRET (or VAULTCHAT_JWT_SECRET) must be set in production"
    );
  }
  return createHmac("sha256", pepper)
    .update(email.trim().toLowerCase())
    .digest("hex");
}

function publicProductConfig() {
  return {
    identity: {
      emailMode: "optional_hash_only" as const,
      backupRequiredForNewDevices: true,
    },
    plans: [
      {
        id: "personal",
        name: "Personal",
        priceEurMonthly: 0,
        audience: "Private Nutzung",
        highlights: ["E2E-Chats", "Gruppen", "verschluesselte Backups"],
      },
      {
        id: "pro",
        name: "Pro",
        priceEurMonthly: 5,
        audience: "Power-User und Creator",
        highlights: ["mehr Geraete", "laengere Mailbox-Aufbewahrung", "Priority Support"],
      },
      {
        id: "team",
        name: "Team",
        priceEurMonthly: 9,
        audience: "Teams pro Mitglied",
        highlights: ["Einladungsverwaltung", "Admin-Policy", "Compliance-Export ohne Inhalte"],
      },
    ],
  };
}

/**
 * Schlanker Token-Bucket pro Socket. Verhindert WS-Floods/Spam, ohne dass der
 * Server Inhalte sehen muss.
 */
function createBucket() {
  const capacity = 60;
  const refillPerSec = 20;
  let tokens = capacity;
  let last = Date.now();
  return () => {
    const now = Date.now();
    const add = ((now - last) / 1000) * refillPerSec;
    tokens = Math.min(capacity, tokens + add);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

wss.on("connection", (ws, req) => {
  // Heartbeat-Tracking: Verbindung gilt als alive, bis der nächste Heartbeat-
  // Tick keinen pong bekommen hat.
  (ws as WebSocket & { _vcAlive?: boolean })._vcAlive = true;
  ws.on("pong", () => {
    (ws as WebSocket & { _vcAlive?: boolean })._vcAlive = true;
  });

  const url = new URL(req.url ?? "", "http://localhost");
  const urlToken = url.searchParams.get("token");
  const allowUrlToken = process.env.VAULTCHAT_ALLOW_WS_URL_TOKEN === "1";
  const verifiedFromUrl = allowUrlToken && urlToken ? verifyToken(urlToken) : null;
  let jwtUser: { userId: string; username: string } | null = verifiedFromUrl;
  let authTimer: ReturnType<typeof setTimeout> | null = null;

  if (urlToken && !allowUrlToken) {
    ws.close(4401, "url_token_disabled");
    return;
  }

  if (urlToken) {
    if (!jwtUser) {
      ws.close(4401, "unauthorized");
      return;
    }
    registerClient(jwtUser.userId, ws);
    flushMailboxToSocket(jwtUser.userId, ws);
  } else {
    authTimer = setTimeout(() => {
      if (!jwtUser) ws.close(4401, "auth_timeout");
    }, 5000);
  }

  const allow = createBucket();
  // Anti-DoS: zählt malformed/unparseable Frames in einem Sliding-Fenster.
  // Ein legitimer Client darf vereinzelt einen Frame failen (Bug, Race),
  // aber 30+ in 60s = Angriff oder kaputter Build → Connection schließen.
  let badFrames = 0;
  let badFrameWindowStart = Date.now();
  const BAD_FRAME_LIMIT = 30;
  const BAD_FRAME_WINDOW_MS = 60_000;
  const noteBadFrame = (): boolean => {
    const now = Date.now();
    if (now - badFrameWindowStart > BAD_FRAME_WINDOW_MS) {
      badFrames = 0;
      badFrameWindowStart = now;
    }
    badFrames += 1;
    return badFrames < BAD_FRAME_LIMIT;
  };

  ws.on("message", (data) => {
    if ((data as Buffer).length > WS_MAX_FRAME_BYTES) {
      if (!noteBadFrame()) {
        log.warn("ws_bad_frame_limit", {
          userId: jwtUser?.userId ?? null,
          reason: "oversize",
        });
        ws.close(4413, "frame_too_large");
      }
      return;
    }
    if (!jwtUser) {
      let first: { type?: string; token?: string };
      try {
        first = JSON.parse(data.toString()) as { type?: string; token?: string };
      } catch {
        return;
      }
      if (first.type !== "auth" || typeof first.token !== "string") {
        ws.close(4401, "auth_required");
        return;
      }
      const u = verifyToken(first.token);
      if (!u) {
        ws.close(4401, "unauthorized");
        return;
      }
      jwtUser = u;
      if (authTimer) {
        clearTimeout(authTimer);
        authTimer = null;
      }
      registerClient(u.userId, ws);
      ws.send(JSON.stringify({ type: "auth_ok" }));
      flushMailboxToSocket(u.userId, ws);
      return;
    }

    if (!allow()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      if (!noteBadFrame()) {
        log.warn("ws_bad_frame_limit", {
          userId: jwtUser!.userId,
          reason: "json_parse",
        });
        ws.close(4400, "bad_frame_flood");
      }
      return;
    }

    const parsed = WsFrame.safeParse(msg);
    if (!parsed.success) {
      log.debug("ws_bad_frame", {
        userId: jwtUser!.userId,
        sample: typeof msg === "object" && msg && "type" in msg
          ? String((msg as { type: unknown }).type).slice(0, 32)
          : null,
      });
      if (!noteBadFrame()) {
        log.warn("ws_bad_frame_limit", {
          userId: jwtUser!.userId,
          reason: "schema",
        });
        ws.close(4400, "bad_frame_flood");
      }
      return;
    }

    if (parsed.data.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", at: Date.now() }));
      return;
    }

    if (parsed.data.type === "mailbox_ack") {
      if (parsed.data.kind === "dm") removeMailboxDm(jwtUser!.userId, parsed.data.id);
      else removeMailboxGroup(jwtUser!.userId, parsed.data.id);
      return;
    }

    if (parsed.data.type === "typing") {
      if ("toUserId" in parsed.data) {
        sendToUser(parsed.data.toUserId, {
          type: "typing",
          fromUserId: jwtUser!.userId,
          state: parsed.data.state,
        });
      } else {
        const g = getGroup(parsed.data.groupId);
        if (!g || !g.memberIds.includes(jwtUser!.userId)) return;
        for (const mid of g.memberIds) {
          if (mid === jwtUser!.userId) continue;
          sendToUser(mid, {
            type: "typing",
            groupId: parsed.data.groupId,
            fromUserId: jwtUser!.userId,
            state: parsed.data.state,
          });
        }
      }
      return;
    }

    if (parsed.data.type === "rtc") {
      const peer = findUserById(parsed.data.toUserId);
      if (!peer) return;
      sendToUser(parsed.data.toUserId, {
        type: "rtc",
        fromUserId: jwtUser!.userId,
        payload: parsed.data.payload,
      });
      return;
    }

    if (parsed.data.type === "group") {
      const g = getGroup(parsed.data.groupId);
      if (!g || !g.memberIds.includes(jwtUser!.userId)) return;
      // Replay: identischer ciphertext vom selben Sender innerhalb 10 min → drop.
      if (!markEnvelopeIfNew(jwtUser!.userId, parsed.data.ciphertext)) {
        log.debug("ws_replay_drop", {
          kind: "group",
          userId: jwtUser!.userId,
          groupId: g.id,
        });
        return;
      }
      const id = randomUUID();
      const createdAt = Date.now();
      /**
       * Kein `fromUserId` im Group-Frame. Der Absender ist in der
       * Ende-zu-Ende-verschlüsselten Payload enthalten und wird nur von
       * Gruppenmitgliedern entschlüsselt. Der Server leitet lediglich den
       * ciphertext an alle Mitglieder weiter.
       */
      let delivered = 0;
      for (const mid of g.memberIds) {
        if (mid === jwtUser!.userId) continue;
        const frame = {
          type: "group",
          id,
          groupId: g.id,
          ciphertext: parsed.data.ciphertext,
          createdAt,
        };
        const n = sendToUser(mid, frame);
        if (n === 0) {
          enqueueMailboxGroup({
            id,
            toUserId: mid,
            groupId: g.id,
            ciphertext: parsed.data.ciphertext,
            createdAt,
          });
        }
        if (n > 0) delivered++;
      }
      ws.send(
        JSON.stringify({
          type: "group_ack",
          id,
          createdAt,
          groupId: g.id,
          delivered,
          total: g.memberIds.length - 1,
        })
      );
      return;
    }

    /**
     * Sealed-Sender DM. Ehrliches Bedrohungsmodell:
     *  - Inhalt: der Server kann ihn NICHT lesen (E2EE im Envelope).
     *  - Absender gegenüber dem EMPFÄNGER-Frame: versteckt — wir hängen kein
     *    fromUserId an; der Empfänger erfährt den Absender nur aus dem
     *    entschlüsselten Envelope.
     *  - Absender gegenüber dem SERVER: dem Server transient bekannt, weil die
     *    WS-Verbindung authentifiziert ist (jwtUser). Wir LOGGEN/SPEICHERN das
     *    Sender↔Empfänger-Paar aber NICHT (kein Log auf dem Erfolgspfad).
     *  - Empfänger (toUserId): muss für die Zustellung bekannt sein — das lässt
     *    sich bei einem Push-Relay prinzipiell nicht verbergen (gilt auch für
     *    Signal). Cover-Traffic verrauscht den beobachtbaren Graphen zusätzlich.
     */
    const { toUserId, envelope, cid } = parsed.data;
    const peer = findUserById(toUserId);
    if (!peer) {
      ws.send(JSON.stringify({ type: "dm_ack", cid, delivered: 0 }));
      return;
    }

    // Server-side replay-protection: identische Envelopes vom selben Sender
    // innerhalb von 10 min werden gedropt. Schützt vor JWT-Diebstahl-Replay
    // und reduziert Bandbreite, bevor der Empfänger DR-Counter prüft.
    if (!markEnvelopeIfNew(jwtUser!.userId, envelope)) {
      // Don't log the sender↔activity link, even at debug level — keep the
      // who-talks metadata out of logs entirely.
      log.debug("ws_replay_drop", { kind: "dm" });
      ws.send(
        JSON.stringify({ type: "dm_ack", cid, delivered: 0, reason: "replay" })
      );
      return;
    }

    const id = randomUUID();
    const createdAt = Date.now();

    const delivered = sendToUser(toUserId, {
      type: "dm",
      id,
      toUserId,
      cid,
      envelope,
      createdAt,
    });
    if (delivered === 0) {
      enqueueMailboxDm({ id, toUserId, envelope, cid, createdAt });
    }

    ws.send(
      JSON.stringify({
        type: "dm_ack",
        id,
        cid,
        delivered,
        createdAt,
      })
    );
  });

  ws.on("close", () => {
    if (authTimer) clearTimeout(authTimer);
  });
});

async function start() {
  if (process.env.VAULTCHAT_SERVE_SPA === "1") {
    const { attachSpa } = await import("./static.js");
    attachSpa(app);
  }
  server.listen(port, () => {
    const config = loadRuntimeConfig();
    const state = getStateStatus();
    log.info("server_start", {
      port,
      profile: config.profile,
      state: state.mode,
      messagesPersistent: false,
      nodeEnv: process.env.NODE_ENV ?? "development",
    });
  });
}

void start();
