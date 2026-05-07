/**
 * Per-thread "last seen" tracking — persisted in localStorage.
 *
 * For each parent message CID, we store the timestamp of the most recent
 * reply the user has acknowledged (by opening the thread panel). Counts of
 * replies after that timestamp are surfaced as an unread badge on the
 * thread indicator.
 */

const STORAGE_KEY = "vaultchat.threads.lastSeen.v1";
const MAX_ENTRIES = 500;

export type ThreadSeenMap = Record<string, number>;

export function loadThreadSeen(): ThreadSeenMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: ThreadSeenMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveThreadSeen(map: ThreadSeenMap): void {
  try {
    // Trim to most recent MAX_ENTRIES to avoid unbounded growth.
    const entries = Object.entries(map);
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => b[1] - a[1]);
      const trimmed: ThreadSeenMap = {};
      for (let i = 0; i < MAX_ENTRIES; i++) {
        const e = entries[i]!;
        trimmed[e[0]] = e[1];
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    }
  } catch {
    /* ignore quota */
  }
}

export function markThreadSeen(parentCid: string, atMs?: number): ThreadSeenMap {
  const map = loadThreadSeen();
  map[parentCid] = atMs ?? Date.now();
  saveThreadSeen(map);
  return map;
}
