/**
 * Promise-API für den Crypto-Worker.
 *
 * Lädt den Worker lazy beim ersten Call (so wird er nicht im Boot-Pfad
 * instanziiert, falls der User nie einloggt). Bei Worker-Failures
 * (kein WASM, CSP-Block, OOM) fallen die Helper transparent auf die
 * Main-Thread-Variante in crypto.ts zurück.
 */
import CryptoWorker from "../workers/crypto.worker.ts?worker";
import { base64FromUint8, uint8FromBase64 } from "./b64";
import {
  wrapSecretKey as wrapMain,
  unwrapSecretKey as unwrapMain,
  type WrappedSecret,
} from "./crypto";

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

let _worker: Worker | null = null;
let _disabled = false;
const _pending = new Map<string, Pending>();

function getWorker(): Worker | null {
  if (_disabled) return null;
  if (_worker) return _worker;
  try {
    _worker = new CryptoWorker();
    _worker.addEventListener("message", (ev: MessageEvent) => {
      const { id, result, error } = ev.data ?? {};
      if (typeof id !== "string") return;
      const p = _pending.get(id);
      if (!p) return;
      _pending.delete(id);
      if (error) p.reject(new Error(String(error)));
      else p.resolve(result);
    });
    _worker.addEventListener("error", () => {
      // Worker fatal — alle pending callers den Fehler werfen lassen,
      // dann Worker abklemmen und auf Main-Thread fallen.
      for (const [, p] of _pending) p.reject(new Error("crypto_worker_crashed"));
      _pending.clear();
      _worker?.terminate();
      _worker = null;
      _disabled = true;
    });
    return _worker;
  } catch {
    _disabled = true;
    return null;
  }
}

/**
 * Max time to wait for a worker reply. Argon2 INTERACTIVE is ~0.6–1.2s on
 * desktop and up to ~3s on slow mobiles; 6s leaves headroom. If the worker
 * never answers (e.g. its WASM init silently stalls), we MUST NOT hang the
 * login forever — we reject, kill the worker, and fall back to the
 * main-thread path (which always works, just briefly blocks the UI).
 */
const WORKER_CALL_TIMEOUT_MS = 6000;

function call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error("crypto_worker_unavailable"));
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!_pending.has(id)) return;
      _pending.delete(id);
      // The worker is unresponsive — disable it so subsequent calls skip
      // straight to the main-thread fallback instead of waiting again.
      try {
        _worker?.terminate();
      } catch {
        /* noop */
      }
      _worker = null;
      _disabled = true;
      reject(new Error("crypto_worker_timeout"));
    }, WORKER_CALL_TIMEOUT_MS);
    _pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v as T);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    w.postMessage({ id, op, args });
  });
}

/**
 * Wrap secret key via worker, mit transparentem Fallback auf Main-Thread.
 */
export async function wrapSecretKey(
  secretKey: Uint8Array,
  password: string
): Promise<WrappedSecret> {
  try {
    const result = await call<WrappedSecret>("wrapSecretKey", {
      secretKeyB64: base64FromUint8(secretKey),
      password,
    });
    return result;
  } catch {
    return wrapMain(secretKey, password);
  }
}

/**
 * Unwrap secret key via worker, mit Fallback.
 */
export async function unwrapSecretKey(
  w: WrappedSecret,
  password: string
): Promise<Uint8Array> {
  try {
    const result = await call<{ secretKeyB64: string }>("unwrapSecretKey", {
      saltB64: w.salt,
      nonceB64: w.nonce,
      cipherB64: w.cipher,
      password,
    });
    return uint8FromBase64(result.secretKeyB64);
  } catch {
    return unwrapMain(w, password);
  }
}

/**
 * Health-check (für Debug/Settings).
 */
export async function pingCryptoWorker(): Promise<boolean> {
  try {
    await call<{ ok: boolean }>("ping");
    return true;
  } catch {
    return false;
  }
}

/**
 * Force shutdown — z.B. beim Lock, damit der Worker den Sodium-Heap
 * vollständig wegwerfen kann.
 */
export function shutdownCryptoWorker(): void {
  if (_worker) {
    try {
      _worker.terminate();
    } catch {
      /* noop */
    }
    _worker = null;
  }
  _pending.clear();
  _disabled = false;
}
