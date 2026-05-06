/**
 * Verschlüsselte IndexedDB-Persistenz (at rest). Inhalte sind nur lesbar, wenn
 * der Local Data Key via `setLocalKeyFromSecret` gesetzt ist (d.h. Session
 * entsperrt). Metadaten wie id/peerId/at liegen unverschlüsselt vor, damit
 * Indizes/Sort/Filter ohne Entschlüsselung funktionieren; Body und Plain-JSON
 * sind immer als Ciphertext-Blob abgelegt.
 */
import {
  decryptToString,
  encryptString,
  hasLocalKey,
} from "./localKey";

const DB = "vaultchat";
const VER = 4;
let accountScope: string | null = null;

export function setIdbAccountScope(userId: string | null) {
  accountScope = userId ? userId.replace(/[^a-zA-Z0-9_-]/g, "") : null;
}

function scopedMetaKey(key: string) {
  return accountScope ? `acct:${accountScope}:${key}` : key;
}

type DmRecord = {
  id: string;
  peerId: string;
  fromMe: boolean;
  at: number;
  /** Verschlüsseltes JSON von PlainPayload */
  payloadCipher: Uint8Array;
  /** Optional: wenn verschwindende Nachricht, ablaufend bei dieser Wall-Clock-Zeit */
  expiresAt?: number;
};

type GroupRecord = {
  id: string;
  groupId: string;
  fromUserId: string;
  at: number;
  payloadCipher: Uint8Array;
  expiresAt?: number;
};

type MetaRecord = {
  key: string;
  /** Immer verschlüsselt. */
  valueCipher: Uint8Array;
};

export type StoredDmMessage = {
  id: string;
  peerId: string;
  fromMe: boolean;
  plainJson: string;
  at: number;
  expiresAt?: number;
};

export type StoredGroupMessage = {
  id: string;
  groupId: string;
  fromUserId: string;
  plainJson: string;
  at: number;
  expiresAt?: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VER);
    r.onerror = () => reject(r.error);
    r.onsuccess = () => resolve(r.result);
    r.onupgradeneeded = () => {
      const db = r.result;
      // Re-create stores on version bump (migration). Alte Datenstrukturen werden
      // verworfen; der Server speichert ohnehin keine Nachrichten.
      for (const name of Array.from(db.objectStoreNames)) {
        db.deleteObjectStore(name);
      }
      db.createObjectStore("dm", { keyPath: "id" });
      db.createObjectStore("groupMsg", { keyPath: "id" });
      db.createObjectStore("meta", { keyPath: "key" });
      db.createObjectStore("outbox", { keyPath: "cid" });
    };
  });
}

function assertKey() {
  if (!hasLocalKey()) throw new Error("local_key_missing");
}

export async function idbPutDm(m: StoredDmMessage): Promise<void> {
  assertKey();
  const payloadCipher = await encryptString(m.plainJson);
  const rec: DmRecord = {
    id: m.id,
    peerId: m.peerId,
    fromMe: m.fromMe,
    at: m.at,
    payloadCipher,
    ...(m.expiresAt ? { expiresAt: m.expiresAt } : {}),
  };
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("dm", "readwrite");
    tx.objectStore("dm").put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbUpdateDmPayload(
  id: string,
  plainJson: string
): Promise<void> {
  assertKey();
  const db = await openDb();
  const existing = await new Promise<DmRecord | null>((resolve, reject) => {
    const tx = db.transaction("dm", "readonly");
    const req = tx.objectStore("dm").get(id);
    req.onsuccess = () => resolve((req.result as DmRecord | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  if (!existing) return;
  const payloadCipher = await encryptString(plainJson);
  const db2 = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db2.transaction("dm", "readwrite");
    tx.objectStore("dm").put({ ...existing, payloadCipher });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbDeleteDm(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("dm", "readwrite");
    tx.objectStore("dm").delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbListDm(peerId: string): Promise<StoredDmMessage[]> {
  assertKey();
  const db = await openDb();
  const records = await new Promise<DmRecord[]>((resolve, reject) => {
    const out: DmRecord[] = [];
    const tx = db.transaction("dm", "readonly");
    const req = tx.objectStore("dm").openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) {
        resolve(out);
        return;
      }
      const v = c.value as DmRecord;
      if (v.peerId === peerId) out.push(v);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  const now = Date.now();
  const alive = records.filter((r) => !r.expiresAt || r.expiresAt > now);
  const results: StoredDmMessage[] = [];
  for (const r of alive) {
    try {
      const plainJson = await decryptToString(r.payloadCipher);
      results.push({
        id: r.id,
        peerId: r.peerId,
        fromMe: r.fromMe,
        plainJson,
        at: r.at,
        expiresAt: r.expiresAt,
      });
    } catch {
      /* Ciphertext beschädigt/fremder Key — überspringen. */
    }
  }
  return results.sort((a, b) => a.at - b.at);
}

export async function idbListAllDm(): Promise<StoredDmMessage[]> {
  assertKey();
  const db = await openDb();
  const records = await new Promise<DmRecord[]>((resolve, reject) => {
    const out: DmRecord[] = [];
    const tx = db.transaction("dm", "readonly");
    const req = tx.objectStore("dm").openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) {
        resolve(out);
        return;
      }
      out.push(c.value as DmRecord);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  const now = Date.now();
  const alive = records.filter((r) => !r.expiresAt || r.expiresAt > now);
  const results: StoredDmMessage[] = [];
  for (const r of alive) {
    try {
      const plainJson = await decryptToString(r.payloadCipher);
      results.push({
        id: r.id,
        peerId: r.peerId,
        fromMe: r.fromMe,
        plainJson,
        at: r.at,
        expiresAt: r.expiresAt,
      });
    } catch {
      /* skip corrupted */
    }
  }
  return results;
}

export async function idbPurgeExpired(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["dm", "groupMsg"], "readwrite");
    const now = Date.now();
    const dms = tx.objectStore("dm").openCursor();
    dms.onsuccess = () => {
      const c = dms.result;
      if (!c) return;
      const v = c.value as DmRecord;
      if (v.expiresAt && v.expiresAt <= now) c.delete();
      c.continue();
    };
    const gms = tx.objectStore("groupMsg").openCursor();
    gms.onsuccess = () => {
      const c = gms.result;
      if (!c) return;
      const v = c.value as GroupRecord;
      if (v.expiresAt && v.expiresAt <= now) c.delete();
      c.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbPutGroupMsg(m: StoredGroupMessage): Promise<void> {
  assertKey();
  const payloadCipher = await encryptString(m.plainJson);
  const rec: GroupRecord = {
    id: m.id,
    groupId: m.groupId,
    fromUserId: m.fromUserId,
    at: m.at,
    payloadCipher,
    ...(m.expiresAt ? { expiresAt: m.expiresAt } : {}),
  };
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("groupMsg", "readwrite");
    tx.objectStore("groupMsg").put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbUpdateGroupPayload(
  id: string,
  plainJson: string
): Promise<void> {
  assertKey();
  const db = await openDb();
  const existing = await new Promise<GroupRecord | null>((resolve, reject) => {
    const tx = db.transaction("groupMsg", "readonly");
    const req = tx.objectStore("groupMsg").get(id);
    req.onsuccess = () =>
      resolve((req.result as GroupRecord | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  if (!existing) return;
  const payloadCipher = await encryptString(plainJson);
  const db2 = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db2.transaction("groupMsg", "readwrite");
    tx.objectStore("groupMsg").put({ ...existing, payloadCipher });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbDeleteGroupMsg(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("groupMsg", "readwrite");
    tx.objectStore("groupMsg").delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbListGroup(
  groupId: string
): Promise<StoredGroupMessage[]> {
  assertKey();
  const db = await openDb();
  const records = await new Promise<GroupRecord[]>((resolve, reject) => {
    const out: GroupRecord[] = [];
    const tx = db.transaction("groupMsg", "readonly");
    const req = tx.objectStore("groupMsg").openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) {
        resolve(out);
        return;
      }
      const v = c.value as GroupRecord;
      if (v.groupId === groupId) out.push(v);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  const now = Date.now();
  const alive = records.filter((r) => !r.expiresAt || r.expiresAt > now);
  const results: StoredGroupMessage[] = [];
  for (const r of alive) {
    try {
      const plainJson = await decryptToString(r.payloadCipher);
      results.push({
        id: r.id,
        groupId: r.groupId,
        fromUserId: r.fromUserId,
        plainJson,
        at: r.at,
        expiresAt: r.expiresAt,
      });
    } catch {
      /* ignore */
    }
  }
  return results.sort((a, b) => a.at - b.at);
}

export async function idbListAllGroupMsgs(): Promise<StoredGroupMessage[]> {
  assertKey();
  const db = await openDb();
  const records = await new Promise<GroupRecord[]>((resolve, reject) => {
    const out: GroupRecord[] = [];
    const tx = db.transaction("groupMsg", "readonly");
    const req = tx.objectStore("groupMsg").openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) {
        resolve(out);
        return;
      }
      out.push(c.value as GroupRecord);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  const now = Date.now();
  const alive = records.filter((r) => !r.expiresAt || r.expiresAt > now);
  const results: StoredGroupMessage[] = [];
  for (const r of alive) {
    try {
      const plainJson = await decryptToString(r.payloadCipher);
      results.push({
        id: r.id,
        groupId: r.groupId,
        fromUserId: r.fromUserId,
        plainJson,
        at: r.at,
        expiresAt: r.expiresAt,
      });
    } catch {
      /* skip corrupted */
    }
  }
  return results;
}

export async function metaGet(key: string): Promise<string | null> {
  assertKey();
  const db = await openDb();
  const scoped = scopedMetaKey(key);
  const scopedValue = await readMetaValue(db, scoped);
  if (scopedValue !== null || scoped === key) return scopedValue;

  const legacyValue = await readMetaValue(db, key);
  if (legacyValue !== null) {
    await metaSet(key, legacyValue).catch(() => {});
  }
  return legacyValue;
}

async function readMetaValue(
  db: IDBDatabase,
  key: string
): Promise<string | null> {
  const rec = await new Promise<MetaRecord | null>((resolve, reject) => {
    const tx = db.transaction("meta", "readonly");
    const req = tx.objectStore("meta").get(key);
    req.onsuccess = () =>
      resolve((req.result as MetaRecord | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  if (!rec) return null;
  try {
    return await decryptToString(rec.valueCipher);
  } catch {
    return null;
  }
}

export async function metaSet(key: string, value: string): Promise<void> {
  assertKey();
  const valueCipher = await encryptString(value);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put({ key: scopedMetaKey(key), valueCipher });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
