/**
 * Robuster libsodium-Loader.
 *
 * Hintergrund: libsodium-wrappers ist ein CJS-Modul, das nach dem Laden der
 * WASM-Runtime seine Konstanten (z. B. crypto_pwhash_SALTBYTES) dynamisch an
 * den Namespace haengt. Rollup-basierte Bundler (Vite Build) koennen je nach
 * commonjs-Konfiguration statt der "lebendigen" Referenz eine frozen copy
 * ausliefern — dann sind die Konstanten beim Aufruf undefined und libsodium
 * wirft "length cannot be null or undefined".
 *
 * Dieser Wrapper:
 *   1. holt die korrekte Namespace-Referenz aus allen moeglichen Interop-Shapes,
 *   2. await'ed `.ready`,
 *   3. validiert am Ende, dass die wichtigsten Konstanten gesetzt sind,
 *   4. liefert klare Fehler, falls nicht.
 */

import * as sodiumNamespace from "libsodium-wrappers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sodium = any;

function pickNamespace(): Sodium {
  const mod: Sodium = sodiumNamespace;
  // Verschiedene Interop-Varianten (CJS-default, doppelt gewrappt, namespace).
  const candidates: Sodium[] = [
    mod,
    mod?.default,
    mod?.default?.default,
  ].filter(Boolean);
  for (const c of candidates) {
    if (c && typeof c.ready?.then === "function") return c;
  }
  throw new Error(
    "libsodium-wrappers: .ready not found on any import shape. " +
      "Bundler-Interop moeglicherweise defekt."
  );
}

const _sodium: Sodium = pickNamespace();

let readyPromise: Promise<void> | null = null;

export function sodiumReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = (_sodium.ready as Promise<void>).then(() => {
      validate(_sodium);
    });
  }
  return readyPromise;
}

export function getSodium(): Sodium {
  if (!_sodium || typeof _sodium.randombytes_buf !== "function") {
    throw new Error(
      "libsodium nicht initialisiert. Hast du sodiumReady() vor der Benutzung awaited?"
    );
  }
  return _sodium;
}

function validate(s: Sodium): void {
  const required = [
    "crypto_pwhash_SALTBYTES",
    "crypto_secretbox_KEYBYTES",
    "crypto_secretbox_NONCEBYTES",
    "crypto_pwhash_OPSLIMIT_INTERACTIVE",
    "crypto_pwhash_MEMLIMIT_INTERACTIVE",
    "crypto_pwhash_ALG_ARGON2ID",
    "crypto_box_PUBLICKEYBYTES",
    "crypto_aead_xchacha20poly1305_ietf_KEYBYTES",
    "crypto_aead_xchacha20poly1305_ietf_NPUBBYTES",
    "crypto_aead_xchacha20poly1305_ietf_ABYTES",
  ] as const;
  const missing = required.filter((k) => typeof s[k] !== "number");
  if (missing.length === 0) return;

  // Fallback: wenn das Modul ein nicht-live Snapshot ist, versuchen wir per
  // Property-Lookup auf dem globalen window.sodium (falls libsodium es dort
  // hinterlegt) zu referenzieren. Viele libsodium-Builds setzen globalThis.sodium
  // beim WASM-Init.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = (globalThis as any).sodium;
  if (g && typeof g.crypto_pwhash_SALTBYTES === "number") {
    // Lebende Referenz ins eigene Objekt hineinkopieren (Properties zuweisen,
    // damit sich alle bereits gecachten Referenzen auf _sodium weiterhin
    // auflosen lassen).
    for (const k of Object.getOwnPropertyNames(g)) {
      try {
        (s as Record<string, unknown>)[k] = (g as Record<string, unknown>)[k];
      } catch {
        /* ignore */
      }
    }
    const stillMissing = required.filter((k) => typeof s[k] !== "number");
    if (stillMissing.length === 0) return;
  }

  throw new Error(
    "libsodium-Konstanten nicht verfuegbar nach ready(): " +
      missing.join(", ") +
      ". Build-Interop kaputt — siehe vite.config.ts. Vorhandene Keys: " +
      Object.getOwnPropertyNames(s).slice(0, 20).join(", ")
  );
}
