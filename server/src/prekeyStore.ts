type PreKeyBundle = {
  userId: string;
  identityKey: string;
  signedPreKey: { keyId: number; publicKey: string; signature: string };
  oneTimePreKeys: Map<number, string>;
  nextKeyId: number;
};

const bundles = new Map<string, PreKeyBundle>();

export function initPreKeyBundle(
  userId: string,
  identityKey: string,
  signedPreKeyPublic: string,
  signedPreKeySignature: string
): void {
  bundles.set(userId, {
    userId,
    identityKey,
    signedPreKey: {
      keyId: 1,
      publicKey: signedPreKeyPublic,
      signature: signedPreKeySignature,
    },
    oneTimePreKeys: new Map(),
    nextKeyId: 1,
  });
}

export function uploadOneTimePreKeys(
  userId: string,
  keys: { keyId: number; publicKey: string }[]
): void {
  const b = bundles.get(userId);
  if (b) {
    for (const k of keys) b.oneTimePreKeys.set(k.keyId, k.publicKey);
  }
}

export function getPreKeyBundle(userId: string): {
  identityKey: string;
  signedPreKey: { keyId: number; publicKey: string; signature: string };
  oneTimePreKey: { keyId: number; publicKey: string } | null;
} | null {
  const b = bundles.get(userId);
  if (!b) return null;
  let otp: { keyId: number; publicKey: string } | null = null;
  for (const [keyId, publicKey] of b.oneTimePreKeys) {
    otp = { keyId, publicKey };
    b.oneTimePreKeys.delete(keyId);
    break;
  }
  return { identityKey: b.identityKey, signedPreKey: b.signedPreKey, oneTimePreKey: otp };
}

export function getRemainingPreKeyCount(userId: string): number {
  return bundles.get(userId)?.oneTimePreKeys.size ?? 0;
}
