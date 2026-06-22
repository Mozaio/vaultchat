# Umbra — What the server can and cannot see

> Plain-language transparency note. Umbra's relay server is a **zero-knowledge
> message relay**: it forwards ciphertext and the minimum routing data needed to
> deliver it. This page states honestly what that does and does **not** hide.
> Authoritative detail: `THREAT_MODEL.md`, `GROUP_METADATA_PRIVACY.md`.

## What the server NEVER sees

- **Message content** — text, files, voice notes, reactions, replies, edits,
  deletes, read/delivery receipts, polls. All of it is end-to-end encrypted
  (Olm for 1:1, Megolm for groups). The server only ever relays opaque
  ciphertext envelopes.
- **Who sent a DM** — sealed sender: a direct message carries only the
  recipient (`toUserId`) plus an opaque envelope. The sender is encrypted for
  the recipient only; the relay cannot tell who sent it.
- **Group message sender** — with sealed group sender (opt-in), group frames
  are relayed without a sender id; the sender is inside the E2EE payload.
- **Group name, description, avatar** — encrypted client-side with the group's
  master key (`GMETA1:` ciphertext, feature `#25`). At group creation the server
  is given a placeholder; it only ever stores ciphertext, never the real name.
- **Your message history** — stored only in your browser (IndexedDB), encrypted
  at rest under a key derived from your password. The server keeps no history.
- **Your password** — only an Argon2id hash is stored, never the password.
- **Your recovery email** (if set) — only a peppered hash is stored, not the
  address.

## What the server DOES see (and why)

- **Account directory** — your username, identity **public** key, account
  creation time, and plan tier. The username is needed so people can find and
  message you; the public key is public by design. (With `VAULTCHAT_STATE_KEY`
  set, this directory is additionally **encrypted at rest** on disk, so a stolen
  disk/backup reveals nothing — feature `0.1b`.)
- **Delivery routing** — for a DM, the recipient (`toUserId`); for a group, the
  member ids it must fan a message out to. The relay must know where to send
  ciphertext.
- **Group membership** — the member list of a group is currently **plaintext**
  on the server (it has to route to members). This is the main remaining
  metadata gap; the planned fix is a Signal-style zkgroup credential system
  (`ZKGROUP_SPEC.md`, `GROUP_METADATA_PRIVACY.md`), which is review-gated.
- **Connection metadata** — your IP address (stored in logs only as a salted,
  non-reversible tag), connection and message timing.
- **Ciphertext sizes** — payloads are padded to fixed buckets before encryption
  to blunt size-based fingerprinting, but approximate size is still observable.

## Honest limitations

- This is **not** an audited replacement for Signal/WhatsApp. The project is
  open source; an independent audit is recommended and not yet done.
- A malicious web host could serve modified client code on first load. Mitigations:
  Subresource Integrity, client-side bundle-hash pinning, and a CI pipeline that
  publishes the bundle's SHA-384 so you can verify it out-of-band (feature `0.5`).
  Full mitigation needs reproducible builds + independently published hashes.
- **Timing correlation** and **group membership** remain observable to the relay
  today. We state this rather than hide it.

_Last reviewed: 2026-06. This document is updated as the threat model changes._
