# VaultChat Security Roadmap

VaultChat remains a browser-first app. That means every page load can receive new
JavaScript from the host, so claims must stay below audited native messengers
until the release pipeline changes.

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

## Claims Boundary

Do not market VaultChat as "better than Signal" without:

- independent cryptographic audit,
- independent implementation audit,
- reproducible native builds,
- signed update pipeline,
- published release hashes,
- reviewed operational runbook for server and TURN infrastructure.
