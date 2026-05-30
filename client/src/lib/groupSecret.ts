/**
 * Group Master Key (GMK) — auditiertes Krypto-Fundament für E2EE-Gruppen-
 * Metadaten (Phase 1) UND Basis für eine spätere zkgroup-Schicht.
 *
 * Design
 * ======
 *  - Pro Gruppe gibt es EIN geteiltes 32-Byte-Geheimnis (GMK). Es wird vom
 *    Ersteller erzeugt, über den bereits auditierten Olm-1:1-Kanal an alle
 *    Mitglieder verteilt (wie der Megolm-Session-Key) und bei
 *    Mitgliedschaftswechseln rotiert (neue `epoch`).
 *  - Symmetrische Krypto: AUSSCHLIESSLICH libsodium `crypto_secretbox`
 *    (XSalsa20-Poly1305) — dieselbe auditierte Primitive wie in localKey.ts.
 *    KEIN Eigenbau.
 *  - At-rest: der GMK wird über `metaSet` gespeichert (pro Account gescoped +
 *    mit dem Local-Key verschlüsselt).
 *
 * Warum das auch das zkgroup-Fundament ist
 * ========================================
 *  Signals "Private Group System" leitet seine Gruppen-Parameter (group public
 *  params, member-ciphertexts) aus einem **Group Master Key** ab. Ein sauber
 *  verteilter/rotierter GMK ist also genau die Schicht, auf der eine spätere,
 *  REVIEW-pflichtige zkgroup-Implementierung aufsetzt — ohne dass dieses
 *  Fundament neu gebaut werden muss. Worst Case (kein zkgroup): der GMK
 *  verschlüsselt bereits Name/Avatar (Phase 1) und funktioniert eigenständig.
 *
 * Status: Fundament. Wird in einem nächsten, getesteten Schritt in den
 * Group-Create/Update-Fluss + die Olm-Verteilung verdrahtet.
 */
import { getSodium, sodiumReady } from "./sodium";
import { metaGet, metaSet } from "./idb";
import { base64FromUint8, uint8FromBase64 } from "./b64";

/** Wire-Prefix für verschlüsselte Gruppen-Metadaten (Name/Avatar). */
const GMETA_PREFIX = "GMETA1";

export type GroupSecret = { keyB64: string; epoch: number };

function gsKey(groupId: string): string {
  return `groupSecret:${groupId}`;
}

/** Liest das gespeicherte Gruppen-Geheimnis (oder null). */
export async function getGroupSecret(
  groupId: string
): Promise<GroupSecret | null> {
  const raw = await metaGet(gsKey(groupId)).catch(() => null);
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

async function store(groupId: string, gs: GroupSecret): Promise<void> {
  await metaSet(gsKey(groupId), JSON.stringify(gs));
}

/**
 * Übernimmt einen empfangenen GMK (aus der Olm-1:1-Verteilung). Ein höherer
 * `epoch` gewinnt; ein älterer wird ignoriert, damit eine verspätete
 * Re-Verteilung den frischeren Schlüssel nicht überschreibt.
 */
export async function adoptGroupSecret(
  groupId: string,
  keyB64: string,
  epoch: number
): Promise<void> {
  if (!keyB64) return;
  const existing = await getGroupSecret(groupId);
  if (existing && existing.epoch > epoch) return;
  await store(groupId, { keyB64, epoch });
}

/** Holt das GMK oder erzeugt eines (Ersteller-Pfad), epoch=1. */
export async function ensureGroupSecret(groupId: string): Promise<GroupSecret> {
  const existing = await getGroupSecret(groupId);
  if (existing) return existing;
  await sodiumReady();
  const sodium = getSodium();
  const key = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const gs: GroupSecret = { keyB64: base64FromUint8(key), epoch: 1 };
  await store(groupId, gs);
  return gs;
}

/**
 * Rotiert den GMK (neue Epoche) — bei Mitgliedschaftswechsel. Der Caller
 * verteilt das Ergebnis an die aktuellen Mitglieder und re-verschlüsselt
 * Name/Avatar mit der neuen Epoche.
 */
export async function rotateGroupSecret(
  groupId: string
): Promise<GroupSecret> {
  await sodiumReady();
  const sodium = getSodium();
  const prev = await getGroupSecret(groupId);
  const key = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const gs: GroupSecret = {
    keyB64: base64FromUint8(key),
    epoch: (prev?.epoch ?? 0) + 1,
  };
  await store(groupId, gs);
  return gs;
}

/** Entfernt das GMK lokal (z.B. beim Verlassen der Gruppe). */
export async function deleteGroupSecret(groupId: string): Promise<void> {
  // metaSet auf leeren Marker — ein dedizierter Delete-Pfad existiert in idb
  // nicht; ein leerer Wert wird von getGroupSecret als "kein Key" behandelt.
  await metaSet(gsKey(groupId), "").catch(() => {});
}

/**
 * Verschlüsselt Gruppen-Metadaten (Name/Avatar) mit dem aktuellen GMK.
 * Wire-Format: `GMETA1:{epoch}:{base64(nonce||ciphertext)}`.
 * Gibt null zurück, wenn (noch) kein GMK vorliegt — der Caller fällt dann auf
 * Klartext/Platzhalter zurück.
 */
export async function encryptGroupMeta(
  groupId: string,
  plaintext: string
): Promise<string | null> {
  const gs = await getGroupSecret(groupId);
  if (!gs) return null;
  await sodiumReady();
  const sodium = getSodium();
  const key = uint8FromBase64(gs.keyB64);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ct = sodium.crypto_secretbox_easy(
    new TextEncoder().encode(plaintext),
    nonce,
    key
  );
  const blob = new Uint8Array(nonce.length + ct.length);
  blob.set(nonce, 0);
  blob.set(ct, nonce.length);
  return `${GMETA_PREFIX}:${gs.epoch}:${base64FromUint8(blob)}`;
}

/** Erkennt ein verschlüsseltes Metadaten-Feld (vs. Legacy-Klartext). */
export function isEncryptedGroupMeta(value: string | undefined | null): boolean {
  return typeof value === "string" && value.startsWith(`${GMETA_PREFIX}:`);
}

/**
 * Entschlüsselt ein `GMETA1:`-Feld mit dem GMK der passenden Epoche.
 * Gibt null zurück, wenn kein/falsches GMK vorliegt (z.B. Epoche rotiert,
 * neues Mitglied ohne alten Key) — der Caller zeigt dann einen Platzhalter.
 */
export async function decryptGroupMeta(
  groupId: string,
  wire: string
): Promise<string | null> {
  if (!isEncryptedGroupMeta(wire)) return null;
  const sep1 = wire.indexOf(":");
  const sep2 = wire.indexOf(":", sep1 + 1);
  if (sep2 < 0) return null;
  const epoch = Number(wire.slice(sep1 + 1, sep2)) || 0;
  const b64 = wire.slice(sep2 + 1);
  const gs = await getGroupSecret(groupId);
  if (!gs || gs.epoch !== epoch) return null;
  try {
    await sodiumReady();
    const sodium = getSodium();
    const key = uint8FromBase64(gs.keyB64);
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
