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
  nextKeyId: number;
};

function hydrateBundle(bundle: PersistedPreKeyBundle): PreKeyBundle {
  return {
    ...bundle,
    oneTimePreKeys: new Map(
      bundle.oneTimePreKeys.map((key) => [key.keyId, key.publicKey])
    ),
  };
}

function serializeBundle(bundle: PreKeyBundle): PersistedPreKeyBundle {
  return {
    ...bundle,
    oneTimePreKeys: [...bundle.oneTimePreKeys].map(([keyId, publicKey]) => ({
      keyId,
      publicKey,
    })),
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
  signedPreKeyId = 1
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
  return {
    identityKey: b.identityKey,
    signedPreKey: b.signedPreKey,
    remainingPreKeys: b.oneTimePreKeys.size,
    oneTimePreKey: otp,
  };
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
