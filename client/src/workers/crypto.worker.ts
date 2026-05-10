/**
 * VaultChat Crypto Worker.
 *
 * Offloads CPU-heavy crypto (Argon2id KDF, secretbox enc/dec) onto a
 * dedicated worker so the main thread stays responsive during Login,
 * Backup-Restore und Plan-Wechsel. Sodium's Argon2 with INTERACTIVE
 * limits takes 600–1200ms on a desktop browser and would otherwise
 * freeze the UI (no spinner animation, click latency).
 *
 * Wire-Protokoll (worker postMessage):
 *   { id, op, args }   → command from client
 *   { id, result }     → success
 *   { id, error }      → failure (string)
 *
 * Sodium wird im Worker eigenständig initialisiert (eigene WASM-Instanz).
 * Der Main-Thread-Sodium und der Worker-Sodium sind getrennte VM-Instanzen.
 */

import { sodiumReady, getSodium } from "../lib/sodium";
import { base64FromUint8, uint8FromBase64 } from "../lib/b64";

type WrapArgs = {
  secretKeyB64: string;
  password: string;
};

type UnwrapArgs = {
  saltB64: string;
  nonceB64: string;
  cipherB64: string;
  password: string;
};

type DeriveKeyArgs = {
  password: string;
  saltB64: string;
};

type Op =
  | { id: string; op: "wrapSecretKey"; args: WrapArgs }
  | { id: string; op: "unwrapSecretKey"; args: UnwrapArgs }
  | { id: string; op: "deriveKdfKey"; args: DeriveKeyArgs }
  | { id: string; op: "ping" };

function pwhashAlg(): number {
  const sodium = getSodium();
  const alg =
    sodium.crypto_pwhash_ALG_ARGON2ID ??
    sodium.crypto_pwhash_ALG_ARGON2ID13 ??
    sodium.crypto_pwhash_ALG_DEFAULT;
  if (typeof alg !== "number") throw new Error("argon2_algorithm_unavailable");
  return alg;
}

async function handle(msg: Op): Promise<unknown> {
  await sodiumReady();
  const sodium = getSodium();

  if (msg.op === "ping") {
    return { ok: true };
  }

  if (msg.op === "wrapSecretKey") {
    const { secretKeyB64, password } = msg.args;
    const secretKey = uint8FromBase64(secretKeyB64);
    const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
    const key = sodium.crypto_pwhash(
      sodium.crypto_secretbox_KEYBYTES,
      password,
      salt,
      sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
      pwhashAlg()
    );
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const cipher = sodium.crypto_secretbox_easy(secretKey, nonce, key);
    sodium.memzero(key);
    sodium.memzero(secretKey);
    return {
      salt: base64FromUint8(salt),
      nonce: base64FromUint8(nonce),
      cipher: base64FromUint8(cipher),
    };
  }

  if (msg.op === "unwrapSecretKey") {
    const { saltB64, nonceB64, cipherB64, password } = msg.args;
    const salt = uint8FromBase64(saltB64);
    const nonce = uint8FromBase64(nonceB64);
    const cipher = uint8FromBase64(cipherB64);
    const key = sodium.crypto_pwhash(
      sodium.crypto_secretbox_KEYBYTES,
      password,
      salt,
      sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
      pwhashAlg()
    );
    const sk = sodium.crypto_secretbox_open_easy(cipher, nonce, key);
    sodium.memzero(key);
    return { secretKeyB64: base64FromUint8(sk) };
  }

  if (msg.op === "deriveKdfKey") {
    const { password, saltB64 } = msg.args;
    const salt = uint8FromBase64(saltB64);
    const key = sodium.crypto_pwhash(
      sodium.crypto_secretbox_KEYBYTES,
      password,
      salt,
      sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
      pwhashAlg()
    );
    const out = base64FromUint8(key);
    sodium.memzero(key);
    return { keyB64: out };
  }

  throw new Error("unknown_op");
}

self.addEventListener("message", async (ev: MessageEvent<Op>) => {
  const msg = ev.data;
  try {
    const result = await handle(msg);
    (self as unknown as Worker).postMessage({ id: msg.id, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    (self as unknown as Worker).postMessage({ id: msg.id, error: message });
  }
});
