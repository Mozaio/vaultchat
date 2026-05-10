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
  // `olm` muss vom Spread ausgeschlossen werden, weil das persisted Shape
  // (Array) sich strukturell von der In-Memory-Form (Map) unterscheidet —
  // sonst sieht TS das ...spread "olm" UND das explizit gesetzte als zwei
  // mögliche Typen.
  const { olm, oneTimePreKeys, ...rest } = bundle;
  const hydrated: PreKeyBundle = {
    ...rest,
    oneTimePreKeys: new Map(
      oneTimePreKeys.map((key) => [key.keyId, key.publicKey])
    ),
  };
  if (olm) {
    hydrated.olm = {
      identityCurve25519: olm.identityCurve25519,
      identityEd25519: olm.identityEd25519,
      oneTimeKeys: new Map(olm.oneTimeKeys.map((k) => [k.keyId, k.publicKey])),
    };
  }
  return hydrated;
}

function serializeBundle(bundle: PreKeyBundle): PersistedPreKeyBundle {
  const { olm, oneTimePreKeys, ...rest } = bundle;
  const serialized: PersistedPreKeyBundle = {
    ...rest,
    oneTimePreKeys: [...oneTimePreKeys].map(([keyId, publicKey]) => ({
      keyId,
      publicKey,
    })),
  };
  if (olm) {
    serialized.olm = {
      identityCurve25519: olm.identityCurve25519,
      identityEd25519: olm.identityEd25519,
      oneTimeKeys: [...olm.oneTimeKeys].map(([keyId, publicKey]) => ({
        keyId,
        publicKey,
      })),
    };
  }
  return serialized;
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
 *
 * Auto-init: wenn der User noch kein PreKey-Bundle hat (Phase-5-Clients
 * publishen kein Legacy-signedPreKey mehr), wird hier ein Minimal-Bundle
 * mit dem identityKey des Users angelegt. Caller stellt `identityKey`
 * dafür bereit.
 */
export function uploadOlmKeys(
  userId: string,
  data: {
    identityCurve25519?: string;
    identityEd25519?: string;
    oneTimeKeys?: { keyId: string; publicKey: string }[];
  },
  identityKey?: string
): void {
  let b = bundles.get(userId);
  if (!b) {
    if (!identityKey) return; // kein Init möglich
    b = {
      userId,
      identityKey,
      signedPreKey: {
        keyId: 0,
        publicKey: "",
        signature: "",
      },
      oneTimePreKeys: new Map(),
      nextKeyId: 1,
    };
    bundles.set(userId, b);
  }
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

/**
 * Wie viele Olm-One-Time-Keys hat der User noch publiziert? Wird vom
 * Client beim Upload-Response zurückgegeben, damit er bei niedrigem Stand
 * neue Keys generieren kann.
 */
export function getRemainingOlmKeyCount(userId: string): number {
  return bundles.get(userId)?.olm?.oneTimeKeys.size ?? 0;
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
