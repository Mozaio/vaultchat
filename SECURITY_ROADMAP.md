# VaultChat Security Roadmap

VaultChat remains a browser-first app. That means every page load can receive new
JavaScript from the host, so claims must stay below audited native messengers
until the release pipeline changes.

For the **per-component audit status** (which libs are audited, which
code paths are still self-rolled), see [`SECURITY_AUDIT_STATUS.md`](./SECURITY_AUDIT_STATUS.md).
That document also describes the planned migration to **Olm + Megolm**
(auditeted DR/Group implementations from Matrix.org) over the
self-rolled `doubleRatchet.ts` / `x3dh.ts` / `groupCrypto.ts`.

## Native And Signed Releases

1. Extract a shared crypto core used by web, desktop, and mobile clients.
2. Add deterministic test vectors for envelopes, Double Ratchet state changes,
   expiry frames, edits, deletes, reactions, read receipts, and group key
   rotation.
3. Ship desktop/mobile builds as signed artifacts with OS keychain integration
   for local secrets.
4. Publish build hashes out-of-band and require signature verification before
   auto-update.
5. Move toward reproducible builds with pinned Node/toolchain versions,
   `npm ci`, fixed Docker images, and documented `SOURCE_DATE_EPOCH` handling.

## Current Web Mitigations

- `CRYPTO_CORE.md` defines the shared boundary that desktop/mobile clients must
  reuse instead of forking crypto behavior.
- Strict server headers, SRI for built assets, and immutable asset caching.
- Code-hash pinning now blocks unlock on mismatches until the user deliberately
  trusts and re-pins the new bundle.
- Identity backups export as encrypted bundles instead of cleartext identity
  JSON.
- WebSocket tokens are sent in the first auth frame, not in URLs that can land
  in proxy/browser logs.
- Relay-only calls suppress STUN fallback and non-relay candidates when forced.
