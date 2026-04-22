/**
 * Browser-Apps haben ein fundamentales Trust-on-Every-Load-Problem: der
 * Host liefert bei jedem Aufruf frisches JS. Wir können dieses Problem im
 * Browser-Sandbox-Modell nicht lösen, aber wir können:
 *
 *  1. Den SHA-384-Hash des Main-Bundles bei jedem Start berechnen.
 *  2. Den Hash bei erstem Vertrauen lokal pinnen (localStorage, nicht LDK,
 *     da wir ihn vor Entsperren brauchen).
 *  3. Bei künftigen Starts den neuen Hash mit dem gepinnten vergleichen und
 *     den Benutzer warnen.
 *
 * Das ist eine TOFU-Policy für den App-Code selbst. Wer den Code des
 * Publishers aus unabhängiger Quelle kennt (Reproducible Build, publizierter
 * Hash), kann diesen auch manuell vergleichen.
 */

const PIN_KEY = "vaultchat.codeHash.pin";

async function sha384Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-384", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`fetch_${r.status}`);
  return r.text();
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`fetch_${r.status}`);
  return r.arrayBuffer();
}

/** Sucht im aktuellen Dokument nach dem Haupt-Script und berechnet dessen Hash. */
export async function computeMainScriptHash(): Promise<string> {
  const doc = await fetchText(new URL("/", location.href).toString());
  const m = doc.match(/<script[^>]+src="([^"]+\.js)"/i);
  if (!m) {
    const scripts = Array.from(document.scripts)
      .map((s) => s.src)
      .filter((x) => /\.js(\?|$)/i.test(x));
    if (scripts.length === 0) throw new Error("no_script_found");
    const buf = await fetchBytes(scripts[0]!);
    return sha384Hex(buf);
  }
  const abs = new URL(m[1]!, location.href).toString();
  const buf = await fetchBytes(abs);
  return sha384Hex(buf);
}

export function getPinnedCodeHash(): string | null {
  try {
    return localStorage.getItem(PIN_KEY);
  } catch {
    return null;
  }
}

export function pinCodeHash(hash: string): void {
  try {
    localStorage.setItem(PIN_KEY, hash);
  } catch {
    /* ignore */
  }
}

export function clearPinnedCodeHash(): void {
  try {
    localStorage.removeItem(PIN_KEY);
  } catch {
    /* ignore */
  }
}

export type CodeCheck =
  | { state: "unknown"; hash: string }
  | { state: "pinned_ok"; hash: string }
  | { state: "pinned_mismatch"; hash: string; pinned: string };

export async function checkCodeIntegrity(): Promise<CodeCheck> {
  const hash = await computeMainScriptHash();
  const pinned = getPinnedCodeHash();
  if (!pinned) return { state: "unknown", hash };
  if (pinned === hash) return { state: "pinned_ok", hash };
  return { state: "pinned_mismatch", hash, pinned };
}
