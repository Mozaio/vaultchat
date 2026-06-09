import { randomUUID } from "node:crypto";

type MailboxDm = {
  id: string;
  toUserId: string;
  /** Client-outbox cid — dedupliziert Mailbox-Einträge pro Empfänger. */
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

/**
 * Byte-Budget pro Empfänger UND Liste (DM/Group getrennt). Ohne dieses Cap
 * könnte ein Angreifer 500 × 16-MB-Frames an einen Offline-User queuen und
 * den RAM-only-Store (Render Free: ~512 MB) per OOM abschießen. Base64-
 * Stringlänge ≈ Payload-Bytes — als konservative Näherung ausreichend.
 */
const MAX_BYTES_PER_RECIPIENT = Number(
  process.env.VAULTCHAT_MAILBOX_PER_USER_BYTES ?? 48 * 1024 * 1024
);

/** FIFO-Trim auf Count- und Byte-Budget; gibt die Liste zurück. */
function trimToBudget<T extends { envelope?: string; ciphertext?: string }>(list: T[]): T[] {
  const sizeOf = (x: T) => (x.envelope ?? x.ciphertext ?? "").length;
  let bytes = 0;
  for (const x of list) bytes += sizeOf(x);
  while (list.length > 0 && (list.length > MAX_PER_RECIPIENT || bytes > MAX_BYTES_PER_RECIPIENT)) {
    const dropped = list.shift();
    if (dropped) bytes -= sizeOf(dropped);
  }
  return list;
}

export function enqueueMailboxDm(input: {
  toUserId: string;
  envelope: string;
  id?: string;
  cid?: string;
  createdAt?: number;
}): MailboxDm | null {
  const createdAt = input.createdAt ?? Date.now();
  const list = (dmByRecipient.get(input.toUserId) ?? []).filter(
    (x) => x.expiresAt > Date.now()
  );
  if (input.cid && list.some((x) => x.cid === input.cid)) {
    return null;
  }
  const item: MailboxDm = {
    id: input.id ?? randomUUID(),
    toUserId: input.toUserId,
    ...(input.cid ? { cid: input.cid } : {}),
    envelope: input.envelope,
    createdAt,
    expiresAt: createdAt + DEFAULT_TTL_MS,
  };
  list.push(item);
  trimToBudget(list);
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

/**
 * Drop a user's entire inbox (DM + group), e.g. on account deletion, so no
 * queued ciphertext addressed to the departed user lingers server-side.
 * Messages they SENT live in other recipients' boxes and are intentionally
 * left for delivery.
 */
export function clearMailboxForUser(userId: string): void {
  dmByRecipient.delete(userId);
  groupByRecipient.delete(userId);
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
  trimToBudget(list);
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
  let queuedBytes = 0;
  for (const list of dmByRecipient.values()) {
    for (const item of list) {
      if (item.expiresAt > now) {
        queued += 1;
        queuedBytes += item.envelope.length;
      }
    }
  }
  for (const list of groupByRecipient.values()) {
    for (const item of list) {
      if (item.expiresAt > now) {
        queued += 1;
        queuedBytes += item.ciphertext.length;
      }
    }
  }
  return {
    recipients: new Set([...dmByRecipient.keys(), ...groupByRecipient.keys()]).size,
    queued,
    queuedBytes,
    ttlMs: DEFAULT_TTL_MS,
    maxPerRecipient: MAX_PER_RECIPIENT,
    maxBytesPerRecipient: MAX_BYTES_PER_RECIPIENT,
  };
}

/**
 * Periodischer Sweep: räumt expired Mailbox-Einträge auf, ohne darauf zu
 * warten, dass jemand list/pop aufruft. Wichtig für inaktive Recipients,
 * deren Lists sonst die TTL überschreiten und Speicher belegen bis der
 * User irgendwann wiederkommt (oder nie).
 *
 * Returns {removed, recipientsRemoved} damit die Aufrufer-Seite das in
 * einen sweep-Log packen kann.
 */
export function sweepExpiredMailbox(): {
  removedDms: number;
  removedGroups: number;
  recipientsCleared: number;
} {
  const now = Date.now();
  let removedDms = 0;
  let removedGroups = 0;
  let recipientsCleared = 0;

  for (const [userId, list] of dmByRecipient) {
    const live = list.filter((x) => x.expiresAt > now);
    removedDms += list.length - live.length;
    if (live.length === 0) {
      dmByRecipient.delete(userId);
      recipientsCleared += 1;
    } else if (live.length < list.length) {
      dmByRecipient.set(userId, live);
    }
  }
  for (const [userId, list] of groupByRecipient) {
    const live = list.filter((x) => x.expiresAt > now);
    removedGroups += list.length - live.length;
    if (live.length === 0) {
      groupByRecipient.delete(userId);
    } else if (live.length < list.length) {
      groupByRecipient.set(userId, live);
    }
  }

  return { removedDms, removedGroups, recipientsCleared };
}
