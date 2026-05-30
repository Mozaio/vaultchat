# Group Metadata Privacy — Plan toward Signal-level (zkgroup)

> Status: **design / roadmap**. Implementation is phased and security-reviewed.
> Goal: hide group **membership** and **per-message sender** from the relay
> server, matching Signal's "Private Groups" (zkgroup) — **without homebrewing
> zero-knowledge crypto**.

## Why this document exists

Umbra's **content** privacy already matches Signal: the server only ever sees
ciphertext (Olm + Megolm), and the group **sender-key** model is now
Signal-equivalent (per-message ratchet, Ed25519 authenticity, and rotation on
**every** membership change → strict join-forward-secrecy). See `THREAT_MODEL.md`.

The remaining gap is **metadata**: what the *server* can learn.

## What the server learns today (current exposure)

| Item | Server sees it? | Where |
|---|---|---|
| Message **content** | ❌ ciphertext only | Megolm (E2EE) |
| Group **membership list** | ✅ plaintext, persisted to disk | `serverState` `memberIds` |
| **Who sent** a given group message | ✅ (authenticated WS + replay key + member check) | `index.ts` group handler |
| Group **name / avatar** | ✅ plaintext | `serverState` group record |
| Recipients (for fan-out) | ✅ (server must route) | fan-out loop |

So: **content is zero-knowledge; membership + sender + group name are not.**

## How Signal does it (accurately, briefly)

Signal "Private Groups" use the **Signal Private Group System** (Chase–Perrin–
Zaverucha, 2019): anonymous credentials over **Ristretto255** (KVAC — keyed
verification MACs) plus zero-knowledge proofs. Properties:
- The server issues each member an **auth credential** for the group.
- To act on the group, a member presents a **ZK proof** "I hold a valid
  credential for this group" — **without revealing which member**.
- Group state (member list, name, avatar) is stored **encrypted/blinded**; the
  server enforces rules over ciphertext via the credential system.
- Combined with **sealed sender**, the server cannot link a message to a sender
  nor enumerate the membership.

**Key point:** this is a *vetted, audited* construction. Re-implementing the
credential + proof protocol by hand is research-grade and the #1 way to ship a
subtle, catastrophic bug. **We will not homebrew it.** "Signal-level" means
using a vetted design and audited primitives — or honestly not claiming it yet.

## Phased plan (safe, incremental, reviewable)

### Phase 0 — Content + forward secrecy ✅ done
Olm/Megolm E2EE, sender-key rotation on add **and** remove, index-0 key so no
message is lost, key-request self-heal. **Signal-equivalent on the content axis.**

### Phase 1 — Encrypt group name/avatar (`#25`) — achievable, low risk
Store group name + avatar as a **ciphertext blob** the server can't read; only
members decrypt. Needs a **shared group secret** (a symmetric key distributed
like the Megolm key over Olm-1:1, rotated on membership change). Removes one
plaintext metadata item. **Recommended next concrete step.**

### Phase 2 — Hide the sender of group messages — large, tradeoff-dependent
Replace the identity-based member check on send with one of:
- **(a) Full zkgroup** — anonymous credentials over Ristretto255
  (`@noble/curves` provides *audited* Ristretto, but the KVAC credential +
  ZK-proof protocol on top is the hard, error-prone part). Research-grade;
  needs an external security review before shipping. Highest privacy, no abuse
  tradeoff.
- **(b) Unauthenticated sealed-sender for groups** — server fans out by
  `groupId` **without** authenticating the sender. Hides the sender, but anyone
  who learns a `groupId` can fan out *undecryptable* frames (members drop them
  as garbage via Megolm, but it is a spam/DoS vector). Achievable now; the
  tradeoff (weaker abuse-resistance) is a **product decision** and must be
  mitigated with rate limits + size caps + groupId being a high-entropy secret.
- Recommendation: **(a)** is the only "Signal-level" answer; treat it as a
  reviewed project. **(b)** is a stopgap only with explicit, informed opt-in.

### Phase 3 — Hide membership at rest
Store membership blinded so a server-disk compromise doesn't reveal who is in
which group (depends on Phase 2's credential system).

## Hard rule

No hand-rolled zero-knowledge / anonymous-credential crypto reaches `main`
without (1) audited primitives only, (2) a written protocol spec, (3) external
review. Until then we **honestly** state: content = Signal-level; group
metadata (membership/sender) = **not yet** Signal-level.

## Next concrete step

**Phase 1 (`#25`)**: encrypt group name + avatar with a shared, rotated group
secret. Real metadata win, no exotic crypto, fully testable. Start here.
