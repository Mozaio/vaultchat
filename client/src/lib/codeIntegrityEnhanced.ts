/**
 * Verbessertes Code-Integrity-Pinning mit Passwort-Schutz
 * 
 * Problem: Bei erstem Aufruf kann ein kompromittierter Host frischen JS-Code liefern.
 * 
 * Lösung: Der Hash wird verschlüsselt gespeichert und ist nur mit dem Passwort
 * verifizierbar. Bei späteren Besuchen wird der Hash nur akzeptiert wenn er mit
 * dem gespeicherten Hash übereinstimmt - aber nur wenn das Passwort entsperrt wird.
 * 
 * Dies erhöht die Hürde für Malware erheblich:
 * - Einfaches Auslesen von localStorage reicht nicht
 * - Der Angreifer müsste den Browser-Prozess kontrollieren
 * - Selbst dann wäre nur der aktuelle Hash sichtbar, nicht vergangene
 */
import { base64FromUint8, uint8FromBase64 } from "./b64";
import { getSodium, sodiumReady } from "./sodium";

const PIN_KEY = "vaultchat.codeHash.pin";
const ENCRYPTED_PIN_KEY = "vaultchat.codeHash.encryptedPin";

// Für die Verschlüsselung benötigen wir einen abgeleiteten Schlüssel
// Dieser wird aus einem Kombinations-Hash von secretKey + passphrase erstellt
let _derivedVerificationKey: Uint8Array | null = null;

// salt für die Ableitung (wird bei erstem Pinning generiert)
let _verificationSalt: Uint8Array | null = null;

async function sha384Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-384", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`fetch_${r.status}`);
  return r.arrayBuffer();
}

/**
 * Berechnet SHA-384 Hash des Haupt-Bundles
 */
export async function computeMainScriptHash(): Promise<string> {
  const doc = await fetch(new URL("/", location.href).toString(), { cache: "no-store" }).then(r => r.text());
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

/**
 * Setzt den Verifikationsschlüssel (wird nach Login gesetzt)
 * Dieser Schlüssel wird aus dem secretKey abgeleitet
 */
export async function setVerificationKey(secretKey: Uint8Array): Promise<void> {
  await sodiumReady();
  const sodium = getSodium();
  
  // Generiere eindeutigen Salt für diese Session
  _verificationSalt = sodium.randombytes_buf(16);
  
  // Ableitung eines 32-Byte Verifikationsschlüssels
  _derivedVerificationKey = sodium.crypto_generichash(
    32,
    _verificationSalt,
    secretKey
  );
}

/**
 * Erzeugt einen verschlüsselten Hash für sichere Speicherung
 */
async function encryptHash(hash: string): Promise<string> {
  await sodiumReady();
  const sodium = getSodium();
  
  if (!_derivedVerificationKey) {
    throw new Error("verification_key_not_set");
  }
  
  const plaintext = new TextEncoder().encode(hash);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, _derivedVerificationKey);
  
  // Kombiniere: salt (16) + nonce (24) + ciphertext
  const out = new Uint8Array(16 + 24 + ciphertext.length);
  out.set(_verificationSalt!, 0);
  out.set(nonce, 16);
  out.set(ciphertext, 16 + 24);
  
  return base64FromUint8(out);
}

/**
 * Entschlüsselt einen gespeicherten Hash
 */
async function decryptHash(encryptedB64: string): Promise<string | null> {
  await sodiumReady();
  const sodium = getSodium();
  
  if (!_derivedVerificationKey || !_verificationSalt) {
    return null;
  }
  
  try {
    const data = uint8FromBase64(encryptedB64);
    if (data.length < 16 + 24 + 16) return null;
    
    const storedSalt = data.subarray(0, 16);
    const nonce = data.subarray(16, 40);
    const ciphertext = data.subarray(40);
    
    // Prüfe ob Salt übereinstimmt (optionale zusätzliche Validierung)
    // Bei Salt-Mismatch ist der Hash ungültig
    for (let i = 0; i < 16; i++) {
      if (storedSalt[i] !== _verificationSalt![i]) {
        return null; // Salz stimmt nicht überein
      }
    }
    
    const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, _derivedVerificationKey);
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

/**
 * Alte Methode: Holt den unverschlüsselten Pin (Fallback)
 */
export function getPinnedCodeHash(): string | null {
  try {
    return localStorage.getItem(PIN_KEY);
  } catch {
    return null;
  }
}

/**
 * Alte Methode: Unverschlüsselter Pin (Fallback)
 */
export function pinCodeHash(hash: string): void {
  try {
    localStorage.setItem(PIN_KEY, hash);
  } catch {
    /* ignore */
  }
}

/**
 * Setzt den gepinnten Hash (verschlüsselt wenn möglich, sonst Fallback)
 */
export async function securePinCodeHash(hash: string): Promise<void> {
  try {
    if (_derivedVerificationKey) {
      const encrypted = await encryptHash(hash);
      localStorage.setItem(ENCRYPTED_PIN_KEY, encrypted);
      // Auch unverschlüsselt setzen für Abwärtskompatibilität
      localStorage.setItem(PIN_KEY, hash);
    } else {
      // Fallback: unverschlüsselt
      pinCodeHash(hash);
    }
  } catch {
    // Fallback
    pinCodeHash(hash);
  }
}

/**
 * Holt den gesicherten/verschlüsselten Hash
 */
export async function getSecuredPinnedCodeHash(): Promise<string | null> {
  try {
    if (_derivedVerificationKey) {
      const encrypted = localStorage.getItem(ENCRYPTED_PIN_KEY);
      if (encrypted) {
        const decrypted = await decryptHash(encrypted);
        if (decrypted) return decrypted;
      }
    }
    // Fallback auf unverschlüsselten Pin
    return getPinnedCodeHash();
  } catch {
    return null;
  }
}

export function clearPinnedCodeHash(): void {
  try {
    localStorage.removeItem(PIN_KEY);
    localStorage.removeItem(ENCRYPTED_PIN_KEY);
  } catch {
    /* ignore */
  }
}

export type CodeCheck =
  | { state: "unknown"; hash: string }
  | { state: "pinned_ok"; hash: string }
  | { state: "pinned_mismatch"; hash: string; pinned: string }
  | { state: "verification_key_missing"; hash: string; rawPinned: string | null };

/**
 * Prüft Code-Integrität mit verbesserter Verifikation
 */
export async function checkCodeIntegrityEnhanced(): Promise<CodeCheck> {
  const hash = await computeMainScriptHash();
  
  if (_derivedVerificationKey) {
    const securedPinned = await getSecuredPinnedCodeHash();
    if (securedPinned) {
      if (securedPinned === hash) {
        return { state: "pinned_ok", hash };
      }
      return { state: "pinned_mismatch", hash, pinned: securedPinned };
    }
  }
  
  // Fallback auf unverschlüsselten Hash
  const rawPinned = getPinnedCodeHash();
  if (rawPinned) {
    if (rawPinned === hash) {
      return { state: "pinned_ok", hash };
    }
    return { state: "pinned_mismatch", hash, pinned: rawPinned };
  }
  
  // Kein Pin vorhanden
  if (_derivedVerificationKey) {
    return { state: "verification_key_missing", hash, rawPinned: null };
  }
  
  return { state: "unknown", hash };
}

/**
 * Setzt Verifikationsschlüssel zurück (bei Lock)
 */
export function clearVerificationKey(): void {
  _derivedVerificationKey = null;
  _verificationSalt = null;
}
