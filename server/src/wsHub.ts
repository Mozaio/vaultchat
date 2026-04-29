import type { WebSocket } from "ws";

type Client = { ws: WebSocket; userId: string };

const byUser = new Map<string, Set<Client>>();

export function registerClient(userId: string, ws: WebSocket) {
  const c: Client = { ws, userId };
  let set = byUser.get(userId);
  if (!set) {
    set = new Set();
    byUser.set(userId, set);
  }
  set.add(c);
  ws.on("close", () => {
    set!.delete(c);
    if (set!.size === 0) byUser.delete(userId);
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
