# VaultChat Shared Crypto Core

The current web client keeps the crypto core in `client/src/lib`. Desktop and
mobile clients should use this same boundary before any security claims are
expanded.

## Core Boundary

- `doubleRatchet.ts`: message ratchet state, ordering, AEAD header binding.
- `x3dh.ts`: prekey shared-secret derivation for first-contact sessions.
- `drSession.ts`: persistence wrapper and X3DH prekey-frame integration.
- `sealedSender.ts`: anonymous envelope format around DM ratchet wires.
- `groupCrypto.ts`: group message encryption and key rotation primitives.
- `crypto.ts`: identity key generation, payload framing, local key wrapping.

UI, storage adapters, WebSocket transport, and platform notification code must
stay outside this core so the same primitives can be reused from native clients.

## Required Test Vector Classes

- X3DH sender/receiver shared-secret equality.
- First Double Ratchet bootstrap message decrypts across peers.
- Ratchet ordering rejects replay and large skipped-message windows.
- Sealed-sender envelope opens only for the intended recipient.
- Group key rotation prevents removed members from decrypting future messages.
- Expiry, edits, deletes, reactions, and receipts remain E2EE payloads.

The first automated anchors live in `client/src/lib/cryptoCore.test.ts`.
