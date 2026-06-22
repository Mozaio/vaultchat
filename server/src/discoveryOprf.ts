// GOAL 0.1d-2: server side of the OPRF for blind contact discovery.
//
// The server holds a long-lived secret scalar k. Given a client-blinded
// ristretto255 point B = r*H1(username) it returns E = k*B. After unblinding
// (r^-1 * E = k*H1(username)) the client derives a deterministic discovery tag
// without the server ever seeing the username — it only ever handles a
// uniformly random point. See DISCOVERY_SPEC.md (incl. the honest limitation:
// a *malicious* server holding k can still brute-force low-entropy names).
//
// libsodium is imported LAZILY so a missing/broken WASM dependency can never
// crash server startup — at worst this (currently dormant) feature errors out.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sodiumPromise: Promise<any> | null = null;

async function getSodium(): Promise<any> {
  if (!sodiumPromise) {
    sodiumPromise = (async () => {
      const mod: any = await import("libsodium-wrappers-sumo");
      const sodium = mod.default ?? mod;
      await sodium.ready;
      return sodium;
    })();
  }
  return sodiumPromise;
}

/** Decode the 32-byte OPRF scalar from hex or base64; null if absent/wrong size. */
function decodeKey(raw: string): Uint8Array | null {
  const t = raw.trim();
  if (!t) return null;
  const buf = /^[0-9a-fA-F]{64}$/.test(t)
    ? Buffer.from(t, "hex")
    : Buffer.from(t, "base64");
  return buf.length === 32 ? new Uint8Array(buf) : null;
}

/** True iff VAULTCHAT_DISCOVERY_OPRF_KEY is a usable 32-byte scalar. */
export function discoveryConfigured(): boolean {
  return decodeKey(process.env.VAULTCHAT_DISCOVERY_OPRF_KEY ?? "") !== null;
}

export type EvaluateResult =
  | { ok: true; evaluated: string }
  | { ok: false; reason: "unconfigured" | "bad_input" };

/**
 * Evaluate the OPRF on a base64-encoded blinded ristretto255 point.
 * Returns base64(k*B) or a structured failure. Never throws.
 */
export async function evaluateBlinded(blindedB64: string): Promise<EvaluateResult> {
  const key = decodeKey(process.env.VAULTCHAT_DISCOVERY_OPRF_KEY ?? "");
  if (!key) return { ok: false, reason: "unconfigured" };

  let B: Buffer;
  try {
    B = Buffer.from(blindedB64, "base64");
  } catch {
    return { ok: false, reason: "bad_input" };
  }
  if (B.length !== 32) return { ok: false, reason: "bad_input" };

  try {
    const sodium = await getSodium();
    const E: Uint8Array = sodium.crypto_scalarmult_ristretto255(
      key,
      new Uint8Array(B)
    );
    return { ok: true, evaluated: Buffer.from(E).toString("base64") };
  } catch {
    // Non-canonical / identity point, or an unusable key: report as bad input
    // without leaking which case occurred.
    return { ok: false, reason: "bad_input" };
  }
}
