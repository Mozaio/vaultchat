import type { PlainPayload } from "./crypto";
import type { ChatMsg } from "../components/MessageBubble";
import type { StoredDmMessage, StoredGroupMessage } from "./idb";

export type Authored = {
  id: string;
  fromMe: boolean;
  fromUserId?: string;
  plainJson: string;
  at: number;
  expiresAt?: number;
};

/**
 * Rekonstruiert die UI-Liste aus der persistierten Frame-Historie.
 * Nur Frames mit cid (v2) werden berücksichtigt. Meta-Frames
 * (reaction/edit/delete/receipt) werden nicht als eigene Bubble angezeigt,
 * sondern verändern existierende Einträge.
 */
export function reduceChatMessages(records: Authored[]): ChatMsg[] {
  const byCid = new Map<
    string,
    ChatMsg & {
      _reactByUser: Map<string, string>;
    }
  >();

  for (const r of records) {
    let p: PlainPayload;
    try {
      p = JSON.parse(r.plainJson) as PlainPayload;
    } catch {
      continue;
    }
    if (!p || p.v !== 2) continue;
    const authorKey = r.fromMe ? "__me__" : r.fromUserId ?? "peer";

    if (
      p.kind === "text" ||
      p.kind === "file" ||
      p.kind === "voice" ||
      p.kind === "system"
    ) {
      if (!p.cid) continue;
      const prev = byCid.get(p.cid);
      const next: ChatMsg & { _reactByUser: Map<string, string> } = {
        id: r.id,
        fromMe: r.fromMe,
        plain: p,
        at: r.at,
        expiresAt: r.expiresAt,
        reactions: prev?.reactions ?? {},
        myReaction: prev?.myReaction,
        deleted: prev?.deleted ?? false,
        edited: prev?.edited ?? false,
        readByPeer: prev?.readByPeer,
        deliveredToPeer: prev?.deliveredToPeer,
        _reactByUser: prev?._reactByUser ?? new Map(),
      };
      byCid.set(p.cid, next);
      continue;
    }

    if (p.kind === "edit" && p.refCid) {
      const prev = byCid.get(p.refCid);
      if (!prev) continue;
      const originalPlain = prev.plain;
      const edited: PlainPayload = {
        ...originalPlain,
        body: p.body ?? originalPlain.body,
      };
      prev.plain = edited;
      prev.edited = true;
      continue;
    }

    if (p.kind === "delete" && p.refCid) {
      const prev = byCid.get(p.refCid);
      if (!prev) continue;
      prev.deleted = true;
      continue;
    }

    if (p.kind === "reaction" && p.refCid) {
      const prev = byCid.get(p.refCid);
      if (!prev) continue;
      const emoji = (p.emoji ?? "").trim();
      const oldEmoji = prev._reactByUser.get(authorKey);
      const reactions = { ...(prev.reactions ?? {}) };
      if (oldEmoji) {
        reactions[oldEmoji] = Math.max(0, (reactions[oldEmoji] ?? 1) - 1);
        if (reactions[oldEmoji] === 0) delete reactions[oldEmoji];
      }
      if (emoji) {
        reactions[emoji] = (reactions[emoji] ?? 0) + 1;
        prev._reactByUser.set(authorKey, emoji);
      } else {
        prev._reactByUser.delete(authorKey);
      }
      prev.reactions = reactions;
      if (r.fromMe) {
        prev.myReaction = emoji || undefined;
      }
      continue;
    }

    if (p.kind === "receipt" && p.refCid) {
      const prev = byCid.get(p.refCid);
      if (!prev) continue;
      if (!r.fromMe) {
        if (p.receiptKind === "read") prev.readByPeer = true;
        if (p.receiptKind === "delivered") prev.deliveredToPeer = true;
      }
      continue;
    }
  }

  const now = Date.now();
  const out = Array.from(byCid.values()).map((m) => {
    if (m.plain.replyToCid && m.plain.replyPreview) {
      const target = byCid.get(m.plain.replyToCid);
      if (!target || target.deleted || (target.expiresAt && target.expiresAt <= now)) {
        m.plain = { ...m.plain, replyPreview: undefined };
      }
    }
    const { _reactByUser, ...rest } = m;
    void _reactByUser;
    return rest;
  });
  return out.sort((a, b) => a.at - b.at);
}

export function authoredFromDm(rows: StoredDmMessage[]): Authored[] {
  return rows.map((r) => ({
    id: r.id,
    fromMe: r.fromMe,
    plainJson: r.plainJson,
    at: r.at,
    expiresAt: r.expiresAt,
  }));
}

export function authoredFromGroup(
  rows: StoredGroupMessage[],
  myUserId: string
): Authored[] {
  return rows.map((r) => ({
    id: r.id,
    fromMe: r.fromUserId === myUserId,
    fromUserId: r.fromUserId,
    plainJson: r.plainJson,
    at: r.at,
    expiresAt: r.expiresAt,
  }));
}
