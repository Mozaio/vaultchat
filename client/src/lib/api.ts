const LEGACY_RENDER_SERVER_PLACEHOLDER = "https://vaultchat-server.onrender.com";
const KNOWN_RENDER_SERVER_ORIGIN = "https://vaultchat-server-g0p2.onrender.com";

export function inferRenderServerOrigin(): string {
  const host = location.host;
  if (host === "vaultchat-client.onrender.com" || host === "vaultchat-client-g0p2.onrender.com") {
    return KNOWN_RENDER_SERVER_ORIGIN;
  }
  // Beispiele:
  //   vaultchat-client.onrender.com       -> vaultchat-server.onrender.com
  //   vaultchat-client-g0p2.onrender.com  -> vaultchat-server-g0p2.onrender.com
  const m = host.match(/^(.*)-client(-[a-z0-9]+)?(\.onrender\.com)$/i);
  if (m) return `https://${m[1]}-server${m[2] ?? ""}${m[3]}`;
  return "";
}

export const apiBase = () => {
  const explicit = (import.meta.env.VITE_API_BASE ?? "").trim().replace(/\/$/, "");
  // Historischer Platzhalter aus älteren Blueprints -> bewusst ignorieren.
  if (explicit && explicit !== LEGACY_RENDER_SERVER_PLACEHOLDER) return explicit;
  const wsLike = (import.meta.env.VITE_WS_URL ?? "").trim().replace(/\/$/, "");
  if (wsLike) {
    const asHttp = wsLike.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
    if (asHttp !== LEGACY_RENDER_SERVER_PLACEHOLDER) return asHttp;
  }
  return inferRenderServerOrigin();
};

export type ApiUser = {
  id: string;
  username: string;
  publicKey: string;
  plan?: "personal" | "pro" | "team";
  recoveryEmailConfigured?: boolean;
};

export type ApiGroup = {
  id: string;
  name: string;
  memberIds: string[];
  /** Fehlt bei älteren Servern bis Neustart. */
  createdByUserId?: string;
  createdAt: number;
  /** Optional, vom Creator gesetzt. Server speichert klartext (nicht E2EE). */
  description?: string;
  /** data:image/...;base64,... — server speichert klartext. */
  avatar?: string;
  /** Letzte Änderung an Profil (Name/Beschreibung/Avatar). */
  updatedAt?: number;
};

/**
 * Custom-Event "vaultchat:cold-start" wird gefeuert, wenn ein einzelner
 * API-Call länger als 4 Sekunden braucht — typischerweise weil Render-Free
 * den Server beim ersten Request nach 15 min Inaktivität aus dem Sleep
 * holt (Cold-Start). UI-Komponenten (App.tsx) hängen sich an dieses
 * Event und zeigen einen erklärenden Banner, damit User nicht denken,
 * die Seite hängt.
 */
const COLD_START_THRESHOLD_MS = 4_000;
function fireColdStart() {
  try {
    window.dispatchEvent(new CustomEvent("vaultchat:cold-start"));
  } catch {
    /* SSR or test env */
  }
}
function fireColdStartDone() {
  try {
    window.dispatchEvent(new CustomEvent("vaultchat:cold-start-done"));
  } catch {
    /* noop */
  }
}

async function req<T>(
  path: string,
  init?: RequestInit & { token?: string | null }
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (init?.token) headers.Authorization = `Bearer ${init.token}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  const coldStartTimer = setTimeout(fireColdStart, COLD_START_THRESHOLD_MS);
  let r: Response;
  try {
    r = await fetch(`${apiBase()}${path}`, {
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
    clearTimeout(coldStartTimer);
    fireColdStartDone();
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
      throw new Error(`api_base_misconfigured:${apiBase() || "(same-origin)"}`);
    }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

export async function register(body: {
  username: string;
  password: string;
  publicKey: string;
  recoveryEmail?: string;
  requestedPlan?: "personal" | "pro" | "team";
  inviteCode?: string;
}) {
  return req<{ token: string; user: ApiUser }>("/api/register", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export type PublicConfig = {
  registration: {
    mode: "open" | "invite" | "closed";
    inviteRequired: boolean;
  };
  product?: {
    identity: {
      emailMode: "optional_hash_only";
      backupRequiredForNewDevices: boolean;
    };
    plans: {
      id: "personal" | "pro" | "team";
      name: string;
      priceEurMonthly: number;
      audience: string;
      highlights: string[];
    }[];
  };
};

export async function publicConfig() {
  return req<PublicConfig>("/api/public-config");
}

export type ServerStatus = {
  profile: "development" | "preview" | "production";
  state: {
    mode: "ephemeral" | "persistent";
    writable: boolean;
  };
  directory: {
    users: number;
    groups: number;
  };
  preKeys: {
    bundles: number;
    oneTimePreKeys: number;
  };
  mailbox: {
    queued: number;
    recipients: number;
    ttlMs: number;
    maxPerRecipient: number;
  };
  realtime: {
    onlineUsers: number;
    sockets: number;
  };
  privacy: {
    sealedDmMailbox: boolean;
    sealedGroupMailbox?: boolean;
    messageContentPersistentOnServer: boolean;
    recoveryEmailStoredAsHash?: boolean;
    urlTokenAuthEnabled: boolean;
  };
  product?: PublicConfig["product"];
  registration: PublicConfig["registration"];
};

export async function serverStatus(token: string) {
  return req<ServerStatus>("/api/server/status", { token });
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

export async function listUsers(token: string, ids: string[] = []) {
  const unique = Array.from(new Set(ids)).slice(0, 50);
  const qs = unique.length ? `?ids=${encodeURIComponent(unique.join(","))}` : "";
  return req<{ users: ApiUser[] }>(`/api/users${qs}`, { token });
}

/**
 * Telegram-Style Username-Suche.
 * Gibt nur Ergebnisse zurück wenn Query mindestens 2 Zeichen hat.
 * Limit: 10 Ergebnisse.
 */
export async function searchUsers(token: string, query: string) {
  const q = query.trim().toLowerCase();
  if (q.length < 3) {
    return { users: [] as ApiUser[] };
  }
  return req<{ users: ApiUser[] }>(`/api/users/search?q=${encodeURIComponent(q)}`, { token });
}

export async function createGroup(
  token: string,
  body: { name: string; memberIds: string[]; description?: string; avatar?: string }
) {
  return req<{ group: ApiGroup }>("/api/groups", {
    method: "POST",
    body: JSON.stringify(body),
    token,
  });
}

export async function updateGroupProfile(
  token: string,
  groupId: string,
  updates: { name?: string; description?: string; avatar?: string }
) {
  return req<{ group: ApiGroup }>(`/api/groups/${groupId}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
    token,
  });
}

export async function listGroups(token: string) {
  return req<{ groups: ApiGroup[] }>("/api/groups", { token });
}

/**
 * Sealed-Sender für Gruppen (#26): sendet einen Gruppen-Ciphertext OHNE
 * Auth-Token → der Server lernt den Absender NICHT (Metadaten-Privatsphäre).
 * Best-effort (kein Outbox/Retry); der Empfänger-Pfad ist unverändert.
 */
export async function sendSealedGroup(
  groupId: string,
  ciphertext: string
): Promise<void> {
  const base = apiBase();
  await fetch(`${base}/api/groups/${encodeURIComponent(groupId)}/sealed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ciphertext }),
  });
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

export type GroupInvite = {
  token: string;
  groupId: string;
  createdByUserId: string;
  createdAt: number;
  /** ms-since-epoch the token expires; 0 = never. */
  expiresAt: number;
  /** Max total redemptions; 0 = unlimited. */
  maxUses: number;
  usedCount: number;
};

export async function createGroupInvite(
  token: string,
  groupId: string,
  body: { ttlMs?: number; maxUses?: number } = {}
) {
  return req<{ invite: GroupInvite }>(`/api/groups/${groupId}/invites`, {
    method: "POST",
    body: JSON.stringify(body),
    token,
  });
}

export async function listGroupInvites(token: string, groupId: string) {
  return req<{ invites: GroupInvite[] }>(`/api/groups/${groupId}/invites`, {
    token,
  });
}

export async function revokeGroupInvite(token: string, inviteToken: string) {
  return req<{ ok: true }>(`/api/groups/invites/${encodeURIComponent(inviteToken)}`, {
    method: "DELETE",
    token,
  });
}

export async function redeemGroupInvite(token: string, inviteToken: string) {
  return req<{ ok: true; groupId: string; usedCount: number; maxUses: number }>(
    `/api/invites/${encodeURIComponent(inviteToken)}/redeem`,
    { method: "POST", token }
  );
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
    signingPublicKey?: string;
  };
  remainingPreKeys?: number;
  oneTimePreKey: { keyId: number; publicKey: string } | null;
  pqKem?: {
    alg: "ML-KEM-1024";
    publicKey: string;
  };
};

export async function getPreKeyBundle(token: string, userId: string) {
  return req<PreKeyBundle>(`/api/keys/${userId}`, { token });
}

export async function uploadPreKeys(
  token: string,
  body: {
    signedPreKey: {
      keyId: number;
      publicKey: string;
      signature: string;
      signingPublicKey?: string;
    };
    oneTimePreKeys: { keyId: number; publicKey: string }[];
    pqKem?: {
      alg: "ML-KEM-1024";
      publicKey: string;
    };
    /** Optional: auditierte Olm-Schicht. */
    olm?: {
      identityCurve25519: string;
      identityEd25519: string;
      oneTimeKeys: { keyId: string; publicKey: string }[];
    };
  }
) {
  return req<{ ok: true; remaining: number; remainingOlm?: number }>(
    "/api/keys",
    {
      method: "POST",
      body: JSON.stringify(body),
      token,
    }
  );
}

/**
 * Blob-Upload für Chunked-File-Pfad (fileChunks.ts). Server endpoint:
 *   POST /api/blobs (application/octet-stream)
 * Foundation only — noch kein Aufrufer in der UI.
 */
export async function uploadBlob(
  token: string,
  bytes: Uint8Array
): Promise<{ id: string; size: number; deduped: boolean }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const r = await fetch(`${apiBase()}/api/blobs`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization: `Bearer ${token}`,
      },
      body: bytes,
    });
    if (!r.ok) {
      let msg = `blob_upload_${r.status}`;
      try {
        const j = (await r.json()) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        /* keep default */
      }
      throw new Error(msg);
    }
    return r.json() as Promise<{ id: string; size: number; deduped: boolean }>;
  } finally {
    clearTimeout(t);
  }
}

export async function downloadBlob(
  token: string,
  id: string
): Promise<Uint8Array> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const r = await fetch(`${apiBase()}/api/blobs/${encodeURIComponent(id)}`, {
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`blob_download_${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

export async function deleteBlob(token: string, id: string): Promise<void> {
  await fetch(`${apiBase()}/api/blobs/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * Self-delete: löscht den eigenen Account auf dem Server. Client muss
 * danach lokale Identity, IDB und Token selbst wipen.
 */
export async function deleteMyAccount(token: string): Promise<void> {
  const r = await fetch(`${apiBase()}/api/me`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok && r.status !== 204) {
    throw new Error(`account_delete_${r.status}`);
  }
}
