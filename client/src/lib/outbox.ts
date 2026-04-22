/**
 * Offline-Outbox: wenn der Empfänger keinen offenen Socket hat, liefert der
 * Server `delivered: 0` zurück. Wir halten den Sealed-Envelope lokal fest und
 * retry'n periodisch bzw. bei Reconnect.
 *
 * Der Server speichert NICHTS — die Persistenz dieser "offline mailbox" liegt
 * vollständig beim Sender, verschlüsselt in der IDB via LDK.
 */
import { hasLocalKey, encryptString, decryptToString } from "./localKey";

const DB = "vaultchat";
const VER = 4;

type OutboxRecord = {
  cid: string;
  toUserId: string;
  envelopeCipher: Uint8Array;
  createdAt: number;
  attempts: number;
  lastAttempt: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VER);
    r.onerror = () => reject(r.error);
    r.onsuccess = () => resolve(r.result);
  });
}

function assertKey() {
  if (!hasLocalKey()) throw new Error("local_key_missing");
}

export async function outboxAdd(
  cid: string,
  toUserId: string,
  envelopeB64: string
): Promise<void> {
  assertKey();
  const envelopeCipher = await encryptString(envelopeB64);
  const rec: OutboxRecord = {
    cid,
    toUserId,
    envelopeCipher,
    createdAt: Date.now(),
    attempts: 0,
    lastAttempt: 0,
  };
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("outbox", "readwrite");
    tx.objectStore("outbox").put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function outboxRemove(cid: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("outbox", "readwrite");
    tx.objectStore("outbox").delete(cid);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function outboxList(): Promise<
  { cid: string; toUserId: string; envelopeB64: string; attempts: number }[]
> {
  assertKey();
  const db = await openDb();
  const records = await new Promise<OutboxRecord[]>((resolve, reject) => {
    const out: OutboxRecord[] = [];
    const tx = db.transaction("outbox", "readonly");
    const req = tx.objectStore("outbox").openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) {
        resolve(out);
        return;
      }
      out.push(c.value as OutboxRecord);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  const decoded: {
    cid: string;
    toUserId: string;
    envelopeB64: string;
    attempts: number;
  }[] = [];
  for (const r of records) {
    try {
      decoded.push({
        cid: r.cid,
        toUserId: r.toUserId,
        envelopeB64: await decryptToString(r.envelopeCipher),
        attempts: r.attempts,
      });
    } catch {
      /* ignore */
    }
  }
  return decoded;
}

export async function outboxTouch(cid: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("outbox", "readwrite");
    const req = tx.objectStore("outbox").get(cid);
    req.onsuccess = () => {
      const rec = req.result as OutboxRecord | undefined;
      if (!rec) return;
      rec.attempts += 1;
      rec.lastAttempt = Date.now();
      tx.objectStore("outbox").put(rec);
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
  });
}
