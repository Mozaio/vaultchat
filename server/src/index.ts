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
  bumpTokenEpoch,
  createGroup,
  createUser,
  deleteUserCompletely,
  findUserById,
  findUserByUsername,
  getDirectoryStats,
  getGroup,
  getTokenEpoch,
  leaveGroup,
  listGroupsForUser,
  listUsersSafe,
  removeGroupMember,
  setGroupZkgParams,
  setProfileCipher,
  updateGroupProfile,
} from "./memoryStore.js";
import {
  hashPassword,
  setDeviceRevokedResolver,
  setTokenEpochResolver,
  signToken,
  verifyPasswordOrDummy,
  verifyToken,
} from "./auth.js";
import {
  clearRevokedDevices,
  isDeviceRevoked,
  revokeDevice,
} from "./deviceSessions.js";

// Token-Revocation: verifyToken prüft die Token-Epoch gegen den User-Store.
// Muss vor dem ersten Request gesetzt sein (Modul-Load genügt).
setTokenEpochResolver((userId) => getTokenEpoch(userId));
// Einzel-Geräte-Revocation (GOAL Phase 2): verifyToken entwertet ein einzelnes
// Token, dessen (userId, deviceId) widerrufen wurde — ohne alle Geräte zu
// treffen. DI wie beim Epoch-Resolver (kein Modul-Zyklus).
setDeviceRevokedResolver((userId, deviceId) =>
  isDeviceRevoked(userId, deviceId)
);
import {
  currentRedemptionTime,
  getZkgroupStatus,
  initZkgroup,
  issueAuthCredential,
  verifyPresentation,
} from "./zkgroup.js";
import {
  disconnectDevice,
  disconnectUser,
  getWsStats,
  listUserDevices,
  registerClient,
  sendToUser,
} from "./wsHub.js";
import { evaluateBlinded } from "./discoveryOprf.js";
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
  sweepReplayState,
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
/** Cap für Base64-Ciphertext-Strings (WS-Frames + Sealed-Group-Bodies). */
const MAX_B64_CIPHERTEXT = Number(
  process.env.VAULTCHAT_MAX_B64_CIPHERTEXT_BYTES ?? 16 * 1024 * 1024
);

/**
 * Body-Parser zweistufig: Standard-Routen brauchen nur kleine JSON-Bodies.
 * Der Sealed-Group-Endpoint (#26) transportiert dagegen komplette
 * Megolm-Ciphertexte als JSON — mit dem globalen 12-MB-Limit starben
 * große Sealed-Sends mit 413, obwohl Zod bis MAX_B64_CIPHERTEXT erlaubt
 * und der parallele WS-Pfad dieselben Frames akzeptiert.
 */
const SEALED_GROUP_PATH = /^\/api\/groups\/[^/]+\/sealed$/;
const sealedGroupJson = express.json({
  limit: MAX_B64_CIPHERTEXT + 4 * 1024 * 1024,
});
const standardJson = express.json({
  limit: process.env.VAULTCHAT_JSON_LIMIT ?? "12mb",
});
app.use((req, res, next) => {
  if (req.method === "POST" && SEALED_GROUP_PATH.test(req.path)) {
    sealedGroupJson(req, res, next);
    return;
  }
  standardJson(req, res, next);
});
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
// GOAL 0.1d-2: limits online OPRF evaluations per IP. The OPRF lets a client
// derive a discovery tag, so a tight cap bounds client-side enumeration of the
// exact-match directory (the server-side brute-force limitation is documented
// in DISCOVERY_SPEC.md / THREAT_MODEL.md).
const discoveryLimiter = rateLimit({
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
  /** Opake, client-erzeugte Geräte-/Session-ID (für Einzel-Geräte-Revocation,
   *  GOAL Phase 2). Nicht identitäts-/hardware-gebunden; reine Zufalls-ID. */
  deviceId: z.string().min(1).max(64).optional(),
});

const LoginBody = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  /** Siehe RegisterBody.deviceId. */
  deviceId: z.string().min(1).max(64).optional(),
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
  const token = signToken({
    userId: user.id,
    username: user.username,
    tokenEpoch: getTokenEpoch(user.id),
    ...(parsed.data.deviceId ? { deviceId: parsed.data.deviceId } : {}),
  });
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
  // Dummy-Verify bei unbekanntem User — Antwortzeit darf die Existenz
  // des Accounts nicht verraten (siehe auth.ts).
  const passwordOk = await verifyPasswordOrDummy(user?.passwordHash, password);
  if (!user || !passwordOk) {
    log.info("auth_login_fail", {
      reqId: req.id,
      username: username.slice(0, 32),
      reason: user ? "wrong_password" : "user_not_found",
      ipTag: clientIpTag(req.ip),
    });
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }
  const token = signToken({
    userId: user.id,
    username: user.username,
    tokenEpoch: getTokenEpoch(user.id),
    ...(parsed.data.deviceId ? { deviceId: parsed.data.deviceId } : {}),
  });
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

/**
 * Sliding-Session-Refresh: ein noch gültiges Token wird gegen ein frisches
 * getauscht (kein Passwort nötig). Der s0-Claim (Session-Start) wandert
 * dabei UNVERÄNDERT mit und deckelt die absolute Session-Lebensdauer —
 * ein gestohlenes Token lässt sich also nicht endlos verlängern.
 * Bisher starb jede Session hart nach 12 h (Re-Login mit Passwort).
 */
const MAX_SESSION_AGE_MS = Number(
  process.env.VAULTCHAT_MAX_SESSION_AGE_MS ?? 30 * 24 * 60 * 60 * 1000
);
app.post("/api/token/refresh", apiLimiter, (req, res) => {
  const t = bearer(req);
  const u = t ? verifyToken(t) : null;
  if (!u) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  // Account muss noch existieren (gelöschte Accounts bekommen kein
  // frisches Token, auch wenn das alte formal noch gültig ist).
  const user = findUserById(u.userId);
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const s0 = u.sessionStart ?? Math.floor(Date.now() / 1000);
  if (Date.now() - s0 * 1000 > MAX_SESSION_AGE_MS) {
    res.status(401).json({ error: "session_expired" });
    return;
  }
  log.debug("auth_token_refresh", { userId: user.id });
  res.json({
    token: signToken(
      {
        userId: user.id,
        username: user.username,
        tokenEpoch: getTokenEpoch(user.id),
        // Geräte-ID wandert beim Refresh unverändert mit, damit eine
        // Einzel-Geräte-Revocation auch nach einem Refresh greift.
        ...(u.deviceId ? { deviceId: u.deviceId } : {}),
      },
      undefined,
      s0
    ),
  });
});

/**
 * "Auf allen Geräten abmelden": erhöht die Token-Epoch des Users → ALLE
 * bisher ausgestellten Tokens (inkl. des gerade benutzten) werden ab sofort
 * abgelehnt. Schließt die Refresh-Lücke (ein gestohlenes/altes Token ließ
 * sich bisher endlos erneuern). Der Client muss sich danach neu anmelden.
 */
app.post("/api/account/logout-all", apiLimiter, (req, res) => {
  const t = bearer(req);
  const jwtUser = t ? verifyToken(t) : null;
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const epoch = bumpTokenEpoch(jwtUser.userId);
  if (epoch === null) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // Token-Revocation greift beim nächsten verifyToken; bereits offene WS
  // zusätzlich SOFORT trennen, damit keine Verbindung überlebt.
  const dropped = disconnectUser(jwtUser.userId);
  // Der Epoch-Bump entwertet ohnehin ALLE Tokens → die explizite
  // Einzel-Geräte-Revocationsliste ist danach nur Ballast.
  clearRevokedDevices(jwtUser.userId);
  log.info("auth_logout_all", { userId: jwtUser.userId, droppedSockets: dropped });
  res.json({ ok: true });
});

/**
 * Geräte-Verwaltung (GOAL Phase 2): listet die AKTUELL VERBUNDENEN Sessions
 * des aufrufenden Users. Quelle ist rein die ephemere Live-WS-Registry —
 * keine persistenten Metadaten, keine IP, kein User-Agent, kein Label. Pro
 * Session nur die opake `deviceId` (client-erzeugt, nicht identitätsgebunden)
 * und die Verbindungszeit. Die eigene Session wird markiert, damit die UI
 * „dieses Gerät" anzeigen kann. ZK-Grenze: der Server verrät hier nichts, was
 * er nicht ohnehin schon weiß (die Socket-Zahl war via /status sichtbar).
 */
app.get("/api/account/devices", apiLimiter, (req, res) => {
  const t = bearer(req);
  const jwtUser = t ? verifyToken(t) : null;
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const sessions = listUserDevices(jwtUser.userId).map((s) => ({
    deviceId: s.deviceId,
    connectedAt: s.connectedAt,
    current: s.deviceId != null && s.deviceId === (jwtUser.deviceId ?? null),
  }));
  res.json({ sessions });
});

const RevokeDeviceBody = z.object({
  deviceId: z.string().min(1).max(64),
});

/**
 * Meldet EIN Gerät (per opaker deviceId) ab, ohne alle anderen mitzunehmen:
 * markiert die deviceId als widerrufen (künftige verifyToken-Aufrufe für
 * dieses Token scheitern) UND trennt die bereits offene WS-Verbindung sofort.
 * Der `tokenEpoch` bleibt unangetastet — andere Geräte des Users bleiben
 * angemeldet (im Gegensatz zu logout-all).
 */
app.post("/api/account/devices/revoke", apiLimiter, (req, res) => {
  const t = bearer(req);
  const jwtUser = t ? verifyToken(t) : null;
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const parsed = RevokeDeviceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const { deviceId } = parsed.data;
  revokeDevice(jwtUser.userId, deviceId);
  const dropped = disconnectDevice(jwtUser.userId, deviceId);
  log.info("auth_device_revoke", {
    userId: jwtUser.userId,
    droppedSockets: dropped,
    self: deviceId === (jwtUser.deviceId ?? null),
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// zkgroup (Weg A, Phase A1 — experimentell, Flag VAULTCHAT_ZKGROUP=1).
// Auditiertes libsignal-zkgroup: Status/Probe + Credential-Issuance.
// Keine aktive Security-Boundary — das Sealed-Endpoint-Gate kommt erst,
// wenn die Client-Seite (WASM) steht und das Review-Gate passiert ist.
// ---------------------------------------------------------------------------
app.get("/api/zkgroup/status", apiLimiter, (req, res) => {
  const t = bearer(req);
  if (!t || !verifyToken(t)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.json(getZkgroupStatus());
});

app.post("/api/zkgroup/credential", apiLimiter, (req, res) => {
  const t = bearer(req);
  const jwtUser = t ? verifyToken(t) : null;
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const zk = getZkgroupStatus();
  if (!zk.enabled || !zk.available) {
    res.status(503).json({ error: "zkgroup_unavailable" });
    return;
  }
  try {
    const redemptionTime = currentRedemptionTime();
    const credential = Buffer.from(
      issueAuthCredential(jwtUser.userId, redemptionTime)
    ).toString("base64");
    res.json({ credential, redemptionTime, publicParams: zk.publicParams });
  } catch (e) {
    log.warn("zkgroup_issue_failed", {
      reason: e instanceof Error ? e.message.slice(0, 120) : "unknown",
    });
    res.status(500).json({ error: "zkgroup_issue_failed" });
  }
});

/**
 * Diagnose-Roundtrip (A3-2d): verifiziert eine vom Client erzeugte
 * Mitgliedschafts-Presentation gegen die mitgelieferten GroupPublicParams.
 * NICHT im Nachrichtenpfad und KEINE Enforcement — rein zum Beweis, dass
 * client-erzeugte Presentations server-seitig durchgehen. base64-Felder
 * sind klein (Presentation/Params je ein paar hundert Byte); 64 KB Cap.
 */
// groupPublicParams (direkt, Test-GMK) ODER groupId (gegen die server-
// gespeicherten Params der Gruppe → gruppen-gebundener Beweis). Eines von
// beiden muss da sein.
const ZkVerifyBody = z.object({
  presentation: z.string().min(1).max(64 * 1024),
  groupPublicParams: z.string().min(1).max(64 * 1024).optional(),
  groupId: z.string().uuid().optional(),
});
app.post("/api/zkgroup/verify-presentation", apiLimiter, (req, res) => {
  const t = bearer(req);
  const jwtUser = t ? verifyToken(t) : null;
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const zk = getZkgroupStatus();
  if (!zk.enabled || !zk.available) {
    res.status(503).json({ error: "zkgroup_unavailable" });
    return;
  }
  const parsed = ZkVerifyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  let gppB64 = parsed.data.groupPublicParams;
  let groupBound = false;
  if (parsed.data.groupId) {
    const g = getGroup(parsed.data.groupId);
    // Nur Mitglieder dürfen gegen die Params ihrer Gruppe prüfen.
    if (!g || !g.memberIds.includes(jwtUser.userId)) {
      res.status(404).json({ error: "group_not_found" });
      return;
    }
    if (!g.zkgPublicParams) {
      res.status(409).json({ error: "group_params_missing" });
      return;
    }
    gppB64 = g.zkgPublicParams;
    groupBound = true;
  }
  if (!gppB64) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  try {
    const valid = verifyPresentation(
      new Uint8Array(Buffer.from(gppB64, "base64")),
      new Uint8Array(Buffer.from(parsed.data.presentation, "base64"))
    );
    log.debug("zkgroup_verify", { valid, groupBound });
    res.json({ valid, groupBound });
  } catch (e) {
    log.warn("zkgroup_verify_failed", {
      reason: e instanceof Error ? e.message.slice(0, 120) : "unknown",
    });
    res.status(500).json({ error: "zkgroup_verify_failed" });
  }
});

/** Lädt die zkgroup-GroupPublicParams einer Gruppe hoch (Mitglied, flag). */
const ZkParamsBody = z.object({
  groupPublicParams: z.string().min(1).max(64 * 1024),
});
app.post("/api/groups/:id/zkgroup-params", groupLimiter, (req, res) => {
  const t = bearer(req);
  const jwtUser = t ? verifyToken(t) : null;
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const zk = getZkgroupStatus();
  if (!zk.enabled || !zk.available) {
    res.status(503).json({ error: "zkgroup_unavailable" });
    return;
  }
  const parsed = ZkParamsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const ok = setGroupZkgParams(
    String(req.params.id),
    jwtUser.userId,
    parsed.data.groupPublicParams
  );
  if (!ok) {
    res.status(404).json({ error: "group_not_found" });
    return;
  }
  res.json({ ok: true });
});

void initZkgroup();

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
    return u
      ? [
          {
            id: u.id,
            username: u.username,
            publicKey: u.publicKey,
            ...(u.profileCipher ? { profileCipher: u.profileCipher } : {}),
          },
        ]
      : [];
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

// GOAL 0.1d-2: OPRF evaluation for blind contact discovery. The client sends a
// blinded ristretto255 point; the server returns k*B without learning the
// username (see DISCOVERY_SPEC.md). DORMANT — no client uses it until 0.1d-4;
// fail-closed (503) until VAULTCHAT_DISCOVERY_OPRF_KEY is set.
const DiscoveryEvaluateBody = z.object({
  blinded: z.string().min(1).max(64),
});
app.post("/api/discovery/evaluate", discoveryLimiter, async (req, res) => {
  const t = bearer(req);
  if (!t || !verifyToken(t)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const parsed = DiscoveryEvaluateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const result = await evaluateBlinded(parsed.data.blinded);
  if (!result.ok) {
    res
      .status(result.reason === "unconfigured" ? 503 : 400)
      .json({ error: result.reason === "unconfigured" ? "discovery_unconfigured" : "invalid_point" });
    return;
  }
  res.json({ evaluated: result.evaluated });
});

// GOAL Phase 1 (Profil/Avatar E2E): store a user's own E2E-encrypted profile
// blob. Server-opaque — only a `PROFILE1:` ciphertext is accepted and stored;
// the server never sees the plaintext name/avatar. It is returned to contacts
// via /api/users so they decrypt it with the Olm-shared profile key. DORMANT
// until the client editor + key distribution land.
const ProfileBody = z.object({
  profileCipher: z.string().min(1).max(300_000),
});
app.put("/api/profile", apiLimiter, async (req, res) => {
  const t = bearer(req);
  const jwtUser = t ? verifyToken(t) : null;
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const parsed = ProfileBody.safeParse(req.body);
  if (!parsed.success || !parsed.data.profileCipher.startsWith("PROFILE1:")) {
    res.status(400).json({ error: "invalid_profile" });
    return;
  }
  if (!setProfileCipher(jwtUser.userId, parsed.data.profileCipher)) {
    res.status(404).json({ error: "unknown_user" });
    return;
  }
  res.json({ ok: true });
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
  const groupId = String(req.params.id);
  const g = leaveGroup(groupId, jwtUser.userId);
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
      groupId,
      memberId: jwtUser.userId,
    });
  }
  log.info("group_left", {
    reqId: req.id,
    groupId,
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
// MAX_B64_CIPHERTEXT ist oben beim Body-Parser definiert (Sealed-Route
// braucht denselben Wert fürs JSON-Limit).
const WS_MAX_FRAME_BYTES = MAX_B64_CIPHERTEXT + 4 * 1024 * 1024;

/**
 * Vor der Auth ist der einzige legitime Frame ein kleiner auth-Frame
 * (JWT, < 2 KB). Ohne dieses Cap könnte ein unauthentifizierter Client
 * bis zum auth_timeout 20-MB-Frames schicken, die der Server alle
 * JSON.parsen müsste — CPU-Burn ganz ohne Account.
 */
const MAX_PREAUTH_FRAME_BYTES = 8 * 1024;

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

// Replay-Sweep alle 10 min: entfernt Sender-Einträge, deren Hashes komplett
// aus dem Fenster gefallen sind. Verhindert monotones Wachstum der recent-Map
// über die (über die Zeit) gesamte Nutzerbasis.
const REPLAY_SWEEP_MS = 10 * 60_000;
const replaySweep = setInterval(() => {
  const r = sweepReplayState();
  if (r.sendersRemoved > 0) log.info("replay_sweep", r);
}, REPLAY_SWEEP_MS);
replaySweep.unref?.();

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

// ---------------------------------------------------------------------------
// Per-IP cap on *pre-authenticated* WebSocket connections (GOAL 0.4b).
//
// The relay is content-blind, but an unauthenticated peer can still open many
// sockets from one host and sit in the 5s auth window to exhaust file
// descriptors / memory. We bound the number of *simultaneously pre-auth*
// sockets per source IP. A socket is released from the counter the moment it
// authenticates, so legitimate users behind a shared NAT (corporate / uni /
// mobile carrier) are NOT limited — only concurrent *unauthenticated* sockets
// from one IP are. Fail-open by design: if the client IP can't be determined,
// or the cap is non-positive / unparseable, no limit is applied (never lock
// out real users). IPs live only transiently in memory and are never persisted
// or tied to an identity (metadata minimisation).
// ---------------------------------------------------------------------------
const MAX_PREAUTH_WS_PER_IP = Number(
  process.env.VAULTCHAT_MAX_PREAUTH_WS_PER_IP ?? 30
);
const preAuthSocketsByIp = new Map<string, number>();

wss.on("connection", (ws, req) => {
  // Heartbeat-Tracking: Verbindung gilt als alive, bis der nächste Heartbeat-
  // Tick keinen pong bekommen hat.
  (ws as WebSocket & { _vcAlive?: boolean })._vcAlive = true;
  ws.on("pong", () => {
    (ws as WebSocket & { _vcAlive?: boolean })._vcAlive = true;
  });

  // Per-IP pre-auth connection cap (GOAL 0.4b). Render terminates TLS and
  // prepends the real client IP as the first X-Forwarded-For hop.
  const xffRaw = req.headers["x-forwarded-for"];
  const xff = Array.isArray(xffRaw) ? xffRaw[0] : xffRaw;
  const clientIp: string | null =
    (typeof xff === "string" && xff.split(",")[0]?.trim()) ||
    req.socket?.remoteAddress ||
    null;
  let preAuthCounted = false;
  const releasePreAuth = () => {
    if (!preAuthCounted || !clientIp) return;
    preAuthCounted = false;
    const n = (preAuthSocketsByIp.get(clientIp) ?? 1) - 1;
    if (n <= 0) preAuthSocketsByIp.delete(clientIp);
    else preAuthSocketsByIp.set(clientIp, n);
  };
  if (clientIp && MAX_PREAUTH_WS_PER_IP > 0) {
    const current = preAuthSocketsByIp.get(clientIp) ?? 0;
    if (current >= MAX_PREAUTH_WS_PER_IP) {
      log.warn("ws_preauth_ip_cap", { cap: MAX_PREAUTH_WS_PER_IP });
      ws.close(4429, "too_many_preauth_connections");
      return;
    }
    preAuthSocketsByIp.set(clientIp, current + 1);
    preAuthCounted = true;
    // Release on close too, so early-return paths below (url-token disabled /
    // unauthorized) and the auth-timeout don't leak the counter.
    ws.on("close", releasePreAuth);
  }

  const url = new URL(req.url ?? "", "http://localhost");
  const urlToken = url.searchParams.get("token");
  const allowUrlToken = process.env.VAULTCHAT_ALLOW_WS_URL_TOKEN === "1";
  const verifiedFromUrl = allowUrlToken && urlToken ? verifyToken(urlToken) : null;
  let jwtUser: {
    userId: string;
    username: string;
    deviceId?: string;
  } | null = verifiedFromUrl;
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
    registerClient(jwtUser.userId, ws, jwtUser.deviceId);
    releasePreAuth(); // authenticated → no longer counts against the pre-auth cap
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
      // Pre-Auth: erster Frame MUSS ein valider auth-Frame sein. Oversize
      // oder kaputtes JSON ist kein Client-Bug, sondern Noise/Angriff —
      // sofort schließen statt bis zum auth_timeout weiterzuparsen.
      if ((data as Buffer).length > MAX_PREAUTH_FRAME_BYTES) {
        ws.close(4401, "auth_required");
        return;
      }
      let first: { type?: string; token?: string };
      try {
        first = JSON.parse(data.toString()) as { type?: string; token?: string };
      } catch {
        ws.close(4401, "auth_required");
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
      registerClient(u.userId, ws, u.deviceId);
      releasePreAuth(); // authenticated → no longer counts against the pre-auth cap
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
