/**
 * Custom emoji library — local-only, per-user.
 *
 * Users can upload their own images (PNGs/JPEGs) which are auto-resized
 * to 48×48 PNG data URLs and stored in localStorage. Custom emojis can be
 * used as message reactions and inline in messages: the resulting data
 * URL is sent verbatim to peers, who render it via <img>. No server,
 * no cross-device sync, no privacy compromise.
 */

export type CustomEmoji = {
  id: string;
  name: string;
  dataUrl: string;
  createdAt: number;
};

const STORAGE_KEY = "vaultchat.customEmojis.v1";
const MAX_EMOJIS = 32;
const RESIZE_PX = 48;
const JPEG_QUALITY = 0.85;
const MAX_DATA_URL_BYTES = 8 * 1024;

function newId(): string {
  return (
    (globalThis.crypto?.randomUUID?.() as string | undefined) ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );
}

export function loadCustomEmojis(): CustomEmoji[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const valid: CustomEmoji[] = [];
    for (const item of parsed) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as CustomEmoji).id === "string" &&
        typeof (item as CustomEmoji).name === "string" &&
        typeof (item as CustomEmoji).dataUrl === "string" &&
        (item as CustomEmoji).dataUrl.startsWith("data:image/") &&
        typeof (item as CustomEmoji).createdAt === "number"
      ) {
        valid.push(item as CustomEmoji);
      }
    }
    return valid;
  } catch {
    return [];
  }
}

export function saveCustomEmojis(list: CustomEmoji[]): void {
  try {
    const trimmed = list.slice(0, MAX_EMOJIS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    /* ignore quota errors */
  }
}

export function removeCustomEmoji(id: string): void {
  saveCustomEmojis(loadCustomEmojis().filter((e) => e.id !== id));
}

export function isCustomEmoji(s: string): boolean {
  return typeof s === "string" && s.startsWith("data:image/");
}

/**
 * Add a custom emoji from a File. Resizes to a square PNG/JPEG of
 * RESIZE_PX × RESIZE_PX, suitable for inline rendering. Throws if the
 * resulting data URL exceeds MAX_DATA_URL_BYTES.
 */
export async function addCustomEmojiFromFile(
  file: File,
  name?: string
): Promise<CustomEmoji> {
  if (!file.type.startsWith("image/")) {
    throw new Error("emoji_invalid_type");
  }
  const dataUrl = await resizeImageToDataUrl(file, RESIZE_PX);
  if (dataUrl.length > MAX_DATA_URL_BYTES) {
    throw new Error("emoji_too_large");
  }
  const trimmedName = (name ?? file.name.replace(/\.[^.]+$/, ""))
    .trim()
    .slice(0, 32);
  const emoji: CustomEmoji = {
    id: newId(),
    name: trimmedName || "emoji",
    dataUrl,
    createdAt: Date.now(),
  };
  const all = loadCustomEmojis();
  all.unshift(emoji);
  saveCustomEmojis(all);
  return emoji;
}

async function resizeImageToDataUrl(file: File, size: number): Promise<string> {
  const sourceUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("emoji_read_failed"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onerror = () => reject(new Error("emoji_decode_failed"));
    i.onload = () => resolve(i);
    i.src = sourceUrl;
  });
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const minSide = Math.min(w, h);
  const sx = (w - minSide) / 2;
  const sy = (h - minSide) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("emoji_canvas_unavailable");
  // Use high-quality smoothing for the downscale.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);
  // Try PNG first (preserves transparency); fall back to JPEG if oversized.
  const pngUrl = canvas.toDataURL("image/png");
  if (pngUrl.length <= MAX_DATA_URL_BYTES) return pngUrl;
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}
