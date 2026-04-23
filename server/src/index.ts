import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { z } from "zod";
import {
  addGroupMember,
  createGroup,
  createUser,
  findUserById,
  findUserByUsername,
  getGroup,
  leaveGroup,
  listGroupsForUser,
  listUsersSafe,
  removeGroupMember,
} from "./memoryStore.js";
import { hashPassword, signToken, verifyPassword, verifyToken } from "./auth.js";
import { registerClient, sendToUser } from "./wsHub.js";
import {
  getPreKeyBundle,
  getRemainingPreKeyCount,
  initPreKeyBundle,
  uploadOneTimePreKeys,
} from "./prekeyStore.js";

const app = express();
const port = Number(process.env.PORT ?? 8787);

app.set("trust proxy", 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "script-src-attr": ["'none'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "blob:"],
        "media-src": ["'self'", "data:", "blob:"],
        "font-src": ["'self'", "data:"],
        "connect-src": ["'self'", "ws:", "wss:"],
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
    origin: process.env.VAULTCHAT_CORS_ORIGIN ?? true,
    credentials: true,
  })
);
app.use(express.json({ limit: "12mb" }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 80,
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api", apiLimiter);

app.get("/healthz", (_req, res) => {
  res.status(200).type("text/plain").send("ok");
});

const RegisterBody = z.object({
  username: z.string().min(2).max(32).regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(10).max(256),
  publicKey: z.string().min(16),
});

const LoginBody = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const CreateGroupBody = z.object({
  name: z.string().min(1).max(64),
  memberIds: z.array(z.string().uuid()).min(1),
});

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
  const { username, password, publicKey } = parsed.data;
  const passwordHash = await hashPassword(password);
  const user = createUser({ username, passwordHash, publicKey });
  if (!user) {
    res.status(409).json({ error: "username_taken" });
    return;
  }
  const token = signToken({ userId: user.id, username: user.username });
  res.json({
    token,
    user: { id: user.id, username: user.username, publicKey: user.publicKey },
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
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }
  const token = signToken({ userId: user.id, username: user.username });
  res.json({
    token,
    user: { id: user.id, username: user.username, publicKey: user.publicKey },
  });
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
  });
});

app.get("/api/users", async (req, res) => {
  const t = bearer(req);
  if (!t || !verifyToken(t)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.json({ users: listUsersSafe() });
});

// Username-Suche (Telegram-Style): Nur Ergebnisse bei Mindestlänge 2
app.get("/api/users/search", async (req, res) => {
  const t = bearer(req);
  if (!t || !verifyToken(t)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const query = (req.query.q as string | undefined)?.trim().toLowerCase() ?? "";
  const currentUser = verifyToken(t);
  
  if (!query || query.length < 2) {
    res.json({ users: [] });
    return;
  }
  
  // Suche nach Prefix-Match, max 10 Ergebnisse
  const results = listUsersSafe()
    .filter((u) => 
      u.username.toLowerCase().includes(query) && 
      u.id !== currentUser?.userId
    )
    .slice(0, 10);
  
  res.json({ users: results });
});

app.post("/api/groups", async (req, res) => {
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
  const g = createGroup({ name: parsed.data.name, memberIds });
  res.json({
    group: {
      id: g.id,
      name: g.name,
      memberIds: g.memberIds,
      createdAt: g.createdAt,
    },
  });
});

app.get("/api/groups", async (req, res) => {
  const t = bearer(req);
  const jwtUser = t ? verifyToken(t) : null;
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const list = listGroupsForUser(jwtUser.userId).map((g) => ({
    id: g.id,
    name: g.name,
    memberIds: g.memberIds,
    createdAt: g.createdAt,
  }));
  res.json({ groups: list });
});

const MemberBody = z.object({ memberId: z.string().uuid() });

app.post("/api/groups/:id/members", async (req, res) => {
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
  const g = addGroupMember(req.params.id, jwtUser.userId, parsed.data.memberId);
  if (!g) {
    res.status(400).json({ error: "cannot_add" });
    return;
  }
  res.json({
    group: { id: g.id, name: g.name, memberIds: g.memberIds, createdAt: g.createdAt },
  });
});

app.delete("/api/groups/:id/members/:memberId", async (req, res) => {
  const t = bearer(req);
  const jwtUser = t ? verifyToken(t) : null;
  if (!jwtUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const g = removeGroupMember(req.params.id, jwtUser.userId, req.params.memberId);
  if (!g) {
    res.status(400).json({ error: "cannot_remove" });
    return;
  }
  res.json({
    group: { id: g.id, name: g.name, memberIds: g.memberIds, createdAt: g.createdAt },
  });
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
  const servers: { urls: string | string[]; username?: string; credential?: string }[] = [
    { urls: process.env.VAULTCHAT_STUN_URL ?? "stun:stun.l.google.com:19302" },
  ];
  const turnUrl = process.env.VAULTCHAT_TURN_URL;
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: process.env.VAULTCHAT_TURN_USER ?? "",
      credential: process.env.VAULTCHAT_TURN_PASS ?? "",
    });
  }
  res.json({
    iceServers: servers,
    forceRelay: process.env.VAULTCHAT_FORCE_RELAY === "1",
  });
});

app.get("/api/keys/:userId", async (req, res) => {
  const t = bearer(req);
  if (!t || !verifyToken(t)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const bundle = getPreKeyBundle(req.params.userId);
  if (!bundle) {
    res.status(404).json({ error: "no_keys" });
    return;
  }
  res.json(bundle);
});

const PreKeyUploadBody = z.object({
  signedPreKey: z.object({
    keyId: z.number(),
    publicKey: z.string(),
    signature: z.string(),
  }),
  oneTimePreKeys: z
    .array(z.object({ keyId: z.number(), publicKey: z.string() }))
    .max(200),
});

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
  initPreKeyBundle(
    jwtUser.userId,
    user.publicKey,
    parsed.data.signedPreKey.publicKey,
    parsed.data.signedPreKey.signature
  );
  uploadOneTimePreKeys(jwtUser.userId, parsed.data.oneTimePreKeys);
  res.json({ ok: true, remaining: getRemainingPreKeyCount(jwtUser.userId) });
});

const server = createServer(app);
/**
 * E2E-DM: base64(Envelope) / Gruppen-ciphertext. Zod-Maxlänge = erlaubter Umschlag.
 * WebSocket-Frame etwas größer (JSON-Metadaten um `envelope` herum).
 */
const MAX_B64_CIPHERTEXT = 128 * 1024 * 1024;
const WS_MAX_FRAME_BYTES = MAX_B64_CIPHERTEXT + 2 * 1024 * 1024;

const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: WS_MAX_FRAME_BYTES,
});

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
  const url = new URL(req.url ?? "", "http://localhost");
  const urlToken = url.searchParams.get("token");
  const verifiedFromUrl = urlToken ? verifyToken(urlToken) : null;
  let jwtUser: { userId: string; username: string } | null = verifiedFromUrl;
  let authTimer: ReturnType<typeof setTimeout> | null = null;

  if (urlToken) {
    if (!jwtUser) {
      ws.close(4401, "unauthorized");
      return;
    }
    registerClient(jwtUser.userId, ws);
  } else {
    authTimer = setTimeout(() => {
      if (!jwtUser) ws.close(4401, "auth_timeout");
    }, 5000);
  }

  const allow = createBucket();

  ws.on("message", (data) => {
    if ((data as Buffer).length > WS_MAX_FRAME_BYTES) return;
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
      return;
    }

    if (!allow()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    const Dm = z.object({
      type: z.literal("dm"),
      toUserId: z.string().uuid(),
      /** Sealed-Sender-Envelope: Server sieht weder Absender noch Inhalt. */
      envelope: z.string().min(1).max(MAX_B64_CIPHERTEXT),
      /** Client-generierte Envelope-ID, damit Sender Delivery-Acks zuordnen kann. */
      cid: z.string().min(1).max(128),
    });

    const Typing = z.object({
      type: z.literal("typing"),
      toUserId: z.string().uuid(),
      state: z.enum(["start", "stop"]),
    });

    const Group = z.object({
      type: z.literal("group"),
      groupId: z.string().uuid(),
      ciphertext: z.string().min(1).max(MAX_B64_CIPHERTEXT),
    });

    const Rtc = z.object({
      type: z.literal("rtc"),
      toUserId: z.string().uuid(),
      payload: z.unknown(),
    });

    const Ping = z.object({ type: z.literal("ping") });

    const parsed = z.union([Dm, Typing, Group, Rtc, Ping]).safeParse(msg);
    if (!parsed.success) return;

    if (parsed.data.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", at: Date.now() }));
      return;
    }

    if (parsed.data.type === "typing") {
      sendToUser(parsed.data.toUserId, {
        type: "typing",
        fromUserId: jwtUser!.userId,
        state: parsed.data.state,
      });
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
        const n = sendToUser(mid, {
          type: "group",
          id,
          groupId: g.id,
          ciphertext: parsed.data.ciphertext,
          createdAt,
        });
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
     * Sealed-Sender DM: Der Server kennt weder Inhalt noch Absender. Er relayt
     * den Envelope an toUserId. Kein fromUserId wird an den Empfänger gesendet
     * — der Absender kommt aus dem vom Empfänger entschlüsselten Envelope.
     */
    const { toUserId, envelope, cid } = parsed.data;
    const peer = findUserById(toUserId);
    if (!peer) {
      ws.send(JSON.stringify({ type: "dm_ack", cid, delivered: 0 }));
      return;
    }

    const id = randomUUID();
    const createdAt = Date.now();

    const delivered = sendToUser(toUserId, {
      type: "dm",
      id,
      toUserId,
      envelope,
      createdAt,
    });

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
    console.log(
      `[vaultchat] API + WS (RAM only, keine Nachrichten-Persistenz) :${port}`
    );
  });
}

void start();
