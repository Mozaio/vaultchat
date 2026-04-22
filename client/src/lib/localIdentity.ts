import type { WrappedSecret } from "./crypto";

const STORAGE = "vaultchat.identity.v1";

export type LocalIdentity = {
  userId: string;
  username: string;
  publicKey: string;
  wrapped: WrappedSecret;
};

export function saveLocalIdentity(id: LocalIdentity) {
  localStorage.setItem(STORAGE, JSON.stringify(id));
}

export function loadLocalIdentity(): LocalIdentity | null {
  const raw = localStorage.getItem(STORAGE);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LocalIdentity;
  } catch {
    return null;
  }
}

export function clearLocalIdentity() {
  localStorage.removeItem(STORAGE);
}

const TOKEN = "vaultchat.token.v1";

export function saveToken(t: string) {
  sessionStorage.setItem(TOKEN, t);
}

export function loadToken(): string | null {
  return sessionStorage.getItem(TOKEN);
}

export function clearToken() {
  sessionStorage.removeItem(TOKEN);
}
