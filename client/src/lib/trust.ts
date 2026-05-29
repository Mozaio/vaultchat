/**
 * TOFU-basiertes Identity-Pinning für Peers.
 *
 *  - Beim ersten Kontakt wird der Public-Key eines Peers lokal gepinnt.
 *  - Sobald ein Peer-Key vom Server abweicht, wird der Pin markiert als
 *    `mismatch`. Solange der Benutzer nicht ausdrücklich neu vertraut oder die
 *    Sicherheitsnummer out-of-band verglichen hat, gilt der Peer als
 *    "unvertrauenswürdig" und die UI warnt.
 *  - Nach erfolgreichem Safety-Number-Vergleich setzt der Benutzer den Pin
 *    auf `verified`.
 *
 *  Alle Pins werden per LDK verschlüsselt in der IndexedDB (meta) abgelegt.
 */
import { metaGet, metaSet } from "./idb";

export type TrustState = "new" | "pinned" | "verified" | "mismatch";

export type PeerPin = {
  publicKey: string;
  state: TrustState;
  firstSeen: number;
  verifiedAt?: number;
  /** Gespeicherter alter Key, falls mismatch entdeckt wurde. */
  previousPublicKey?: string;
};

function keyName(userId: string) {
  return `pin:${userId}`;
}

export async function getPin(userId: string): Promise<PeerPin | null> {
  const raw = await metaGet(keyName(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PeerPin;
  } catch {
    return null;
  }
}

async function putPin(userId: string, pin: PeerPin): Promise<void> {
  await metaSet(keyName(userId), JSON.stringify(pin));
}

/**
 * Aufzurufen, sobald der Server einen Public-Key für userId liefert.
 * Rückgabe beschreibt, welche UI-Konsequenz nötig ist.
 */
export async function observePeerKey(
  userId: string,
  publicKey: string
): Promise<PeerPin> {
  const existing = await getPin(userId);
  if (!existing) {
    const pin: PeerPin = {
      publicKey,
      state: "pinned",
      firstSeen: Date.now(),
    };
    await putPin(userId, pin);
    return pin;
  }
  if (existing.publicKey === publicKey) return existing;
  // Key differs from what we last saw → mismatch. Crucially, anchor
  // `previousPublicKey` to the ORIGINAL trusted key. If we're already in a
  // mismatch state, `existing.previousPublicKey` already holds that original
  // key — do NOT let it drift to the current (possibly attacker-supplied)
  // key on a second swap, or the user could end up comparing safety numbers
  // against the attacker's key instead of the one they originally trusted.
  const originalTrusted =
    existing.state === "mismatch"
      ? existing.previousPublicKey ?? existing.publicKey
      : existing.publicKey;
  const changed: PeerPin = {
    publicKey,
    state: "mismatch",
    firstSeen: existing.firstSeen,
    previousPublicKey: originalTrusted,
  };
  await putPin(userId, changed);
  return changed;
}

export async function confirmPeerVerified(
  userId: string,
  publicKey: string
): Promise<PeerPin> {
  const now = Date.now();
  const pin: PeerPin = {
    publicKey,
    state: "verified",
    firstSeen: (await getPin(userId))?.firstSeen ?? now,
    verifiedAt: now,
  };
  await putPin(userId, pin);
  return pin;
}

export async function acceptKeyChange(
  userId: string,
  publicKey: string
): Promise<PeerPin> {
  const pin: PeerPin = {
    publicKey,
    state: "pinned",
    firstSeen: Date.now(),
  };
  await putPin(userId, pin);
  return pin;
}

export function trustLabel(state: TrustState): string {
  switch (state) {
    case "verified":
      return "Verifiziert";
    case "pinned":
      return "Gepinnt (TOFU)";
    case "mismatch":
      return "⚠ Schlüssel geändert";
    case "new":
      return "Neu";
  }
}
