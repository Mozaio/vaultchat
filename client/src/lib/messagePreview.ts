import type { PlainPayload } from "./crypto";
import { t } from "./i18n";

/**
 * Flatten markdown for one-line previews (sidebar, notifications, reply
 * quotes): drop formatting markers, replace fenced code with a placeholder,
 * collapse newlines — and crucially MASK spoilers so ||secret|| never leaks
 * into an OS notification or list preview.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/\|\|[^|\n]+\|\|/g, "▒▒▒")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
}

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
    return `🔒 ${t("preview.viewOnce")}`;
  }
  switch (p.kind) {
    case "text":
      return truncate(stripMarkdown(p.body ?? ""));
    case "file":
      if (isImagePayload(p))
        return `📷 ${t("msg.imageFallback")}${p.fileName ? ` · ${p.fileName}` : ""}`;
      return `📎 ${p.fileName ?? t("chat.fileFallback")}`;
    case "voice":
      return `🎤 ${t("chat.voiceMessage")} ${fmtDuration(p.durationMs)}`;
    case "poll":
      return `📊 ${t("preview.poll")}${p.pollQuestion ? `: ${truncate(p.pollQuestion, 48)}` : ""}`;
    default:
      return "";
  }
}
