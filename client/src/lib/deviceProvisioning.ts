/**
 * Multi-Device-Kopplung: sealed Schlüssel-Transfer Primary → Secondary
 * (GOAL Phase 2). Spiegelt Signals Linked-Device-Provisioning, baut aber nur
 * auf den vorhandenen, auditierten libsodium-Primitiven auf (crypto_box_seal /
 * crypto_box_seal_open, crypto_generichash). KEINE eigene Krypto.
 *
 * ┌──────────────┐  (1) QR/Text: ephemeral PK + pairNonce   ┌────────────┐
 * │  Secondary   │ ─────────────────────────────────────────►│  Primary   │
 * │ (neues Gerät)│                                            │ (hat Ident)│
 * │              │  (2) sealed(provisioning payload)          │            │
 * │              │ ◄──────────────────────────────────────────│            │
 * └──────────────┘                                            └────────────┘
 *
 * 1. Das SECONDARY erzeugt ein EPHEMERES X25519-Keypair (nur für diese
 *    Kopplung) und zeigt seinen Public Key + einen zufälligen `pairNonce`
 *    (32 B) als QR/Text. Der private ephemere Key bleibt auf dem Secondary.
 * 2. Das PRIMARY parst die QR-Payload und VERSIEGELT die Provisioning-Payload
 *    (die `LocalIdentity` des Nutzers — enthält den passwort-`wrapped` Secret
 *    Key, also nie Klartext-Schlüssel — plus den `pairNonce`) an den ephemeren
 *    Public Key des Secondary via `crypto_box_seal`. Nur der Besitzer des
 *    ephemeren Secret Keys (= das Secondary) kann sie öffnen.
 * 3. Das SECONDARY öffnet die versiegelte Payload, prüft den `pairNonce`
 *    (muss exakt der sein, den es selbst erzeugt hat → bindet den Transfer an
 *    diese Kopplungs-Session, verhindert Replay/falscher-QR) und adoptiert die
 *    Identität.
 *
 * Zero-Knowledge: Der Relay (der die versiegelte Payload transportieren würde)
 * sieht NUR den sealed-box-Blob — niemals die Identität oder den ephemeren
 * Secret Key. `crypto_box_seal` ist anonym gegenüber dem Empfänger
 * verschlüsselt; die Authentizität/Frische kommt aus dem vom Nutzer
 * out-of-band verifizierten `pairNonce` (Sicherheitsnummer, s.u.) — exakt das
 * Muster, das auch `sealedSender.ts` nutzt.
 *
 * ⚠️ NUR die Krypto + Unit-Tests sind hier verifiziert. Der vollständige
 * Verhaltenspfad (zwei echte gekoppelte Geräte, Transport der versiegelten
 * Payload über den Relay, Self-Sync der Historie, Geräte-Fan-out beim
 * DM-Versand) braucht ZWEI ECHTE GERÄTE und ist NICHT simulierbar — siehe
 * GOAL.md / ROADMAP_MULTI_DEVICE.md.
 */
import { base64FromUint8, uint8FromBase64 } from "./b64";
import { generateBoxKeypair, publicKeyFromBase64 } from "./crypto";
import type { LocalIdentity } from "./localIdentity";
import { getSodium, sodiumReady } from "./sodium";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Zeitkonstanter Byte-Vergleich (kein early-out). */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Wire-Präfix der QR/Text-Payload, die das Secondary anzeigt. */
const QR_PREFIX = "UMBRA-PAIR1";
/** Header der versiegelten Provisioning-Payload (anti-Verwechslung). */
const PROV_HEADER = "umbra.device.provision.v1";

export type PairingOffer = {
  /** Ephemerer X25519-Public-Key des Secondary (base64). */
  ephemeralPublicKey: string;
  /** Zufälliger 32-B Kopplungs-Nonce (base64) — bindet den Transfer an genau
   *  diese Session und wird vom Nutzer out-of-band (Sicherheitsnummer)
   *  verifiziert. */
  pairNonce: string;
};

/**
 * Vom Secondary gehalten: das Offer (öffentlich, im QR) plus der EPHEMERE
 * SECRET KEY (privat, bleibt auf dem Gerät, NICHT in den QR!).
 */
export type PairingSession = {
  offer: PairingOffer;
  ephemeralSecretKey: Uint8Array;
};

type ProvisioningPayload = {
  h: typeof PROV_HEADER;
  /** Muss exakt dem pairNonce aus dem Offer entsprechen. */
  pairNonce: string;
  identity: LocalIdentity;
};

/** Validiert die dekodierte Provisioning-Payload (Shape-Guard wie in backup.ts). */
function isProvisioningPayload(v: unknown): v is ProvisioningPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.h !== PROV_HEADER) return false;
  if (typeof o.pairNonce !== "string" || o.pairNonce.length === 0) return false;
  const id = o.identity as Record<string, unknown> | undefined;
  if (!id || typeof id !== "object") return false;
  if (typeof id.userId !== "string" || id.userId.length === 0) return false;
  if (typeof id.username !== "string" || id.username.length === 0) return false;
  if (typeof id.publicKey !== "string" || id.publicKey.length === 0) return false;
  const w = id.wrapped as Record<string, unknown> | undefined;
  if (!w || typeof w !== "object") return false;
  return (
    typeof w.salt === "string" &&
    typeof w.nonce === "string" &&
    typeof w.cipher === "string"
  );
}

/**
 * SECONDARY, Schritt 1: erzeugt eine Kopplungs-Session. Der zurückgegebene
 * `offer` wird (via `encodePairingOffer`) als QR/Text angezeigt; der
 * `ephemeralSecretKey` bleibt auf dem Gerät.
 */
export async function createPairingSession(): Promise<PairingSession> {
  await sodiumReady();
  const sodium = getSodium();
  const kp = await generateBoxKeypair();
  const pairNonce = sodium.randombytes_buf(32);
  return {
    offer: {
      ephemeralPublicKey: base64FromUint8(kp.publicKey),
      pairNonce: base64FromUint8(pairNonce),
    },
    ephemeralSecretKey: kp.secretKey,
  };
}

/** Kodiert ein Offer in die QR/Text-Wire-Form `UMBRA-PAIR1:<pk>:<nonce>`. */
export function encodePairingOffer(offer: PairingOffer): string {
  return `${QR_PREFIX}:${offer.ephemeralPublicKey}:${offer.pairNonce}`;
}

/** PRIMARY: parst die vom Secondary angezeigte QR/Text-Form zurück zum Offer. */
export function decodePairingOffer(raw: string): PairingOffer {
  const trimmed = raw.trim();
  const parts = trimmed.split(":");
  if (parts.length !== 3 || parts[0] !== QR_PREFIX) {
    throw new Error("pairing_offer_malformed");
  }
  const [, ephemeralPublicKey, pairNonce] = parts;
  if (!ephemeralPublicKey || !pairNonce) {
    throw new Error("pairing_offer_malformed");
  }
  // Roundtrip-validieren, dass beide Felder echtes base64 sind (sonst späterer
  // Krypto-Fehler mit unklarer Ursache).
  try {
    if (uint8FromBase64(ephemeralPublicKey).length !== 32) {
      throw new Error("pairing_offer_bad_pubkey");
    }
    if (uint8FromBase64(pairNonce).length !== 32) {
      throw new Error("pairing_offer_bad_nonce");
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("pairing_offer_")) throw e;
    throw new Error("pairing_offer_malformed");
  }
  return { ephemeralPublicKey, pairNonce };
}

/**
 * PRIMARY, Schritt 2: versiegelt die Identität an den ephemeren Public Key des
 * Secondary. Der `pairNonce` aus dem Offer wird MIT versiegelt → das Secondary
 * kann prüfen, dass die Payload zu genau seiner Session gehört.
 */
export async function sealProvisioningPayload(
  offer: PairingOffer,
  identity: LocalIdentity
): Promise<string> {
  await sodiumReady();
  const sodium = getSodium();
  const payload: ProvisioningPayload = {
    h: PROV_HEADER,
    pairNonce: offer.pairNonce,
    identity,
  };
  const pk = publicKeyFromBase64(offer.ephemeralPublicKey);
  const plain = enc.encode(JSON.stringify(payload));
  const sealed = sodium.crypto_box_seal(plain, pk);
  sodium.memzero(plain);
  return base64FromUint8(sealed);
}

/**
 * SECONDARY, Schritt 3: öffnet die versiegelte Payload mit dem ephemeren
 * Secret Key, prüft den `pairNonce` gegen die eigene Session und gibt die
 * adoptierte Identität zurück. Wirft bei Manipulation/falschem Empfänger
 * (crypto_box_seal_open) oder bei pairNonce-Mismatch (Replay/falscher Sender).
 */
export async function openProvisioningPayload(
  session: PairingSession,
  sealedB64: string
): Promise<LocalIdentity> {
  await sodiumReady();
  const sodium = getSodium();
  const pk = publicKeyFromBase64(session.offer.ephemeralPublicKey);
  const sealed = uint8FromBase64(sealedB64);
  let plain: Uint8Array;
  try {
    plain = sodium.crypto_box_seal_open(sealed, pk, session.ephemeralSecretKey);
  } catch {
    throw new Error("provisioning_open_failed");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(dec.decode(plain));
  } catch {
    sodium.memzero(plain);
    throw new Error("provisioning_corrupt_json");
  }
  sodium.memzero(plain);
  if (!isProvisioningPayload(decoded)) {
    throw new Error("provisioning_unexpected_shape");
  }
  // Konstantzeit-Vergleich des pairNonce. Der Nonce ist kein Geheimnis (er
  // steht im QR), aber wir vergleichen trotzdem zeitkonstant — sauberer Stil,
  // kein early-out auf Byte-Ebene.
  const expected = uint8FromBase64(session.offer.pairNonce);
  const got = uint8FromBase64(decoded.pairNonce);
  if (!constantTimeEqual(expected, got)) {
    throw new Error("provisioning_nonce_mismatch");
  }
  return decoded.identity;
}

/**
 * Verifizierbare Kopplungs-Sicherheitsnummer: deterministischer Hash über den
 * ephemeren Public Key + den pairNonce. Primary und Secondary zeigen sie an;
 * der Nutzer vergleicht sie out-of-band (wie Signals „Sicherheitsnummer"), um
 * einen MITM beim QR-Transport auszuschließen. 6 Gruppen à 5 Ziffern.
 */
export async function pairingSafetyNumber(offer: PairingOffer): Promise<string> {
  await sodiumReady();
  const sodium = getSodium();
  const pk = uint8FromBase64(offer.ephemeralPublicKey);
  const nonce = uint8FromBase64(offer.pairNonce);
  const input = new Uint8Array(pk.length + nonce.length);
  input.set(pk, 0);
  input.set(nonce, pk.length);
  const h = sodium.crypto_generichash(30, input, enc.encode("umbra-pairing-v1"));
  const digits: string[] = [];
  for (let i = 0; i < h.length; i += 4) {
    const a = h[i] ?? 0;
    const b = h[i + 1] ?? 0;
    const c = h[i + 2] ?? 0;
    const d = h[i + 3] ?? 0;
    const v = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
    digits.push(v.toString(10).slice(0, 5).padStart(5, "0"));
  }
  const flat = digits.join("");
  const groups: string[] = [];
  for (let i = 0; i + 5 <= 30 && i < flat.length; i += 5) {
    groups.push(flat.slice(i, i + 5));
  }
  return groups.join(" ");
}
