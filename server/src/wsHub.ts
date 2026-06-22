import type { WebSocket } from "ws";
import { log } from "./logger.js";

type Client = {
  ws: WebSocket;
  userId: string;
  connectedAt: number;
  /** Opake, client-erzeugte Geräte-/Session-ID (aus dem `dv`-JWT-Claim).
   *  Nicht identitäts-/hardware-gebunden. Fehlt bei Alt-Clients. */
  deviceId?: string;
};

const byUser = new Map<string, Set<Client>>();

/**
 * Content-blind anti-exhaustion cap: one account may hold at most this many
 * concurrent WebSockets. Without it a single (malicious or buggy) account
 * could open unbounded sockets and exhaust the RAM-only relay. We evict the
 * OLDEST socket instead of rejecting the newest, so a reconnecting client is
 * never locked out by stale sockets that have not been cleaned up yet. A
 * non-positive / unparseable value disables the cap (fail-open).
 */
const MAX_SOCKETS_PER_USER = Number(process.env.VAULTCHAT_MAX_SOCKETS_PER_USER ?? 16);

export function registerClient(
  userId: string,
  ws: WebSocket,
  deviceId?: string
) {
  const c: Client = {
    ws,
    userId,
    connectedAt: Date.now(),
    ...(deviceId ? { deviceId } : {}),
  };
  let set = byUser.get(userId);
  if (!set) {
    set = new Set();
    byUser.set(userId, set);
  }
  set.add(c);
  if (MAX_SOCKETS_PER_USER > 0 && set.size > MAX_SOCKETS_PER_USER) {
    let oldest: Client | null = null;
    for (const existing of set) {
      if (existing === c) continue;
      if (!oldest || existing.connectedAt < oldest.connectedAt) oldest = existing;
    }
    if (oldest) {
      log.warn("ws_socket_cap_evict", {
        userId,
        socketCount: set.size,
        cap: MAX_SOCKETS_PER_USER,
      });
      try {
        oldest.ws.close(4429, "too_many_connections");
      } catch {
        /* socket already closing; its close handler removes it from the set */
      }
    }
  }
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

/**
 * Trennt alle offenen WebSockets eines Users sofort (z.B. nach Token-
 * Revocation / "auf allen Geräten abmelden"). Ohne dies blieben bereits
 * offene Verbindungen bis zum nächsten Reconnect bestehen. Iteriert über
 * eine Kopie, weil close() den "close"-Handler triggert, der das Set mutiert.
 */
export function disconnectUser(
  userId: string,
  code = 4401,
  reason = "revoked"
): number {
  const set = byUser.get(userId);
  if (!set) return 0;
  let n = 0;
  for (const c of [...set]) {
    try {
      c.ws.close(code, reason);
      n++;
    } catch {
      /* socket bereits am Schließen */
    }
  }
  return n;
}

/**
 * Listet die AKTUELL VERBUNDENEN Sessions eines Users (für die Geräte-
 * Verwaltung). Quelle ist rein die ephemere Live-WS-Registry — keine
 * persistenten Metadaten. Pro Session nur die opake `deviceId` und die
 * Verbindungszeit; KEINE IP, kein User-Agent, kein Label (ZK-Grenze).
 * Sessions ohne deviceId (Alt-Clients) werden mit `null` gemeldet, damit die
 * UI sie zumindest zählen kann.
 */
export function listUserDevices(
  userId: string
): Array<{ deviceId: string | null; connectedAt: number }> {
  const set = byUser.get(userId);
  if (!set) return [];
  const out: Array<{ deviceId: string | null; connectedAt: number }> = [];
  for (const c of set) {
    if (c.ws.readyState !== c.ws.OPEN) continue;
    out.push({ deviceId: c.deviceId ?? null, connectedAt: c.connectedAt });
  }
  // Älteste zuerst (stabile Anzeige).
  out.sort((a, b) => a.connectedAt - b.connectedAt);
  return out;
}

/**
 * Trennt sofort alle offenen Sockets EINES Geräts (per opaker deviceId) eines
 * Users. Ergänzt die Einzel-Token-Revocation (`deviceSessions`): die
 * Revocation entwertet künftige verifyToken-Aufrufe, dieser Aufruf wirft die
 * bereits offene Verbindung sofort raus. Gibt die Anzahl getrennter Sockets
 * zurück.
 */
export function disconnectDevice(
  userId: string,
  deviceId: string,
  code = 4401,
  reason = "device_revoked"
): number {
  const set = byUser.get(userId);
  if (!set) return 0;
  let n = 0;
  for (const c of [...set]) {
    if (c.deviceId !== deviceId) continue;
    try {
      c.ws.close(code, reason);
      n++;
    } catch {
      /* socket bereits am Schließen */
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
