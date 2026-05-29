/* eslint-env serviceworker */
/* global self, caches, fetch, clients */
/**
 * VaultChat Service Worker — minimal offline-resilient asset cache.
 *
 * What it does:
 *  - Caches the immutable hashed JS/CSS chunks Vite emits, so a reload
 *    while offline (or during a Render-Free cold-start) still paints.
 *  - Never caches /api/* or /ws — those must always hit the network
 *    (E2EE-relay, no offline fallback is meaningful).
 *  - Uses a cache name that includes a build tag so a new deploy
 *    forces a fresh cache and old entries get cleaned up in activate.
 *
 * What it deliberately does NOT do (yet):
 *  - Background-sync, push-notifications, periodic-sync. Those are
 *    separate features and need server-side wiring.
 *  - Pin a script hash and refuse to load a mismatched chunk. The
 *    existing Subresource-Integrity (vite-plugin-sri.ts) does that
 *    at <script integrity=…> level already; SW-level pinning would
 *    double up.
 */

const BUILD_TAG = "vaultchat-2026-06";
const STATIC_CACHE = `${BUILD_TAG}-static-v1`;

self.addEventListener("install", (event) => {
  // Sofort aktiv werden, kein "skipWaiting" auf User-Geste warten.
  self.skipWaiting();
  event.waitUntil(caches.open(STATIC_CACHE));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("vaultchat-") && k !== STATIC_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

function shouldCache(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/api/")) return false;
  if (url.pathname.startsWith("/ws")) return false;
  if (url.pathname.startsWith("/healthz") || url.pathname.startsWith("/readyz"))
    return false;
  // Vite-Build emits hashed names under /assets/.
  if (url.pathname.startsWith("/assets/")) return true;
  // index.html, favicon, manifest, etc.
  if (url.pathname === "/" || url.pathname.endsWith(".html")) return true;
  if (/\.(css|js|woff2?|svg|png|ico|webmanifest)$/i.test(url.pathname)) {
    return true;
  }
  return false;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (!shouldCache(url)) return;

  // Hashed assets sind immutable → cache-first. Index/HTML → network-first
  // mit cache-fallback (damit ein neuer Build sofort sichtbar wird, aber
  // ein offline-Reload trotzdem klappt).
  const isHashedAsset = url.pathname.startsWith("/assets/");

  if (isHashedAsset) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(req, res.clone());
          return res;
        } catch (e) {
          if (cached) return cached;
          throw e;
        }
      })()
    );
    return;
  }

  // HTML / Root: network-first.
  event.respondWith(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch (e) {
        const cached = await cache.match(req);
        if (cached) return cached;
        throw e;
      }
    })()
  );
});
