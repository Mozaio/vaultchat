/**
 * Community Master Key (Community-GMK) — Krypto-Fundament für Communities/
 * Spaces (GOAL Phase 3, „Spaces/Server mit mehreren Kanälen", Teilstück C1 aus
 * `COMMUNITIES_SPEC.md`).
 *
 * Was das ist
 * ===========
 *  Eine Community ist ein Discord-artiger Container mit mehreren Kanälen. Jeder
 *  KANAL ist kryptografisch eine eigene Gruppe (eigener GMK + Megolm + Rotation,
 *  siehe `groupSecret.ts`) — das wird NICHT hier dupliziert. Dieses Modul deckt
 *  nur die zusätzliche **Community-Ebene** ab: ein separater 32-Byte-Schlüssel
 *  pro Community, der ausschließlich die **Community-Metadaten** (Name/Avatar)
 *  und die **Kanal-Namen** verschlüsselt — NICHT den Nachrichteninhalt der
 *  Kanäle.
 *
 *  Damit kann ein Mitglied die Kanal-Liste lesbar darstellen, ohne jeden Kanal
 *  zwangsläufig entschlüsseln zu können (Vorbereitung für private `subset`-
 *  Kanäle, die einen eigenen Kanal-GMK an eine Teilmenge verteilen).
 *
 * KEINE eigene Krypto
 * ===================
 *  Dieses Modul ist eine 1:1-Spiegelung von `groupSecret.ts` mit eigenem
 *  IDB-Scope (`communitySecret:<id>`) und eigenem Wire-Präfix (`CMETA1`).
 *  Symmetrische Krypto ausschließlich libsodium `crypto_secretbox`
 *  (XSalsa20-Poly1305) — dieselbe auditierte Primitive wie GMK/Profil/Local-Key.
 *
 * Status: **dormant** (C1). Noch kein Caller → tree-shaken, kein Live-Effekt.
 * Wird in C2/C3 (`COMMUNITIES_SPEC.md`) in den Community-Create/Update-Fluss +
 * die Olm-Verteilung verdrahtet. Vorab voll unit-getestet.
 */
import { getSodium, sodiumReady } from "./sodium";
import { metaGet, metaSet } from "./idb";
import { base64FromUint8, uint8FromBase64 } from "./b64";

/** Wire-Präfix für verschlüsselte Community-/Kanal-Metadaten. */
const CMETA_PREFIX = "CMETA1";

export type CommunitySecret = { keyB64: string; epoch: number };

function csKey(communityId: string): string {
  return `communitySecret:${communityId}`;
}

/** Liest das gespeicherte Community-Geheimnis (oder null). */
export async function getCommunitySecret(
  communityId: string
): Promise<CommunitySecret | null> {
  const raw = await metaGet(csKey(communityId)).catch(() => null);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { keyB64?: unknown; epoch?: unknown };
    if (typeof p.keyB64 === "string" && p.keyB64) {
      return { keyB64: p.keyB64, epoch: Number(p.epoch) || 0 };
    }
  } catch {
    /* defekt */
  }
  return null;
}

async function store(communityId: string, cs: CommunitySecret): Promise<void> {
  await metaSet(csKey(communityId), JSON.stringify(cs));
}

/**
 * Übernimmt einen empfangenen Community-GMK (aus der Olm-1:1-Verteilung). Eine
 * höhere `epoch` gewinnt; eine ältere wird ignoriert, damit eine verspätete
 * Re-Verteilung den frischeren Schlüssel nicht überschreibt.
 */
export async function adoptCommunitySecret(
  communityId: string,
  keyB64: string,
  epoch: number
): Promise<void> {
  if (!keyB64) return;
  const existing = await getCommunitySecret(communityId);
  if (existing && existing.epoch > epoch) return;
  await store(communityId, { keyB64, epoch });
}

/** Holt das Community-GMK oder erzeugt eines (Ersteller-Pfad), epoch=1. */
export async function ensureCommunitySecret(
  communityId: string
): Promise<CommunitySecret> {
  const existing = await getCommunitySecret(communityId);
  if (existing) return existing;
  await sodiumReady();
  const sodium = getSodium();
  const key = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const cs: CommunitySecret = { keyB64: base64FromUint8(key), epoch: 1 };
  await store(communityId, cs);
  return cs;
}

/**
 * Rotiert den Community-GMK (neue Epoche) — bei Mitgliedschaftswechsel auf
 * Community-Ebene. Der Caller verteilt das Ergebnis an die aktuellen Mitglieder
 * und re-verschlüsselt Meta/Kanal-Namen mit der neuen Epoche.
 */
export async function rotateCommunitySecret(
  communityId: string
): Promise<CommunitySecret> {
  await sodiumReady();
  const sodium = getSodium();
  const prev = await getCommunitySecret(communityId);
  const key = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const cs: CommunitySecret = {
    keyB64: base64FromUint8(key),
    epoch: (prev?.epoch ?? 0) + 1,
  };
  await store(communityId, cs);
  return cs;
}

/** Entfernt das Community-GMK lokal (z.B. beim Verlassen der Community). */
export async function deleteCommunitySecret(communityId: string): Promise<void> {
  await metaSet(csKey(communityId), "").catch(() => {});
}

/**
 * Verschlüsselt Community-/Kanal-Metadaten (Name/Avatar/Kanal-Name) mit dem
 * aktuellen Community-GMK. Wire-Format: `CMETA1:{epoch}:{base64(nonce||ct)}`.
 * Gibt null zurück, wenn (noch) kein GMK vorliegt — der Caller fällt dann auf
 * Platzhalter zurück (server-opak).
 */
export async function encryptCommunityMeta(
  communityId: string,
  plaintext: string
): Promise<string | null> {
  const cs = await getCommunitySecret(communityId);
  if (!cs) return null;
  await sodiumReady();
  const sodium = getSodium();
  const key = uint8FromBase64(cs.keyB64);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ct = sodium.crypto_secretbox_easy(
    new TextEncoder().encode(plaintext),
    nonce,
    key
  );
  const blob = new Uint8Array(nonce.length + ct.length);
  blob.set(nonce, 0);
  blob.set(ct, nonce.length);
  return `${CMETA_PREFIX}:${cs.epoch}:${base64FromUint8(blob)}`;
}

/** Erkennt ein verschlüsseltes Community-Metadaten-Feld (vs. Legacy/Platzhalter). */
export function isEncryptedCommunityMeta(
  value: string | undefined | null
): boolean {
  return typeof value === "string" && value.startsWith(`${CMETA_PREFIX}:`);
}

/**
 * Entschlüsselt ein `CMETA1:`-Feld mit dem Community-GMK der passenden Epoche.
 * Gibt null zurück, wenn kein/falsches GMK vorliegt (z.B. Epoche rotiert) —
 * der Caller zeigt dann einen Platzhalter.
 */
export async function decryptCommunityMeta(
  communityId: string,
  wire: string
): Promise<string | null> {
  if (!isEncryptedCommunityMeta(wire)) return null;
  const sep1 = wire.indexOf(":");
  const sep2 = wire.indexOf(":", sep1 + 1);
  if (sep2 < 0) return null;
  const epoch = Number(wire.slice(sep1 + 1, sep2)) || 0;
  const b64 = wire.slice(sep2 + 1);
  const cs = await getCommunitySecret(communityId);
  if (!cs || cs.epoch !== epoch) return null;
  try {
    await sodiumReady();
    const sodium = getSodium();
    const key = uint8FromBase64(cs.keyB64);
    const blob = uint8FromBase64(b64);
    const nlen = sodium.crypto_secretbox_NONCEBYTES;
    const nonce = blob.subarray(0, nlen);
    const ct = blob.subarray(nlen);
    const pt = sodium.crypto_secretbox_open_easy(ct, nonce, key);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
