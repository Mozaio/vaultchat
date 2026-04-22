const base = () =>
  (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

export type ApiUser = {
  id: string;
  username: string;
  publicKey: string;
};

export type ApiGroup = {
  id: string;
  name: string;
  memberIds: string[];
  createdAt: number;
};

async function req<T>(
  path: string,
  init?: RequestInit & { token?: string | null }
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (init?.token) headers.Authorization = `Bearer ${init.token}`;
  const r = await fetch(`${base()}${path}`, {
    ...init,
    headers: { ...headers, ...init?.headers },
  });
  if (!r.ok) {
    const raw = await r.text();
    let msg = raw || r.statusText;
    try {
      const j = JSON.parse(raw) as { error?: string; message?: string };
      if (typeof j.error === "string") msg = j.error;
      else if (typeof j.message === "string") msg = j.message;
    } catch {
      /* Body ist kein JSON — msg bleibt raw. */
    }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

export async function register(body: {
  username: string;
  password: string;
  publicKey: string;
}) {
  return req<{ token: string; user: ApiUser }>("/api/register", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function login(body: { username: string; password: string }) {
  return req<{ token: string; user: ApiUser }>("/api/login", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function me(token: string) {
  return req<ApiUser>("/api/me", { headers: {}, token });
}

export async function listUsers(token: string) {
  return req<{ users: ApiUser[] }>("/api/users", { token });
}

export async function createGroup(token: string, body: { name: string; memberIds: string[] }) {
  return req<{ group: ApiGroup }>("/api/groups", {
    method: "POST",
    body: JSON.stringify(body),
    token,
  });
}

export async function listGroups(token: string) {
  return req<{ groups: ApiGroup[] }>("/api/groups", { token });
}

/**
 * Sealed-Sender DM-Relay. Der Server setzt KEIN `fromUserId` — dieses wird
 * aus dem Envelope vom Empfänger extrahiert.
 */
export type ServerEnvelope = {
  id: string;
  toUserId: string;
  envelope: string;
  createdAt: number;
};

export async function addGroupMember(
  token: string,
  groupId: string,
  memberId: string
) {
  return req<{ group: ApiGroup }>(`/api/groups/${groupId}/members`, {
    method: "POST",
    body: JSON.stringify({ memberId }),
    token,
  });
}

export async function removeGroupMember(
  token: string,
  groupId: string,
  memberId: string
) {
  return req<{ group: ApiGroup }>(`/api/groups/${groupId}/members/${memberId}`, {
    method: "DELETE",
    token,
  });
}

export async function leaveGroup(token: string, groupId: string) {
  return req<{ ok: true }>(`/api/groups/${groupId}/leave`, {
    method: "POST",
    token,
  });
}

export type RtcConfig = {
  iceServers: RTCIceServer[];
  forceRelay: boolean;
};

export async function getRtcConfig(token: string) {
  return req<RtcConfig>("/api/rtc/config", { token });
}
