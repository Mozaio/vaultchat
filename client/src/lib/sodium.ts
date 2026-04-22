/**
 * libsodium-wrappers-**sumo** (CJS): voller WASM inkl. Argon2id (`crypto_pwhash`).
 * Die schlanke Variante `libsodium-wrappers` liefert kein pwhash — dann fehlen
 * crypto_pwhash_SALTBYTES & Co. nach ready().
 *
 * Default-Export mutiert nach `ready()`; Namespace-Import ist weiterhin riskant.
 *
 * `import * as ns from "libsodium-wrappers-sumo"` liefert dagegen oft ein synthetisches
 * Namespace-Objekt: `.ready` ist erreichbar, aber die später hinzugefügten
 * crypto_*-Member liegen nur auf `ns.default`. Validieren wir `ns`, scheitern wir
 * mit „Konstanten fehlen“, obwohl WASM korrekt geladen ist.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import sodiumImport from "libsodium-wrappers-sumo";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sodium = any;

/** Das Objekt, auf dem libsodium nach `ready` die API mountet. */
function apiRoot(): Sodium {
  const m = sodiumImport as Sodium;
  const inner = m?.default;
  if (inner && typeof inner.ready?.then === "function") return inner;
  if (m && typeof m.ready?.then === "function") return m;
  throw new Error(
    "libsodium-wrappers-sumo: kein Objekt mit .ready gefunden (Interop kaputt)."
  );
}

const _root = apiRoot();

let readyPromise: Promise<void> | null = null;

export function sodiumReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = (_root.ready as Promise<void>).then(() => {
      validate(_root);
    });
  }
  return readyPromise;
}

export function getSodium(): Sodium {
  if (!_root || typeof _root.randombytes_buf !== "function") {
    throw new Error(
      "libsodium nicht initialisiert. sodiumReady() vorher aufrufen."
    );
  }
  return _root;
}

function validate(s: Sodium): void {
  const required = [
    "crypto_pwhash_SALTBYTES",
    "crypto_secretbox_KEYBYTES",
    "crypto_secretbox_NONCEBYTES",
    "crypto_pwhash_OPSLIMIT_INTERACTIVE",
    "crypto_pwhash_MEMLIMIT_INTERACTIVE",
    "crypto_box_PUBLICKEYBYTES",
    "crypto_aead_xchacha20poly1305_ietf_KEYBYTES",
    "crypto_aead_xchacha20poly1305_ietf_NPUBBYTES",
    "crypto_aead_xchacha20poly1305_ietf_ABYTES",
  ] as const;
  const missing = required.filter((k) => typeof s[k] !== "number");
  const hasPwhashAlg =
    typeof s.crypto_pwhash_ALG_ARGON2ID === "number" ||
    typeof s.crypto_pwhash_ALG_ARGON2ID13 === "number" ||
    typeof s.crypto_pwhash_ALG_DEFAULT === "number";
  if (!hasPwhashAlg) missing.push("crypto_pwhash_ALG_(ARGON2ID|ARGON2ID13|DEFAULT)");
  if (missing.length > 0) {
    throw new Error(
      "libsodium nach ready() unvollständig: " +
        missing.join(", ") +
        ". Keys: " +
        Object.getOwnPropertyNames(s).slice(0, 40).join(", ")
    );
  }
}
