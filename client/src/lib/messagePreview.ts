import type { PlainPayload } from "./crypto";

export function fmtDuration(ms?: number): string {
  if (!ms) return "0:00";
  const s = Math.max(1, Math.round(ms / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${ss.toString().padStart(2, "0")}`;
}

export function truncate(text: string, n = 64): string {
  if (!text) return "";
  return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

export function formatFileSize(bytes?: number): string {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function isImagePayload(p: PlainPayload): boolean {
  return p.kind === "file" && typeof p.mime === "string" && p.mime.startsWith("image/");
}

export function previewForPayload(p: PlainPayload): string {
  // Never leak the body of a view-once message via list previews,
  // notifications, reply quotes, etc. — the whole point is that the
  // recipient sees the content exactly once, deliberately.
  if (p.viewOnce && (p.kind === "text" || p.kind === "file" || p.kind === "voice")) {
    return "🔒 Einmal-Nachricht";
  }
  switch (p.kind) {
    case "text":
      return truncate(p.body ?? "");
    case "file":
      if (isImagePayload(p)) return `📷 Bild${p.fileName ? ` · ${p.fileName}` : ""}`;
      return `📎 ${p.fileName ?? "Datei"}`;
    case "voice":
      return `🎤 Sprachnachricht ${fmtDuration(p.durationMs)}`;
    case "poll":
      return `📊 Umfrage${p.pollQuestion ? `: ${truncate(p.pollQuestion, 48)}` : ""}`;
    default:
      return "";
  }
}
