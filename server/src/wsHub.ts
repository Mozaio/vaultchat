import type { WebSocket } from "ws";
import { log } from "./logger.js";

type Client = { ws: WebSocket; userId: string; connectedAt: number };

const byUser = new Map<string, Set<Client>>();

export function registerClient(userId: string, ws: WebSocket) {
  const c: Client = { ws, userId, connectedAt: Date.now() };
  let set = byUser.get(userId);
  if (!set) {
    set = new Set();
    byUser.set(userId, set);
  }
  set.add(c);
  log.info("ws_register", {
    userId,
    socketCount: set.size,
  });
  ws.on("close", (code, reason) => {
    set!.delete(c);
    if (set!.size === 0) byUser.delete(userId);
    log.info("ws_unregister", {
      userId,
      code,
      reason: reason.toString().slice(0, 80),
      durationMs: Date.now() - c.connectedAt,
      remainingSockets: set!.size,
    });
  });
  ws.on("error", (err) => {
    log.warn("ws_error", {
      userId,
      err: err instanceof Error ? err.message : String(err),
    });
  });
  return c;
}

export function sendToUser(userId: string, payload: unknown) {
  const set = byUser.get(userId);
  if (!set) return 0;
  const raw = JSON.stringify(payload);
  let n = 0;
  for (const c of set) {
    if (c.ws.readyState === c.ws.OPEN) {
      c.ws.send(raw);
      n++;
    }
  }
  return n;
}

export function getWsStats() {
  let sockets = 0;
  for (const set of byUser.values()) sockets += set.size;
  return {
    onlineUsers: byUser.size,
    sockets,
  };
}
