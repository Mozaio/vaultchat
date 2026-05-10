import {
  loadPersistedPreKeyBundles,
  persistPreKeyBundles,
  type PersistedPreKeyBundle,
} from "./serverState.js";

type PreKeyBundle = {
  userId: string;
  identityKey: string;
  signedPreKey: {
    keyId: number;
    publicKey: string;
    signature: string;
    signingPublicKey?: string;
  };
  oneTimePreKeys: Map<number, string>;
  pqKem?: {
    alg: "ML-KEM-1024";
    publicKey: string;
  };
  /**
   * Optionale Olm-Schicht (Matrix.org-DR-Implementation, NCC-Group 2016/2020
   * + Quarkslab 2024 auditiert). Wenn vorhanden, kann der Sender den
   * VCO5-Wire-Pfad statt unseres eigenen DR v4 wählen.
   */
  olm?: {
    identityCurve25519: string;
    identityEd25519: string;
    /** Map<otkId, publicKey> — verbraucht analog zu oneTimePreKeys. */
    oneTimeKeys: Map<string, string>;
  };
  nextKeyId: number;
};

function hydrateBundle(bundle: PersistedPreKeyBundle): PreKeyBundle {
  return {
    ...bundle,
    oneTimePreKeys: new Map(
      bundle.oneTimePreKeys.map((key) => [key.keyId, key.publicKey])
    ),
    ...(bundle.olm
      ? {
          olm: {
            identityCurve25519: bundle.olm.identityCurve25519,
            identityEd25519: bundle.olm.identityEd25519,
            oneTimeKeys: new Map(
              bundle.olm.oneTimeKeys.map((k) => [k.keyId, k.publicKey])
            ),
          },
        }
      : {}),
  };
}

function serializeBundle(bundle: PreKeyBundle): PersistedPreKeyBundle {
  return {
    ...bundle,
    oneTimePreKeys: [...bundle.oneTimePreKeys].map(([keyId, publicKey]) => ({
      keyId,
      publicKey,
    })),
    ...(bundle.olm
      ? {
          olm: {
            identityCurve25519: bundle.olm.identityCurve25519,
            identityEd25519: bundle.olm.identityEd25519,
            oneTimeKeys: [...bundle.olm.oneTimeKeys].map(([keyId, publicKey]) => ({
              keyId,
              publicKey,
            })),
          },
        }
      : {}),
  };
}

const bundles = new Map<string, PreKeyBundle>(
  loadPersistedPreKeyBundles().map((bundle) => [
    bundle.userId,
    hydrateBundle(bundle),
  ])
);

function persistBundles() {
  persistPreKeyBundles([...bundles.values()].map(serializeBundle));
}

export function initPreKeyBundle(
  userId: string,
  identityKey: string,
  signedPreKeyPublic: string,
  signedPreKeySignature: string,
  signingPublicKey?: string,
  signedPreKeyId = 1,
  pqKem?: { alg: "ML-KEM-1024"; publicKey: string }
): void {
  bundles.set(userId, {
    userId,
    identityKey,
    signedPreKey: {
      keyId: signedPreKeyId,
      publicKey: signedPreKeyPublic,
      signature: signedPreKeySignature,
      ...(signingPublicKey ? { signingPublicKey } : {}),
    },
    oneTimePreKeys: new Map(),
    ...(pqKem ? { pqKem } : {}),
    nextKeyId: 1,
  });
  persistBundles();
}

export function uploadOneTimePreKeys(
  userId: string,
  keys: { keyId: number; publicKey: string }[]
): void {
  const b = bundles.get(userId);
  if (b) {
    for (const k of keys) b.oneTimePreKeys.set(k.keyId, k.publicKey);
    persistBundles();
  }
}

export function getPreKeyBundle(userId: string): {
  identityKey: string;
  signedPreKey: {
    keyId: number;
    publicKey: string;
    signature: string;
    signingPublicKey?: string;
  };
  remainingPreKeys: number;
  oneTimePreKey: { keyId: number; publicKey: string } | null;
  pqKem?: {
    alg: "ML-KEM-1024";
    publicKey: string;
  };
  olm?: {
    identityCurve25519: string;
    identityEd25519: string;
    oneTimeKey: { keyId: string; publicKey: string } | null;
    remainingOneTimeKeys: number;
  };
} | null {
  const b = bundles.get(userId);
  if (!b) return null;
  let otp: { keyId: number; publicKey: string } | null = null;
  for (const [keyId, publicKey] of b.oneTimePreKeys) {
    otp = { keyId, publicKey };
    b.oneTimePreKeys.delete(keyId);
    persistBundles();
    break;
  }
  // Olm-OTK separat verbrauchen — gleicher Pattern, eigene Map.
  let olmOut: {
    identityCurve25519: string;
    identityEd25519: string;
    oneTimeKey: { keyId: string; publicKey: string } | null;
    remainingOneTimeKeys: number;
  } | undefined;
  if (b.olm) {
    let olmOtk: { keyId: string; publicKey: string } | null = null;
    for (const [keyId, publicKey] of b.olm.oneTimeKeys) {
      olmOtk = { keyId, publicKey };
      b.olm.oneTimeKeys.delete(keyId);
      persistBundles();
      break;
    }
    olmOut = {
      identityCurve25519: b.olm.identityCurve25519,
      identityEd25519: b.olm.identityEd25519,
      oneTimeKey: olmOtk,
      remainingOneTimeKeys: b.olm.oneTimeKeys.size,
    };
  }
  return {
    identityKey: b.identityKey,
    signedPreKey: b.signedPreKey,
    remainingPreKeys: b.oneTimePreKeys.size,
    oneTimePreKey: otp,
    ...(b.pqKem ? { pqKem: b.pqKem } : {}),
    ...(olmOut ? { olm: olmOut } : {}),
  };
}

/**
 * Olm-Schlüssel im Bundle aktualisieren — Identity (einmalig) und/oder
 * one-time keys (regelmäßig nachfüllen). Olm-OTKs sind unabhängig von
 * den Curve25519-OTKs aus dem X3DH-Pfad.
 */
export function uploadOlmKeys(
  userId: string,
  data: {
    identityCurve25519?: string;
    identityEd25519?: string;
    oneTimeKeys?: { keyId: string; publicKey: string }[];
  }
): void {
  const b = bundles.get(userId);
  if (!b) return;
  if (data.identityCurve25519 && data.identityEd25519) {
    b.olm = {
      identityCurve25519: data.identityCurve25519,
      identityEd25519: data.identityEd25519,
      oneTimeKeys: b.olm?.oneTimeKeys ?? new Map(),
    };
  }
  if (data.oneTimeKeys && b.olm) {
    for (const k of data.oneTimeKeys) {
      b.olm.oneTimeKeys.set(k.keyId, k.publicKey);
    }
  }
  persistBundles();
}

export function getRemainingPreKeyCount(userId: string): number {
  return bundles.get(userId)?.oneTimePreKeys.size ?? 0;
}

export function getPreKeyStats() {
  let oneTimePreKeys = 0;
  for (const bundle of bundles.values()) {
    oneTimePreKeys += bundle.oneTimePreKeys.size;
  }
  return {
    bundles: bundles.size,
    oneTimePreKeys,
  };
}
