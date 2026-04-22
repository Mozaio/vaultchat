import _sodium from "libsodium-wrappers";

let readyPromise: Promise<void> | null = null;

export function sodiumReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = _sodium.ready.then(() => undefined);
  }
  return readyPromise;
}

export function getSodium() {
  return _sodium;
}
