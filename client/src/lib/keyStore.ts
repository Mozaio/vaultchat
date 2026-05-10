/**
 * Phase 5: VaultChat hat den selbstgeschriebenen X3DH+DR-Pfad weggeworfen
 * und nutzt ausschließlich Olm/Megolm. Dieser Modul-Footprint ist deshalb
 * minimal — nur `buildUploadBodyWithOlm` produziert den Bundle-Upload,
 * dessen `olm`-Feld der einzige Krypto-Slot ist, den der Server seit
 * Phase 5 verlangt.
 *
 * Der frühere `LocalKeyMaterial`-Speicher (signedPreKey, oneTimePreKeys,
 * pqKem) ist entfernt; das Olm-Material lebt komplett im Olm-Account-
 * Pickle (siehe lib/olmSessionStore.ts).
 */

import { getOlmPublishBundle } from "./olmSessionStore";

export type UploadBody = {
  olm: {
    identityCurve25519: string;
    identityEd25519: string;
    oneTimeKeys: { keyId: string; publicKey: string }[];
  };
};

/**
 * Generiert den Olm-Bundle-Slot (Identity + 50 frische One-Time-Keys aus
 * dem persistierten Olm-Account) und gibt das Upload-Body zurück, das
 * an `/api/keys` gepostet werden soll.
 *
 * Identity-Keys bleiben über Aufrufe stabil (ensureOlmAccount läd aus IDB).
 * One-Time-Keys werden frisch generiert und auf dem Olm-Account als
 * "published" markiert — eine erneut hochgeladene Liste enthält also nur
 * NEUE Keys, alte sind bereits beim Empfänger.
 */
export async function buildUploadBodyWithOlm(): Promise<UploadBody> {
  const olm = await getOlmPublishBundle(50);
  return {
    olm: {
      identityCurve25519: olm.identityCurve25519,
      identityEd25519: olm.identityEd25519,
      oneTimeKeys: Object.entries(olm.oneTimeKeys).map(
        ([keyId, publicKey]) => ({ keyId, publicKey })
      ),
    },
  };
}
