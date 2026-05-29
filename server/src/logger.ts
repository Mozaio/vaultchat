/**
 * Structured JSON-Lines Logger.
 *
 * Render captured stdout sowieso — wir wollen aber pro Log-Zeile ein
 * geparstes JSON-Objekt mit konsistenten Feldern, sodass der Render-Log-Tab
 * (oder ein angeschlossener Aggregator) by `level`, `evt`, `userId` filtern
 * kann statt freitext-grep.
 *
 * Bewusst kein pino/winston — keine npm-Dep, keine Buffer-Ringe, keine
 * Maskierung-Magie. Nur JSON.stringify auf stdout/stderr.
 *
 * Konvention:
 *   - level: "info" | "warn" | "error" | "debug"
 *   - evt:   stabiler Event-Code in snake_case (auth_login_ok, ws_connect, …)
 *   - ts:    ISO timestamp
 *   - alle weiteren Felder sind event-spezifisch
 *
 * NIE loggen:
 *   - rohe Klartext-Bodies, DR-Wire-Bytes, Public-Keys mit mehr als 16 Zeichen
 *   - Passwörter, Tokens, Recovery-Mails (ja, der Server kennt sie kurzzeitig
 *     beim Argon2-Verify, nie loggen)
 *   - rohe Client-IPs — stattdessen clientIpTag() (gesalzener Hash, nicht
 *     umkehrbar). Roh nur via VAULTCHAT_LOG_RAW_IP=1 (Debug).
 *
 * OK:
 *   - userId (UUID), username, ipTag, route, status, ms, evt, count.
 */

type Level = "info" | "warn" | "error" | "debug";

interface LogEntry {
  ts: string;
  level: Level;
  evt: string;
  [k: string]: unknown;
}

const LOG_LEVEL = (process.env.VAULTCHAT_LOG_LEVEL ?? "info").toLowerCase();
const LEVEL_ORDER: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldEmit(level: Level): boolean {
  const wantIdx = LEVEL_ORDER[(LOG_LEVEL as Level) ?? "info"] ?? 1;
  return LEVEL_ORDER[level] >= wantIdx;
}

function emit(level: Level, evt: string, fields: Record<string, unknown>) {
  if (!shouldEmit(level)) return;
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    evt,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  debug: (evt: string, fields: Record<string, unknown> = {}) =>
    emit("debug", evt, fields),
  info: (evt: string, fields: Record<string, unknown> = {}) =>
    emit("info", evt, fields),
  warn: (evt: string, fields: Record<string, unknown> = {}) =>
    emit("warn", evt, fields),
  error: (evt: string, fields: Record<string, unknown> = {}) =>
    emit("error", evt, fields),
};

/**
 * Express-Middleware: loggt jeden Request mit Methode, Pfad, Status, Dauer.
 * Nur Pfad, kein Query-String (kann sensibles enthalten — z.B. ?q=...).
 *
 * Plus Request-ID: jeder Request bekommt eine kurze, eindeutige ID
 * (X-Request-Id falls vom Client/Render gesetzt, sonst random base36).
 * Die ID liegt als req.id auf jedem Request-Objekt und wird in
 * http_request mit-geloggt — Operations kann dann einen Bug-Report
 * "ich habe um 14:32 Uhr versucht zu registrieren" mit den passenden
 * Log-Zeilen korrelieren ohne reine Zeitstempel zu raten.
 */
import type { Request, Response, NextFunction } from "express";
import { createHmac, randomBytes, randomUUID } from "node:crypto";

/**
 * Privacy: never write raw client IPs to logs. Raw IPs linked to
 * username+timestamp are exactly the social-graph metadata this product
 * promises not to retain. Instead we log a short, NON-reversible,
 * per-process-salted tag — enough to spot "many requests from one source"
 * for abuse triage within a run, but useless as a stored identifier and
 * not correlatable across restarts. Raw IP only if explicitly opted in.
 */
const IP_SALT = process.env.VAULTCHAT_LOG_IP_SALT ?? randomBytes(16).toString("hex");
const LOG_RAW_IP = process.env.VAULTCHAT_LOG_RAW_IP === "1";

export function clientIpTag(ip: string | undefined | null): string {
  if (!ip) return "unknown";
  if (LOG_RAW_IP) return ip;
  return "ip_" + createHmac("sha256", IP_SALT).update(ip).digest("hex").slice(0, 10);
}

declare module "express-serve-static-core" {
  interface Request {
    id?: string;
  }
}

function makeRequestId(req: Request): string {
  const incoming = req.header("x-request-id");
  if (incoming && /^[A-Za-z0-9-]{4,64}$/.test(incoming)) return incoming;
  // Kurze ID: erste 12 Zeichen einer UUID ohne Bindestriche reichen für
  // Korrelation im 5-min-Fenster, sind aber lesbar im Log.
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  req.id = makeRequestId(req);
  res.setHeader("X-Request-Id", req.id);
  res.on("finish", () => {
    // /healthz und /readyz sind Render-Polls und würden den Log-Stream
    // mit Lärm fluten — die zählen wir auf debug.
    const isProbe = req.path === "/healthz" || req.path === "/readyz";
    log[isProbe ? "debug" : "info"]("http_request", {
      reqId: req.id,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
      ipTag: clientIpTag(req.ip),
    });
  });
  next();
}
