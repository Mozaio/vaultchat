# Roadmap: tRPC-Migration (Express + raw fetch → tRPC mit WebSocket-Subscriptions)

Status: **Plan only.** Aufwand ~2 Wochen.

## Problem

- Server: Express mit handgeschriebenen `app.get/post(...)` und Zod-Validation pro Handler.
- Client: `lib/api.ts` macht `fetch()`-Calls, jeden Endpunkt manuell typisiert.
- Drift zwischen Server-Schema und Client-Type ist möglich (CI fängt das nicht ab).
- WebSocket-Frames sind JSON-Blobs ohne typed Wire-Contract — `wsHub.ts` und `ChatShell.tsx` müssen manuell parsen und kasten.

## Ziel

End-to-end typesafe API mit:
- Eine einzige `AppRouter`-Definition im Server.
- Client importiert typed Stubs ohne manuelle Definition.
- Subscriptions via WebSocket (typed) ersetzen das ad-hoc WS-JSON-Protokoll.

## Migrationspfad

### Phase 1 — tRPC-Setup parallel zu Express (1 Tag)

```ts
// server/src/trpc/router.ts
import { initTRPC } from '@trpc/server';
import { z } from 'zod';

const t = initTRPC.context<{ userId?: string }>().create();
const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.userId) throw new Error('UNAUTHORIZED');
  return next({ ctx });
});

export const appRouter = t.router({
  user: t.router({
    me: protectedProcedure.query(({ ctx }) => findUserById(ctx.userId!)),
    search: protectedProcedure
      .input(z.object({ q: z.string().min(1) }))
      .query(({ input }) => listUsersSafe(input.q)),
  }),
  prekey: t.router({
    bundle: protectedProcedure
      .input(z.object({ userId: z.string().uuid() }))
      .query(({ input }) => getPreKeyBundle(input.userId)),
    upload: protectedProcedure
      .input(z.object({ keys: z.array(z.string()) }))
      .mutation(({ ctx, input }) =>
        uploadOneTimePreKeys(ctx.userId!, input.keys)
      ),
  }),
  // ... ~25 weitere Endpunkte
});

export type AppRouter = typeof appRouter;
```

```ts
// server/src/index.ts
import { createExpressMiddleware } from '@trpc/server/adapters/express';

app.use('/trpc', createExpressMiddleware({
  router: appRouter,
  createContext: ({ req }) => ({ userId: getUserIdFromAuth(req) }),
}));
```

Bestehende Express-Routes bleiben → kein Big-Bang.

### Phase 2 — Client-Migration (Endpunkt für Endpunkt, ~1 Woche)

```ts
// client/src/trpc.ts
import { createTRPCProxyClient, httpBatchLink, wsLink, createWSClient, splitLink } from '@trpc/client';
import type { AppRouter } from '../../server/src/trpc/router';

const wsClient = createWSClient({ url: getWsUrl() + '/trpc' });

export const trpc = createTRPCProxyClient<AppRouter>({
  links: [
    splitLink({
      condition: (op) => op.type === 'subscription',
      true: wsLink({ client: wsClient }),
      false: httpBatchLink({ url: '/trpc' }),
    }),
  ],
});
```

Migration-Pattern pro Endpoint:
1. Endpoint im Router definieren.
2. Aufrufer von `api.foo(...)` auf `trpc.foo.query(...)` umstellen.
3. Wenn alle Aufrufer migriert sind: Express-Route + `lib/api.ts`-Funktion löschen.

### Phase 3 — WebSocket-Subscriptions (3-4 Tage)

Aktuelles WS-Protokoll:
```ts
ws.send(JSON.stringify({ type: 'dm', toUserId, envelope }));
ws.onmessage = (e) => {
  const f = JSON.parse(e.data);
  if (f.type === 'dm') { /* ... */ }
  if (f.type === 'group') { /* ... */ }
  if (f.type === 'rtc') { /* ... */ }
  // ...
};
```

Wird zu:
```ts
trpc.dm.send.mutate({ toUserId, envelope });

trpc.dm.inbox.subscribe(undefined, {
  onData: ({ envelope, fromHint }) => { /* ... */ },
});
trpc.rtc.signaling.subscribe(undefined, {
  onData: (frame) => { /* ... */ },
});
```

Subscriptions sind typed, keine Inhalte-Casts mehr in ChatShell.

### Phase 4 — Cleanup (1-2 Tage)

- `lib/api.ts` löschen.
- WS-JSON-Protokoll-Doku in `wsHub.ts` löschen.
- Express-Routes löschen.

## Was bleibt Express

- Static-Serving (vorerst, Vite handhabt Production-Static eh über Render-Static-Site).
- `/api/health` (Render-Healthcheck erwartet HTTP).
- Helmet/Rate-Limit-Middleware (vor tRPC-Adapter setzen).

## Aufwand

| Phase | Tage |
|---|---|
| 1. tRPC-Setup | 1 |
| 2. Client-Migration (~25 Endpunkte) | 5 |
| 3. WS-Subscriptions | 4 |
| 4. Cleanup + Tests | 2 |
| Buffer | 2 |
| **Total** | **~2 Wochen** |

## Vorteile nach Migration

- Refactor-Sicherheit: Server-Schema-Änderung schlägt sofort als TS-Fehler im Client durch.
- Weniger Boilerplate: keine doppelten Type-Definitionen.
- Bessere DX: Autocomplete in IDE über alle API-Calls.
- WebSocket-Subscriptions ersetzen das ad-hoc-JSON-Wire mit getyptem Contract.

## Risiken

- **tRPC v11 vs. v10**: Bündel-Größe Client. v11 ist nur ~5KB, akzeptabel.
- **Render-Free-Tier**: tRPC-Subscription-Heartbeats verbrauchen mehr Connections. Auf Standard-Tier upgraden, falls nötig.
- **Encrypt/Decrypt-Roundtrips**: tRPC-Subscriptions liefern bereits geparste JSON-Frames; die Krypto-Decryption darunter passiert weiterhin client-seitig (kein Effekt).
