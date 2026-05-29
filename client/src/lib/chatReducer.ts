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
      _pollVoteByUser: Map<string, number>;
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
      p.kind === "system" ||
      p.kind === "poll"
    ) {
      if (!p.cid) continue;
      const prev = byCid.get(p.cid);
      const next: ChatMsg & {
        _reactByUser: Map<string, string>;
        _pollVoteByUser: Map<string, number>;
      } = {
        id: r.id,
        fromMe: r.fromMe,
        fromUserId: r.fromUserId,
        plain: p,
        at: r.at,
        expiresAt: r.expiresAt,
        reactions: prev?.reactions ?? {},
        myReaction: prev?.myReaction,
        deleted: prev?.deleted ?? false,
        edited: prev?.edited ?? false,
        readByPeer: prev?.readByPeer,
        deliveredToPeer: prev?.deliveredToPeer,
        pollVotes: prev?.pollVotes,
        myPollVote: prev?.myPollVote,
        _reactByUser: prev?._reactByUser ?? new Map(),
        _pollVoteByUser: prev?._pollVoteByUser ?? new Map(),
      };
      byCid.set(p.cid, next);
      continue;
    }

    if (p.kind === "poll-vote" && p.refCid && typeof p.pollVoteIndex === "number") {
      const prev = byCid.get(p.refCid);
      if (!prev) continue;
      const idx = p.pollVoteIndex;
      const optCount = prev.plain.pollOptions?.length ?? 0;
      const oldIdx = prev._pollVoteByUser.get(authorKey);
      const counts = prev.pollVotes
        ? [...prev.pollVotes]
        : new Array<number>(optCount).fill(0);
      // Always retract the user's previous vote first.
      if (typeof oldIdx === "number" && oldIdx >= 0 && oldIdx < optCount) {
        counts[oldIdx] = Math.max(0, (counts[oldIdx] ?? 1) - 1);
      }
      if (idx < 0 || idx >= optCount) {
        // Withdrawal: an out-of-range index (the UI sends -1 when you click
        // your current choice again) means "retract my vote".
        prev._pollVoteByUser.delete(authorKey);
        if (r.fromMe) prev.myPollVote = undefined;
      } else {
        counts[idx] = (counts[idx] ?? 0) + 1;
        prev._pollVoteByUser.set(authorKey, idx);
        if (r.fromMe) prev.myPollVote = idx;
      }
      prev.pollVotes = counts;
      continue;
    }

    if (p.kind === "edit" && p.refCid) {
      const prev = byCid.get(p.refCid);
      if (!prev) continue;
      // Integrity: only the ORIGINAL author may edit their own message.
      // Frames are E2EE-authenticated to their sender, so reject an edit
      // whose sender differs from the target's author — otherwise a group
      // member (or a DM peer) could rewrite someone else's message.
      const prevAuthorKey = prev.fromMe ? "__me__" : prev.fromUserId ?? "peer";
      if (prevAuthorKey !== authorKey) continue;
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
      // Integrity: only the original author may delete their own message
      // (see edit above). Block forged deletes of others' messages.
      const prevAuthorKey = prev.fromMe ? "__me__" : prev.fromUserId ?? "peer";
      if (prevAuthorKey !== authorKey) continue;
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
    const { _reactByUser, _pollVoteByUser, ...rest } = m;
    void _reactByUser;
    void _pollVoteByUser;
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
