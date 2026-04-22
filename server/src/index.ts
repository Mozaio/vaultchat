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

const server = createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: 8 * 1024 * 1024,
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
  const token = url.searchParams.get("token");
  const jwtUser = token ? verifyToken(token) : null;
  if (!jwtUser) {
    ws.close(4401, "unauthorized");
    return;
  }
  registerClient(jwtUser.userId, ws);

  const allow = createBucket();

  ws.on("message", (data) => {
    if (!allow()) return;
    if ((data as Buffer).length > 8 * 1024 * 1024) return;
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    const MAX_CT = 6 * 1024 * 1024;

    const Dm = z.object({
      type: z.literal("dm"),
      toUserId: z.string().uuid(),
      /** Sealed-Sender-Envelope: Server sieht weder Absender noch Inhalt. */
      envelope: z.string().min(1).max(MAX_CT),
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
      ciphertext: z.string().min(1).max(MAX_CT),
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
        fromUserId: jwtUser.userId,
        state: parsed.data.state,
      });
      return;
    }

    if (parsed.data.type === "rtc") {
      const peer = findUserById(parsed.data.toUserId);
      if (!peer) return;
      sendToUser(parsed.data.toUserId, {
        type: "rtc",
        fromUserId: jwtUser.userId,
        payload: parsed.data.payload,
      });
      return;
    }

    if (parsed.data.type === "group") {
      const g = getGroup(parsed.data.groupId);
      if (!g || !g.memberIds.includes(jwtUser.userId)) return;
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
        if (mid === jwtUser.userId) continue;
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
