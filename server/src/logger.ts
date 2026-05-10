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
 *
 * OK:
 *   - userId (UUID), username, ip, route, status, ms, evt, count.
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
 */
import type { Request, Response, NextFunction } from "express";

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on("finish", () => {
    // /healthz und /readyz sind Render-Polls und würden den Log-Stream
    // mit Lärm fluten — die zählen wir auf debug.
    const isProbe = req.path === "/healthz" || req.path === "/readyz";
    log[isProbe ? "debug" : "info"]("http_request", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
      ip: req.ip,
    });
  });
  next();
}
