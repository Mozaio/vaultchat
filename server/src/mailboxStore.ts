import { randomUUID } from "node:crypto";

type MailboxDm = {
  id: string;
  toUserId: string;
  cid?: string;
  envelope: string;
  createdAt: number;
  expiresAt: number;
};

type MailboxGroup = {
  id: string;
  toUserId: string;
  groupId: string;
  ciphertext: string;
  createdAt: number;
  expiresAt: number;
};

const dmByRecipient = new Map<string, MailboxDm[]>();
const groupByRecipient = new Map<string, MailboxGroup[]>();

const DEFAULT_TTL_MS = Number(process.env.VAULTCHAT_MAILBOX_TTL_MS ?? 7 * 24 * 60 * 60 * 1000);
const MAX_PER_RECIPIENT = Number(process.env.VAULTCHAT_MAILBOX_MAX_PER_USER ?? 500);

export function enqueueMailboxDm(input: {
  toUserId: string;
  envelope: string;
  id?: string;
  cid?: string;
  createdAt?: number;
}): MailboxDm {
  const createdAt = input.createdAt ?? Date.now();
  const item: MailboxDm = {
    id: input.id ?? randomUUID(),
    toUserId: input.toUserId,
    ...(input.cid ? { cid: input.cid } : {}),
    envelope: input.envelope,
    createdAt,
    expiresAt: createdAt + DEFAULT_TTL_MS,
  };
  const list = (dmByRecipient.get(input.toUserId) ?? []).filter((x) => {
    if (x.expiresAt <= Date.now()) return false;
    return !input.cid || x.cid !== input.cid;
  });
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

export function listMailboxDms(userId: string): MailboxDm[] {
  const now = Date.now();
  const live = (dmByRecipient.get(userId) ?? []).filter((x) => x.expiresAt > now);
  if (live.length > 0) dmByRecipient.set(userId, live);
  else dmByRecipient.delete(userId);
  return [...live];
}

export function removeMailboxDm(userId: string, id: string): void {
  const now = Date.now();
  const live = (dmByRecipient.get(userId) ?? []).filter(
    (x) => x.id !== id && x.expiresAt > now
  );
  if (live.length > 0) dmByRecipient.set(userId, live);
  else dmByRecipient.delete(userId);
}

export function enqueueMailboxGroup(input: {
  toUserId: string;
  groupId: string;
  ciphertext: string;
  id?: string;
  createdAt?: number;
}): MailboxGroup {
  const createdAt = input.createdAt ?? Date.now();
  const item: MailboxGroup = {
    id: input.id ?? randomUUID(),
    toUserId: input.toUserId,
    groupId: input.groupId,
    ciphertext: input.ciphertext,
    createdAt,
    expiresAt: createdAt + DEFAULT_TTL_MS,
  };
  const list = (groupByRecipient.get(input.toUserId) ?? []).filter(
    (x) => x.expiresAt > Date.now()
  );
  list.push(item);
  while (list.length > MAX_PER_RECIPIENT) list.shift();
  groupByRecipient.set(input.toUserId, list);
  return item;
}

export function popMailboxGroups(userId: string): MailboxGroup[] {
  const now = Date.now();
  const list = groupByRecipient.get(userId) ?? [];
  groupByRecipient.delete(userId);
  return list.filter((x) => x.expiresAt > now);
}

export function listMailboxGroups(userId: string): MailboxGroup[] {
  const now = Date.now();
  const live = (groupByRecipient.get(userId) ?? []).filter((x) => x.expiresAt > now);
  if (live.length > 0) groupByRecipient.set(userId, live);
  else groupByRecipient.delete(userId);
  return [...live];
}

export function removeMailboxGroup(userId: string, id: string): void {
  const now = Date.now();
  const live = (groupByRecipient.get(userId) ?? []).filter(
    (x) => x.id !== id && x.expiresAt > now
  );
  if (live.length > 0) groupByRecipient.set(userId, live);
  else groupByRecipient.delete(userId);
}

export function getMailboxStats() {
  const now = Date.now();
  let queued = 0;
  for (const list of dmByRecipient.values()) {
    queued += list.filter((item) => item.expiresAt > now).length;
  }
  for (const list of groupByRecipient.values()) {
    queued += list.filter((item) => item.expiresAt > now).length;
  }
  return {
    recipients: new Set([...dmByRecipient.keys(), ...groupByRecipient.keys()]).size,
    queued,
    ttlMs: DEFAULT_TTL_MS,
    maxPerRecipient: MAX_PER_RECIPIENT,
  };
}
