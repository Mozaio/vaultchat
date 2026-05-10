/**
 * Domain-agnostische Chat-Helpers, die ChatShell bisher inline hatte.
 * Hierher verschoben, damit ChatShell.tsx schrumpft und die Helpers von
 * anderen Komponenten (ThreadPanel, SearchPanel, MessageBubble, …)
 * mit-genutzt werden können ohne ChatShell-Import.
 */

/** UUID v4 (oder simpler base36-Fallback wenn crypto.randomUUID fehlt). */
export function newCid(): string {
  return (
    (globalThis.crypto?.randomUUID?.() as string | undefined) ??
    Math.random().toString(36).slice(2)
  );
}

/** mm:ss für Voice-Recording-Elapsed. Adds 🔴 prefix beyond 1 min. */
export function formatElapsedMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const prefix = m >= 1 ? "🔴 " : "";
  return `${prefix}${m}:${s.toString().padStart(2, "0")}`;
}

/** WhatsApp/Telegram-style date separator label (DE). */
export function fmtDateLabel(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (msgDay.getTime() === today.getTime()) return "Heute";
  if (msgDay.getTime() === yesterday.getTime()) return "Gestern";
  return d.toLocaleDateString("de-DE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

/** Discord-like deterministic avatar color from user ID. */
export function userColor(userId: string): string {
  const colors = [
    "#ef4444", "#f97316", "#f59e0b", "#84cc16", "#10b981",
    "#06b6d4", "#3b82f6", "#6366f1", "#8b5cf6", "#d946ef",
    "#f43f5e", "#14b8a6", "#0ea5e9", "#a855f7", "#ec4899",
  ];
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const idx = Math.abs(hash) % colors.length;
  return colors[idx]!;
}

export function userGradient(userId: string): string {
  const base = userColor(userId);
  return `linear-gradient(135deg, ${base} 0%, ${base}dd 100%)`;
}

/** localStorage-set persistence (string-Set). */
export function loadStringSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === "string")
        : []
    );
  } catch {
    return new Set();
  }
}

export function saveStringSet(key: string, value: Set<string>) {
  localStorage.setItem(key, JSON.stringify(Array.from(value)));
}
