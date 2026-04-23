function inferRenderServerOrigin(): string {
  const host = location.host;
  // Beispiele:
  //   vaultchat-client.onrender.com       -> vaultchat-server.onrender.com
  //   vaultchat-client-g0p2.onrender.com  -> vaultchat-server-g0p2.onrender.com
  const m = host.match(/^(.*)-client(-[a-z0-9]+)?(\.onrender\.com)$/i);
  if (m) return `https://${m[1]}-server${m[2] ?? ""}${m[3]}`;
  if (host === "vaultchat-client.onrender.com" || host === "vaultchat-client-g0p2.onrender.com") {
    return "https://vaultchat-server-g0p2.onrender.com";
  }
  return "";
}

const base = () => {
  const explicit = (import.meta.env.VITE_API_BASE ?? "").trim().replace(/\/$/, "");
  // Historischer Platzhalter aus älteren Blueprints -> bewusst ignorieren.
  if (explicit && explicit !== "https://vaultchat-server.onrender.com") return explicit;
  const wsLike = (import.meta.env.VITE_WS_URL ?? "").trim().replace(/\/$/, "");
  if (wsLike) {
    const asHttp = wsLike.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
    if (asHttp !== "https://vaultchat-server.onrender.com") return asHttp;
  }
  return inferRenderServerOrigin();
};

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
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  let r: Response;
  try {
    r = await fetch(`${base()}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { ...headers, ...init?.headers },
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("api_timeout");
    }
    throw new Error("network_error_or_cors");
  } finally {
    clearTimeout(t);
  }
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
    if (msg.includes("Cannot POST /api/") || msg.includes("Cannot GET /api/")) {
      throw new Error(`api_base_misconfigured:${base() || "(same-origin)"}`);
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

/**
 * Telegram-Style Username-Suche.
 * Gibt nur Ergebnisse zurück wenn Query mindestens 2 Zeichen hat.
 * Limit: 10 Ergebnisse.
 */
export async function searchUsers(token: string, query: string) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) {
    return { users: [] as ApiUser[] };
  }
  return req<{ users: ApiUser[] }>(`/api/users/search?q=${encodeURIComponent(q)}`, { token });
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

/** Pre-Key-Bundle (für künftigen X3DH-Handshakes). */
export type PreKeyBundle = {
  identityKey: string;
  signedPreKey: {
    keyId: number;
    publicKey: string;
    signature: string;
  };
  oneTimePreKey: { keyId: number; publicKey: string } | null;
};

export async function getPreKeyBundle(token: string, userId: string) {
  return req<PreKeyBundle>(`/api/keys/${userId}`, { token });
}

export async function uploadPreKeys(
  token: string,
  body: {
    signedPreKey: { keyId: number; publicKey: string; signature: string };
    oneTimePreKeys: { keyId: number; publicKey: string }[];
  }
) {
  return req<{ ok: true; remaining: number }>("/api/keys", {
    method: "POST",
    body: JSON.stringify(body),
    token,
  });
}
