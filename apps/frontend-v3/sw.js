// sync-v3 service worker — cache shell + assets so /v3 works offline.
//
// Strategy:
//   • install: pre-cache the shell HTML at "/" + a manifest of static
//     assets (icons / manifest). JS+CSS chunks come in via runtime
//     stale-while-revalidate.
//   • fetch: same-origin GET only.
//       /api/*, /clo/*       → network only (real-time, never cache)
//       navigation (mode=navigate) → network first, fall back to "/"
//       js/css/static       → stale-while-revalidate
//   • activate: drop caches from older builds, claim clients.
//
// Versioning: BUILD_SHA placeholder is replaced by server (cloudflared
// + clo-bootstrap). Each new deploy → new cache namespace → old caches
// purged on next activate.

const BUILD_SHA = "__CHATVIEW_BUILD_SHA__";
const CACHE_NAME = `chatview-v3-${BUILD_SHA || "dev"}`;
const SHELL = ["/", "/manifest.webmanifest", "/app-icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Best-effort: don't fail install if any asset is unavailable.
      await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("chatview-v3-") && n !== CACHE_NAME)
          .map((n) => caches.delete(n).catch(() => {})),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Real-time and management endpoints — never cache.
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/clo/")) return;
  if (url.pathname === "/service-worker.js" || url.pathname === "/sw-v3.js") return;

  // /v2 is the legacy client — let its own caching policy run.
  if (url.pathname.startsWith("/v2")) return;

  if (req.mode === "navigate") {
    event.respondWith(handleNavigation(req));
    return;
  }

  event.respondWith(handleAsset(req));
});

async function handleNavigation(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(req);
    if (response.ok && response.type === "basic") {
      cache.put("/", response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const cached = (await cache.match(req)) ?? (await cache.match("/"));
    if (cached) return cached;
    return new Response("offline", { status: 503, statusText: "offline" });
  }
}

async function handleAsset(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  // Stale-while-revalidate: return cached immediately if any, refresh in bg.
  const network = fetch(req)
    .then((response) => {
      if (response.ok && response.type === "basic") {
        cache.put(req, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);
  if (cached) {
    void network;
    return cached;
  }
  const fresh = await network;
  if (fresh) return fresh;
  return new Response("offline", { status: 503, statusText: "offline" });
}
