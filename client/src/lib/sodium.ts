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

/** Opaker State-Typ für streaming-Hash (BLAKE2b multipart). */
export type GenerichashState = { readonly __brand: "GenerichashState" };

/** KeyPair-Shape von libsodium. */
export interface SodiumKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  keyType: string;
}

/**
 * Strukturelles Interface über die in VaultChat verwendeten libsodium-Methoden.
 * Methoden sind absichtlich NICHT vollständig getypt (libsodium hat ~250
 * Methoden) — der Vertrag deckt aber den App-Hot-Path ab.
 */
export interface SodiumApi {
  // Konstanten
  crypto_pwhash_SALTBYTES: number;
  crypto_secretbox_KEYBYTES: number;
  crypto_secretbox_NONCEBYTES: number;
  crypto_pwhash_OPSLIMIT_INTERACTIVE: number;
  crypto_pwhash_MEMLIMIT_INTERACTIVE: number;
  crypto_box_PUBLICKEYBYTES: number;
  crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number;
  crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
  crypto_aead_xchacha20poly1305_ietf_ABYTES: number;
  crypto_pwhash_ALG_ARGON2ID?: number;
  crypto_pwhash_ALG_ARGON2ID13?: number;
  crypto_pwhash_ALG_DEFAULT?: number;

  // RNG / Memory
  randombytes_buf(size: number): Uint8Array;
  memzero(buf: Uint8Array): void;

  // Hash
  crypto_generichash(outLen: number, input: Uint8Array, key?: Uint8Array): Uint8Array;
  crypto_generichash_init(key: Uint8Array | null, outLen: number): GenerichashState;
  crypto_generichash_update(state: GenerichashState, input: Uint8Array): void;
  crypto_generichash_final(state: GenerichashState, outLen: number): Uint8Array;

  // X25519 / Box
  crypto_scalarmult(sk: Uint8Array, pk: Uint8Array): Uint8Array;
  crypto_box_keypair(): SodiumKeyPair;
  crypto_box_seal(message: Uint8Array, recipientPk: Uint8Array): Uint8Array;
  crypto_box_seal_open(
    sealed: Uint8Array,
    recipientPk: Uint8Array,
    recipientSk: Uint8Array
  ): Uint8Array;

  // Ed25519 (sign)
  crypto_sign_seed_keypair(seed: Uint8Array): SodiumKeyPair;
  crypto_sign_detached(message: Uint8Array, sk: Uint8Array): Uint8Array;
  crypto_sign_verify_detached?(sig: Uint8Array, message: Uint8Array, pk: Uint8Array): boolean;

  // Secretbox
  crypto_secretbox_easy(
    message: Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array
  ): Uint8Array;
  crypto_secretbox_open_easy(
    cipher: Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array
  ): Uint8Array;

  // AEAD XChaCha20-Poly1305
  crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext: Uint8Array,
    aad: Uint8Array | null,
    secretNonce: Uint8Array | null,
    nonce: Uint8Array,
    key: Uint8Array
  ): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_decrypt(
    secretNonce: Uint8Array | null,
    cipher: Uint8Array,
    aad: Uint8Array | null,
    nonce: Uint8Array,
    key: Uint8Array
  ): Uint8Array;

  // Password Hashing
  crypto_pwhash(
    outLen: number,
    password: string | Uint8Array,
    salt: Uint8Array,
    opslimit: number,
    memlimit: number,
    alg: number
  ): Uint8Array;
}

interface SodiumModule extends SodiumApi {
  ready: Promise<void>;
}

interface RawImport {
  default?: SodiumModule;
  ready?: Promise<void>;
  [key: string]: unknown;
}

/** Das Objekt, auf dem libsodium nach `ready` die API mountet. */
function apiRoot(): SodiumModule {
  const m = sodiumImport as unknown as RawImport;
  const inner = m?.default;
  if (inner && typeof inner.ready?.then === "function") return inner;
  if (m && typeof m.ready?.then === "function") return m as unknown as SodiumModule;
  throw new Error(
    "libsodium-wrappers-sumo: kein Objekt mit .ready gefunden (Interop kaputt)."
  );
}

const _root = apiRoot();

let readyPromise: Promise<void> | null = null;

export function sodiumReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = _root.ready.then(() => {
      validate(_root);
    });
  }
  return readyPromise;
}

export function getSodium(): SodiumApi {
  if (!_root || typeof _root.randombytes_buf !== "function") {
    throw new Error(
      "libsodium nicht initialisiert. sodiumReady() vorher aufrufen."
    );
  }
  return _root;
}

function validate(s: SodiumModule): void {
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
  const sAny = s as unknown as Record<string, unknown>;
  const missing = required.filter((k) => typeof sAny[k] !== "number");
  const hasPwhashAlg =
    typeof s.crypto_pwhash_ALG_ARGON2ID === "number" ||
    typeof s.crypto_pwhash_ALG_ARGON2ID13 === "number" ||
    typeof s.crypto_pwhash_ALG_DEFAULT === "number";
  if (!hasPwhashAlg) missing.push("crypto_pwhash_ALG_(ARGON2ID|ARGON2ID13|DEFAULT)" as never);
  if (missing.length > 0) {
    throw new Error(
      "libsodium nach ready() unvollständig: " +
        missing.join(", ") +
        ". Keys: " +
        Object.getOwnPropertyNames(s).slice(0, 40).join(", ")
    );
  }
}
