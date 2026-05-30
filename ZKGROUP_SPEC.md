# zkgroup for Umbra — implementable protocol spec (REVIEW REQUIRED)

> Status: **specification — not implemented as a live security boundary.**
> Goal: hide group **membership** and **per-message sender** from the relay
> server (Signal "Private Groups" level), using **audited primitives** and an
> **externally reviewed** protocol. This document is the kickoff artifact a
> cryptographer reviews before any code becomes the live boundary.

## 0. Hard gate (non-negotiable)
No anonymous-credential / zero-knowledge code becomes the **active** security
path without: (1) audited primitives only, (2) this spec frozen + reviewed by a
cryptographer, (3) known-answer test vectors passing in CI. Until then it ships
behind an **experimental flag, default off**, clearly labelled "unreviewed".

## 1. Threat model (what we add over today)
Today: content is E2EE (server sees ciphertext only) ✓; sender of a group
message is hidden via the opt-in sealed-sender (#26) ✓ — BUT the server still
stores the **membership list** and (without zkgroup) can't cryptographically
gate sends to members. zkgroup adds:
- Server **cannot enumerate** who is in a group.
- A sender proves **"I am a current member"** without revealing **which**.
- Anti-spam returns (sealed-sender's gap) because sends require a valid,
  unlinkable membership proof.

## 2. Reference design (do NOT reinvent)
Implement the **Signal Private Group System** (Chase, Perrin, Zaverucha, 2019 —
"The Signal Private Group System and Anonymous Credentials supporting Efficient
Verifiable Encryption"). It uses **KVAC** (keyed-verification anonymous
credentials) + sigma-protocol ZK proofs (Fiat–Shamir) over a prime-order group.
We do NOT design our own scheme; we implement that paper's construction. (Cite,
don't copy: the equations are taken verbatim from the paper during impl, then
cross-checked against `libsignal`'s `zkgroup` as a reference oracle for test
vectors.)

## 3. Primitives (audited only)
- **Group:** Ristretto255 via **`@noble/curves`** (audited; add as a client+
  server dependency). Provides constant-time scalar mult + point ops.
- **Hashing / Fiat–Shamir transcript:** SHA-512 / `@noble/hashes` (already
  transitive via `@noble/post-quantum`).
- **Symmetric:** existing libsodium `crypto_secretbox` (for the group's
  verifiable-encryption payloads).
- **Group Master Key (GMK):** the existing `groupSecret.ts` foundation — the
  group's secret params are DERIVED from the GMK (HKDF domain-separated). This
  is exactly why we built the GMK first: zkgroup sits on top of it.

## 4. Roles & state
- **Server (issuer/verifier):** holds a KVAC server key pair. Issues auth
  credentials; verifies presentation proofs; stores group state as
  **encrypted member entries** (UID-ciphertexts), never plaintext UIDs.
- **Client (member):** holds its credential + the group secret params (from
  GMK). Produces presentation proofs to send/act.

## 5. Protocol flows (to be filled with the paper's exact equations under review)
1. **Group create:** deriver computes group public params from the GMK; uploads
   only public params + encrypted member entries to the server.
2. **Add member:** an admin adds an encrypted UID entry; the new member is
   issued an auth credential against the group params.
3. **Credential issuance:** blinded issuance so the server signs a credential it
   cannot link to the member's identity on later presentation.
4. **Send / act (membership proof):** the member attaches a ZK presentation
   proof to the (sealed) send; the server verifies membership **without learning
   identity**, then fans out. Replaces the plaintext `memberIds.includes(...)`
   check used by the current sealed endpoint.
5. **Remove member:** rotate group params (new epoch); re-issue credentials to
   remaining members (composes with our existing rotate-on-membership-change).

## 6. Integration points in this repo
- `client/src/lib/groupSecret.ts` → derive zkgroup secret params (HKDF).
- New `client/src/lib/zkgroup.ts` (experimental) → credential + proof logic on
  `@noble/curves`. Pure, heavily unit-tested against `libsignal` test vectors.
- `server/src/zkgroupVerify.ts` (experimental) → KVAC verify + issuance.
- `POST /api/groups/:id/sealed` (#26) → gate on a valid presentation proof
  instead of being fully open (closes the spam tradeoff).
- Encrypted member storage replaces plaintext `memberIds` (server can still
  fan-out to device routing, but not enumerate identities) — biggest server
  change; phased.

## 7. Risks (why review is mandatory)
- A wrong proof equation → **silent** total break (forge membership, or the
  unlinkability fails and the server CAN link sender = *false* privacy).
- Non-constant-time scalar handling → key leakage. (`@noble` mitigates, our glue
  must too.)
- Transcript/Fiat–Shamir mistakes → proof malleability.
- These are exactly the failure modes that require **test vectors + external
  cryptographer review** before going live.

## 8. Phased plan
- **P0 (done):** GMK foundation (`groupSecret.ts`), sealed-sender (#26, opt-in),
  this spec.
- **P1:** add `@noble/curves`; implement KVAC issue/verify + presentation in
  `zkgroup.ts`/`zkgroupVerify.ts` as pure modules with **known-answer tests vs
  libsignal vectors** (CI must run them). NOT wired to any live path.
- **P2:** external cryptographer review of P1 + this spec. Freeze.
- **P3:** wire the membership proof into the sealed endpoint behind the
  experimental flag; dogfood.
- **P4:** encrypted member storage; flip flag on by default after audit sign-off.

## 9. Honest status line for users
Until P2 sign-off: "Group **content** is Signal-level E2EE; the **sender** can be
hidden from the server (opt-in sealed-sender); full **membership** privacy
(zkgroup) is in review and not yet active."
