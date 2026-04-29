import { randomUUID } from "node:crypto";

type MailboxDm = {
  id: string;
  toUserId: string;
  envelope: string;
  createdAt: number;
  expiresAt: number;
};

const dmByRecipient = new Map<string, MailboxDm[]>();

const DEFAULT_TTL_MS = Number(process.env.VAULTCHAT_MAILBOX_TTL_MS ?? 7 * 24 * 60 * 60 * 1000);
const MAX_PER_RECIPIENT = Number(process.env.VAULTCHAT_MAILBOX_MAX_PER_USER ?? 500);

export function enqueueMailboxDm(input: {
  toUserId: string;
  envelope: string;
  createdAt?: number;
}): MailboxDm {
  const createdAt = input.createdAt ?? Date.now();
  const item: MailboxDm = {
    id: randomUUID(),
    toUserId: input.toUserId,
    envelope: input.envelope,
    createdAt,
    expiresAt: createdAt + DEFAULT_TTL_MS,
  };
  const list = (dmByRecipient.get(input.toUserId) ?? []).filter(
    (x) => x.expiresAt > Date.now()
  );
  list.push(item);
  while (list.length > MAX_PER_RECIPIENT) list.shift();
  dmByRecipient.set(input.toUserId, list);
  return item;
}

export function popMailboxDms(userId: string): MailboxDm[] {
  const now = Date.now();
  const list = dmByRecipient.get(userId) ?? [];
  dmByRecipient.delete(userId);
  return list.filter((x) => x.expiresAt > now);
}

export function getMailboxStats() {
  const now = Date.now();
  let queued = 0;
  for (const list of dmByRecipient.values()) {
    queued += list.filter((item) => item.expiresAt > now).length;
  }
  return {
    recipients: dmByRecipient.size,
    queued,
    ttlMs: DEFAULT_TTL_MS,
    maxPerRecipient: MAX_PER_RECIPIENT,
  };
}
