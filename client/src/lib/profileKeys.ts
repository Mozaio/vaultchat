/**
 * Profile-Key-Verwaltung & -Verteilung — GOAL Phase 1
 * „Kontakte & Profile: Anzeigename + Avatar, E2E-verschlüsselt geteilt".
 *
 * Design (spiegelt das auditierte GMK-Muster in groupSecret.ts / #25, damit
 * KEINE neue Krypto erfunden wird):
 *  - Jeder Nutzer hat EINEN eigenen 32-Byte-Profile-Key (wie ein Signal
 *    "profile key"). Das Profil {displayName, avatar} wird damit clientseitig
 *    via libsodium `crypto_secretbox` verschlüsselt (siehe profileCrypto.ts)
 *    und als `PROFILE1:`-Blob auf dem Server abgelegt — server-opak.
 *  - Der Profile-Key selbst wird NUR über den bereits auditierten Olm-1:1-Kanal
 *    an Kontakte verteilt (analog zur Megolm-Session-Key-/GMK-Verteilung), NIE
 *    an den Server.
 *  - At-rest: alle Keys liegen über `metaGet`/`metaSet` (pro Account gescoped +
 *    mit dem Local-Key verschlüsselt), exakt wie der GMK in groupSecret.ts.
 *  - Rotation: ein höherer `epoch` gewinnt. Beim Setzen eines neuen eigenen
 *    Profils kann der Key rotiert und an alle Kontakte re-verteilt werden
 *    (Forward-Privacy für das Profil: ein Ex-Kontakt mit altem Key kann ein
 *    neu verschlüsseltes Profil nicht mehr lesen).
 *
 * Wire (auf dem Olm-Frame, NICHT auf dem Server): `profileKey` (base64) +
 * `profileKeyEpoch` (number) — siehe PlainPayload in crypto.ts.
 */
import { getSodium, sodiumReady } from "./sodium";
import { metaGet, metaSet } from "./idb";
import { base64FromUint8 } from "./b64";

/** IDB-Meta-Key für den EIGENEN Profile-Key. */
const OWN_KEY = "profileKey:self";
/** IDB-Meta-Key-Präfix für die Profile-Keys von Kontakten (je userId). */
function contactKey(userId: string): string {
  return `profileKey:contact:${userId}`;
}

export type ProfileKey = { keyB64: string; epoch: number };

function parseProfileKey(raw: string | null): ProfileKey | null {
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

/** Liest den eigenen Profile-Key (oder null, falls noch keiner erzeugt wurde). */
export async function getOwnProfileKey(): Promise<ProfileKey | null> {
  const raw = await metaGet(OWN_KEY).catch(() => null);
  return parseProfileKey(raw);
}

/**
 * Holt den eigenen Profile-Key oder erzeugt einen (epoch=1). Idempotent — beim
 * ersten Profil-Setzen aufgerufen.
 */
export async function ensureOwnProfileKey(): Promise<ProfileKey> {
  const existing = await getOwnProfileKey();
  if (existing) return existing;
  await sodiumReady();
  const sodium = getSodium();
  const key = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const pk: ProfileKey = { keyB64: base64FromUint8(key), epoch: 1 };
  await metaSet(OWN_KEY, JSON.stringify(pk));
  return pk;
}

/**
 * Rotiert den eigenen Profile-Key (neue Epoche). Der Caller verschlüsselt das
 * Profil mit dem neuen Key neu, lädt es per PUT /api/profile hoch und re-
 * verteilt den Key an alle aktuellen Kontakte.
 */
export async function rotateOwnProfileKey(): Promise<ProfileKey> {
  await sodiumReady();
  const sodium = getSodium();
  const prev = await getOwnProfileKey();
  const key = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const pk: ProfileKey = {
    keyB64: base64FromUint8(key),
    epoch: (prev?.epoch ?? 0) + 1,
  };
  await metaSet(OWN_KEY, JSON.stringify(pk));
  return pk;
}

/** Liest den (von einem Kontakt geteilten) Profile-Key zu einer userId. */
export async function getContactProfileKey(
  userId: string
): Promise<ProfileKey | null> {
  if (!userId) return null;
  const raw = await metaGet(contactKey(userId)).catch(() => null);
  return parseProfileKey(raw);
}

/**
 * Übernimmt einen über Olm empfangenen Profile-Key eines Kontakts. Ein höherer
 * `epoch` gewinnt; ein älterer (verspätete Re-Verteilung) wird ignoriert, damit
 * ein frischer rotierter Key nicht überschrieben wird. Gibt true zurück, wenn
 * ein neuer Key gespeichert wurde (dann sollte der Caller die Profil-Anzeige
 * neu rendern).
 */
export async function adoptContactProfileKey(
  userId: string,
  keyB64: string,
  epoch: number
): Promise<boolean> {
  if (!userId || !keyB64) return false;
  const existing = await getContactProfileKey(userId);
  if (existing && existing.epoch >= epoch) return false;
  await metaSet(
    contactKey(userId),
    JSON.stringify({ keyB64, epoch: Number(epoch) || 0 })
  );
  return true;
}

/** Entfernt den Profile-Key eines Kontakts lokal (z.B. beim Blockieren). */
export async function deleteContactProfileKey(userId: string): Promise<void> {
  if (!userId) return;
  // idb hat keinen dedizierten Delete-Pfad; ein leerer Wert wird von
  // getContactProfileKey als „kein Key" behandelt (wie deleteGroupSecret).
  await metaSet(contactKey(userId), "").catch(() => {});
}
