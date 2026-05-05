import * as api from "./api";
import type { LocalIdentity } from "./localIdentity";
import {
  fingerprintFromPublicKeyB64,
  generateBoxKeypair,
  publicKeyBase64,
  unwrapSecretKey,
  wrapSecretKey,
} from "./crypto";
import {
  generateKeyMaterial,
  toUploadBody,
} from "./keyStore";

export type Session = {
  token: string;
  user: api.ApiUser;
  secretKey: Uint8Array;
};

export async function buildSessionFromLogin(
  username: string,
  password: string,
  local: LocalIdentity | null
): Promise<Session> {
  const { token, user } = await api.login({ username, password });
  if (
    !local ||
    local.username !== user.username ||
    local.userId !== user.id
  ) {
    throw new Error(
      "Kein lokaler Schlüssel für diesen Benutzer. Backup importieren oder auf diesem Gerät registrieren."
    );
  }
  const secretKey = await unwrapSecretKey(local.wrapped, password);
  return { token, user, secretKey };
}

export async function buildSessionFromRegister(
  username: string,
  password: string,
  inviteCode?: string,
  options?: {
    recoveryEmail?: string;
    requestedPlan?: "personal" | "pro" | "team";
  }
): Promise<{ session: Session; local: LocalIdentity }> {
  const kp = await generateBoxKeypair();
  const publicKey = publicKeyBase64(kp.publicKey);
  const wrapped = await wrapSecretKey(kp.secretKey, password);
  const { token, user } = await api.register({
    username,
    password,
    publicKey,
    ...(options?.recoveryEmail ? { recoveryEmail: options.recoveryEmail } : {}),
    ...(options?.requestedPlan ? { requestedPlan: options.requestedPlan } : {}),
    ...(inviteCode ? { inviteCode } : {}),
  });
  try {
    const keyMaterial = await generateKeyMaterial(kp.secretKey);
    await api.uploadPreKeys(token, toUploadBody(keyMaterial));
  } catch {
    // ChatShell retries pre-key upload after the local data key is unlocked.
  }
  const local: LocalIdentity = {
    userId: user.id,
    username: user.username,
    publicKey: user.publicKey,
    wrapped,
  };
  return {
    session: { token, user, secretKey: kp.secretKey },
    local,
  };
}

export async function fingerprintFor(user: api.ApiUser) {
  return fingerprintFromPublicKeyB64(user.publicKey);
}
