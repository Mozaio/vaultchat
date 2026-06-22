/**
 * Lokaler Volltext-Index für entschlüsselte Nachrichten.
 *
 * Warum:
 *  - VaultChat ist Zero-Knowledge — der Server darf den Inhalt nicht sehen,
 *    Server-seitige Suche ist also kein Option.
 *  - Bisher (SearchPanel) iterierte jede Query linear über alle entschlüsselten
 *    Messages aus IDB → O(n × Query-len). Bei einigen Tausend Nachrichten
 *    werden Live-Suchen spürbar.
 *  - Ein simpler Inverted-Index Map<term, Set<msgId>> macht Lookup zu
 *    O(Tokens(query)) + Schnittmenge.
 *
 * Speicher:
 *  - Index ist in-memory only. Rebuild läuft beim ersten Aufruf von
 *    `getOrBuildIndex()` (idempotent). Kein IDB-Schema-Bump.
 *  - Bei Lock wird der Index gelöscht (`clearSearchIndex`).
 *  - Bei jeder neuen Nachricht: Caller ruft `addToIndex(...)` auf.
 *  - Bei Edit/Delete: `removeFromIndex(msgId)` + neu hinzufügen.
 *
 * Design-Entscheidungen:
 *  - Tokenizer: lowercase, normalize NFC, split bei Unicode-Wortgrenzen,
 *    Tokens kürzer als 2 Zeichen werden ignoriert (zu unspezifisch).
 *  - Stop-Words: keine — VaultChat-User haben oft kurze Texte und Stop-Words
 *    in Suchquery können wichtig sein.
 *  - Stemming: keine — komplex für Multi-Sprach (DE/EN-mix in Real-World-Data).
 *  - Prefix-Match: ja — wer "vault" tippt, findet "vaultchat".
 */
import {
  idbListAllDm,
  idbListAllGroupMsgs,
  setIdbMsgListener,
  type IdbMsgEvent,
} from "./idb";
import type { PlainPayload } from "./crypto";

export type IndexedMessage = {
  id: string;
  scope: "dm" | "group";
  /** peerId für DM, groupId für Group. */
  scopeId: string;
  fromUserId?: string;
  body: string;
  at: number;
  cid: string;
};

type Posting = Set<string>; // msg.id-Set
const _index = new Map<string, Posting>();
const _docs = new Map<string, IndexedMessage>();
let _built = false;

const TOKEN_RE = /[\p{L}\p{N}]{2,}/gu;

export function tokenize(text: string): string[] {
  if (!text) return [];
  const norm = text.normalize("NFC").toLowerCase();
  const matches = norm.match(TOKEN_RE);
  if (!matches) return [];
  return Array.from(new Set(matches));
}

export function addToIndex(msg: IndexedMessage): void {
  if (!msg.id || !msg.body) {
    _docs.set(msg.id, msg);
    return;
  }
  _docs.set(msg.id, msg);
  for (const token of tokenize(msg.body)) {
    let posting = _index.get(token);
    if (!posting) {
      posting = new Set();
      _index.set(token, posting);
    }
    posting.add(msg.id);
  }
}

export function removeFromIndex(msgId: string): void {
  const doc = _docs.get(msgId);
  _docs.delete(msgId);
  if (!doc) return;
  for (const token of tokenize(doc.body)) {
    const posting = _index.get(token);
    if (!posting) continue;
    posting.delete(msgId);
    if (posting.size === 0) _index.delete(token);
  }
}

export function updateIndexed(msgId: string, newBody: string): void {
  const doc = _docs.get(msgId);
  if (!doc) return;
  removeFromIndex(msgId);
  addToIndex({ ...doc, body: newBody });
}

/**
 * Applies a live idb mutation to the in-memory index so search stays fresh
 * within a session (GOAL Phase 1). Registered once the index is built, detached
 * on lock. Re-puts/edits reindex via remove-then-add.
 */
function applyIdbEvent(e: IdbMsgEvent): void {
  if (e.kind === "delete") {
    removeFromIndex(e.id);
    return;
  }
  let plain: PlainPayload;
  try {
    plain = JSON.parse(e.plainJson) as PlainPayload;
  } catch {
    return;
  }
  removeFromIndex(e.id);
  if (e.kind === "putDm") {
    addToIndex({
      id: e.id,
      scope: "dm",
      scopeId: e.peerId,
      body: plain.body ?? "",
      at: e.at,
      cid: plain.cid ?? e.id,
    });
  } else {
    addToIndex({
      id: e.id,
      scope: "group",
      scopeId: e.groupId,
      fromUserId: e.fromUserId,
      body: plain.body ?? "",
      at: e.at,
      cid: plain.cid ?? e.id,
    });
  }
}

export function clearSearchIndex(): void {
  _index.clear();
  _docs.clear();
  _built = false;
  setIdbMsgListener(null);
}

/**
 * Lädt alle entschlüsselten Messages aus IDB einmalig in den Index.
 * Idempotent — beim zweiten Aufruf no-op.
 */
export async function getOrBuildIndex(): Promise<void> {
  if (_built) return;
  _built = true;
  // Keep the index live for the rest of the session (new/edited/deleted msgs).
  setIdbMsgListener(applyIdbEvent);
  try {
    const dms = await idbListAllDm();
    for (const m of dms) {
      let plain: PlainPayload;
      try {
        plain = JSON.parse(m.plainJson) as PlainPayload;
      } catch {
        continue;
      }
      addToIndex({
        id: m.id,
        scope: "dm",
        scopeId: m.peerId,
        body: plain.body ?? "",
        at: m.at,
        cid: plain.cid ?? m.id,
      });
    }
    const gms = await idbListAllGroupMsgs();
    for (const m of gms) {
      let plain: PlainPayload;
      try {
        plain = JSON.parse(m.plainJson) as PlainPayload;
      } catch {
        continue;
      }
      addToIndex({
        id: m.id,
        scope: "group",
        scopeId: m.groupId,
        fromUserId: m.fromUserId,
        body: plain.body ?? "",
        at: m.at,
        cid: plain.cid ?? m.id,
      });
    }
  } catch {
    // Build-Fehler nicht propagieren — Suche degraded auf "leer".
    _built = false;
  }
}

export type SearchOptions = {
  scope?: "all" | "dm" | "group";
  scopeId?: string;
  limit?: number;
};

/**
 * Token-basierte AND-Suche mit optionalem Prefix-Match-Fallback.
 */
export function search(query: string, opts: SearchOptions = {}): IndexedMessage[] {
  const limit = opts.limit ?? 50;
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  // AND: Schnittmenge der Postings.
  let candidates: Set<string> | null = null;
  for (const tok of tokens) {
    let posting = _index.get(tok);
    if (!posting) {
      // Prefix-Fallback: passenden Term suchen, der mit `tok` beginnt.
      // Linear über alle Terms — bei <100k Terms vertretbar; sonst trie.
      const merged = new Set<string>();
      for (const [term, p] of _index) {
        if (term.startsWith(tok)) {
          for (const id of p) merged.add(id);
        }
      }
      if (merged.size === 0) return [];
      posting = merged;
    }
    if (candidates === null) {
      candidates = new Set(posting);
    } else {
      const next = new Set<string>();
      for (const id of candidates) if (posting.has(id)) next.add(id);
      candidates = next;
    }
    if (candidates.size === 0) return [];
  }

  if (!candidates) return [];

  const hits: IndexedMessage[] = [];
  for (const id of candidates) {
    const doc = _docs.get(id);
    if (!doc) continue;
    if (opts.scope && opts.scope !== "all" && doc.scope !== opts.scope) continue;
    if (opts.scopeId && doc.scopeId !== opts.scopeId) continue;
    hits.push(doc);
  }
  hits.sort((a, b) => b.at - a.at);
  return hits.slice(0, limit);
}

export function searchIndexStats() {
  return {
    terms: _index.size,
    docs: _docs.size,
    built: _built,
  };
}
