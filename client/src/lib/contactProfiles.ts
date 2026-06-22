/**
 * Auflösung & Cache der E2E-verschlüsselten Kontakt-Profile (Anzeigename +
 * Avatar) — GOAL Phase 1.
 *
 * Ablauf: ein Kontakt teilt seinen Profile-Key über Olm (profileKeys.ts,
 * `adoptContactProfileKey`). Sein Profil-Blob (`PROFILE1:`) kommt server-opak
 * über `/api/users`. Hier wird beides zusammengeführt: Blob mit dem geteilten
 * Key entschlüsseln → {displayName, avatar}. Ohne Key ODER ohne Blob gibt es
 * KEIN Profil → der Aufrufer fällt auf Username/Initialen zurück.
 *
 * Cache: rein im RAM (zero-knowledge, kein persistenter Klartext). Schlüssel
 * ist `userId` + Blob-Inhalt, damit ein geänderter Blob automatisch neu
 * entschlüsselt wird. `clearProfileCache` beim Lock/Logout aufrufen.
 */
import type { ApiUser } from "./api";
import { decryptProfile, isEncryptedProfile, type ProfileData } from "./profileCrypto";
import { getContactProfileKey } from "./profileKeys";

type CacheEntry = { cipher: string; profile: ProfileData | null };
const cache = new Map<string, CacheEntry>();

/** Leert den Profil-Cache (beim Sperren/Abmelden). */
export function clearProfileCache(): void {
  cache.clear();
}

/** Invalidiert den Cache-Eintrag eines Kontakts (z.B. nach Key-Übernahme). */
export function invalidateContactProfile(userId: string): void {
  cache.delete(userId);
}

/**
 * Entschlüsselt das Profil eines Kontakts (oder null, wenn kein Key/kein Blob
 * vorliegt bzw. die Entschlüsselung fehlschlägt — z.B. rotierter Key). Nutzt
 * den RAM-Cache; bei geändertem Blob wird neu entschlüsselt. Wirft NIE.
 */
export async function resolveContactProfile(
  user: Pick<ApiUser, "id" | "profileCipher">
): Promise<ProfileData | null> {
  const cipher = user.profileCipher;
  if (!cipher || !isEncryptedProfile(cipher)) {
    // Kein (gültiger) Blob → kein Profil. Stale Cache-Eintrag verwerfen.
    cache.delete(user.id);
    return null;
  }
  const cached = cache.get(user.id);
  if (cached && cached.cipher === cipher) return cached.profile;

  const key = await getContactProfileKey(user.id).catch(() => null);
  if (!key) {
    // Blob da, aber (noch) kein geteilter Key — nicht cachen, damit es nach
    // Key-Ankunft erneut versucht wird.
    return null;
  }
  const profile = await decryptProfile(cipher, key.keyB64).catch(() => null);
  cache.set(user.id, { cipher, profile });
  return profile;
}

/**
 * Bequemer Anzeigename: das entschlüsselte `displayName` (falls vorhanden und
 * nicht leer), sonst der `fallback` (typischerweise der Username).
 */
export function profileDisplayName(
  profile: ProfileData | null,
  fallback: string
): string {
  const name = profile?.displayName?.trim();
  return name && name.length > 0 ? name : fallback;
}
