# VaultChat Product Readiness

VaultChat should be treated as a security product, not a demo. This file tracks
the product gates that must be true before public production use.

## Production Profile

Run production deployments with:

```bash
VAULTCHAT_DEPLOYMENT_PROFILE=production
NODE_ENV=production
```

In this profile the server fails fast unless:

- `VAULTCHAT_JWT_SECRET` is set and strong enough.
- `VAULTCHAT_EMAIL_HASH_SECRET` is set separately if optional recovery email is enabled.
- CORS, client, and connect origins are explicit.
- Account/group/prekey state is persistent via `VAULTCHAT_STATE_FILE`, unless
  ephemeral state is deliberately accepted with `VAULTCHAT_ALLOW_EPHEMERAL_STATE=1`.
- `VAULTCHAT_FORCE_RELAY=1` is backed by a configured TURN server.
- Open registration is explicitly allowed, or registration is invite-only/closed.

## Operational Checks

- `/healthz` only proves the process is alive.
- `/readyz` proves production configuration and state writability.
- `/api/server/status` gives authenticated clients non-secret runtime status:
  state mode, queue counts, prekey counts, WebSocket counts, and privacy flags.

## Deployment Recommendation

For a real product launch, use `docker-compose.prod.yml` or an equivalent
orchestrator with a persistent volume mounted at `/data`. Render Free remains a
preview target only because it has an ephemeral filesystem and no persistent
disk support.

## Next Product Gates

1. Replace JSON file state with a transactional database for accounts, groups,
   and prekey bundles.
2. Move invite-code issuance and revocation into an admin workflow instead of
   static environment variables.
3. Add Playwright multi-browser E2E tests for registration, contact discovery,
   X3DH first message, offline mailbox delivery, group rotation, and key-change
   warnings.
4. Build signed desktop/mobile clients with OS keychain storage before making
   Signal-level claims.
5. Add a TURN deployment/runbook and make relay-only calls the production
   default once TURN is healthy.
6. Add release signing, reproducible build notes, and independent audit prep.
