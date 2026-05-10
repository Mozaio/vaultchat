/**
 * Ableitung eines lokalen Datenschlüssels (Local Data Key, LDK) aus dem
 * entsperrten X25519-Secret. Dieser LDK wird verwendet, um IndexedDB-Records
 * verschlüsselt abzulegen (at rest) — z.B. Chat-Historie, Double-Ratchet-State.
 *
 * Vorteil: Memory-Dumps der IDB (Browser-Profile, Forensik) enthalten nur
 * Ciphertext. Die Entschlüsselung ist erst nach Entsperren (Passwort → SK) möglich.
 */
import { getSodium, sodiumReady } from "./sodium";

const enc = new TextEncoder();

let _key: Uint8Array | null = null;

export async function setLocalKeyFromSecret(secretKey: Uint8Array) {
  await sodiumReady();
  const sodium = getSodium();
  _key = sodium.crypto_generichash(
    32,
    enc.encode("vaultchat-local-idb-v1"),
    secretKey
  );
}

export function clearLocalKey() {
  if (_key) {
    const sodium = getSodium();
    try {
      sodium.memzero(_key);
    } catch {
      /* ignore */
    }
  }
  _key = null;
}

export function hasLocalKey(): boolean {
  return _key !== null;
}

export async function localEncrypt(plaintext: Uint8Array): Promise<Uint8Array> {
  await sodiumReady();
  const sodium = getSodium();
  if (!_key) throw new Error("local_key_missing");
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ct = sodium.crypto_secretbox_easy(plaintext, nonce, _key);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return out;
}

export async function localDecrypt(blob: Uint8Array): Promise<Uint8Array> {
  await sodiumReady();
  const sodium = getSodium();
  if (!_key) throw new Error("local_key_missing");
  const nonceLen = sodium.crypto_secretbox_NONCEBYTES;
  const nonce = blob.subarray(0, nonceLen);
  const ct = blob.subarray(nonceLen);
  return sodium.crypto_secretbox_open_easy(ct, nonce, _key);
}

export async function encryptString(s: string): Promise<Uint8Array> {
  return localEncrypt(enc.encode(s));
}

export async function decryptToString(blob: Uint8Array): Promise<string> {
  const bytes = await localDecrypt(blob);
  return new TextDecoder().decode(bytes);
}

/**
 * Leitet einen sekundären Schlüssel mit Domain-Separation aus dem
 * Local Data Key ab. Anwendung: Olm pickleKey (DR-Sessions in IDB),
 * ähnliche "ich brauche einen stabilen Key, der nicht der LDK selbst
 * ist, aber an dieselbe Unlock-Session gebunden ist".
 *
 * Returns base64. Caller darf NICHT memzero'n — die Funktion löscht
 * den Zwischen-Buffer selbst und gibt nur den base64-String zurück.
 */
export async function deriveSubKey(domainLabel: string): Promise<string> {
  await sodiumReady();
  const sodium = getSodium();
  if (!_key) throw new Error("local_key_missing");
  const sub = sodium.crypto_generichash(32, enc.encode(domainLabel), _key);
  // base64-Konvertierung; die Bytes-Form bleibt nur temporär hier.
  let s = "";
  for (let i = 0; i < sub.length; i++) s += String.fromCharCode(sub[i]!);
  sodium.memzero(sub);
  return btoa(s);
}
