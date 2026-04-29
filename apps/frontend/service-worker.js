const BUILD_SHA = "__CHATVIEW_BUILD_SHA__";
const CACHE_PREFIX = "chatview-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_SHA || "dev"}`;
const SHELL_URL = "/";
const CORE_ASSETS = [SHELL_URL, "/manifest.webmanifest", "/app-icon.svg"];
const NETWORK_ONLY_PREFIXES = ["/api/", "/clo/"];

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      cleanupOldCaches(),
      self.clients.claim(),
    ]),
  );
});

self.addEventListener("message", (event) => {
  const message = event.data || {};
  if (message.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
    return;
  }

  if (message.type === "GET_VERSION") {
    event.ports?.[0]?.postMessage({
      type: "VERSION",
      buildSha: BUILD_SHA,
      cacheName: CACHE_NAME,
    });
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isResetRequest(url)) {
    event.respondWith(resetOfflineShell(request));
    return;
  }

  if (isNetworkOnly(url)) return;

  if (request.mode === "navigate" || request.destination === "document") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isCacheableAsset(request, url)) {
    event.respondWith(cacheFirstAsset(request));
  }
});

async function precacheShell() {
  const cache = await caches.open(CACHE_NAME);
  const shellResponse = await fetch(SHELL_URL, {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!shellResponse.ok) throw new Error(`shell precache failed: ${shellResponse.status}`);

  await cache.put(SHELL_URL, shellResponse.clone());
  const shellHtml = await shellResponse.text();
  const assets = uniqueUrls([...CORE_ASSETS, ...extractSameOriginAssets(shellHtml)]);
  await Promise.all(assets.map((assetUrl) => cacheAsset(cache, assetUrl)));
}

async function cacheAsset(cache, assetUrl) {
  try {
    const response = await fetch(assetUrl, {
      cache: "reload",
      credentials: "same-origin",
    });
    if (response.ok) await cache.put(assetUrl, response);
  } catch (error) {
    console.warn("[chatview-sw] asset precache failed", assetUrl, error);
  }
}

function extractSameOriginAssets(html) {
  const assets = [];
  const pattern = /\b(?:href|src)=["']([^"']+)["']/g;
  let match;
  while ((match = pattern.exec(html))) {
    const raw = match[1];
    if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) continue;
    const url = new URL(raw, self.location.origin);
    if (url.origin !== self.location.origin) continue;
    if (isNetworkOnly(url)) continue;
    if (url.pathname === "/service-worker.js") continue;
    assets.push(url.pathname + url.search);
  }
  return assets;
}

function uniqueUrls(urls) {
  return [...new Set(urls.map((url) => new URL(url, self.location.origin).pathname + new URL(url, self.location.origin).search))];
}

async function cleanupOldCaches() {
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)),
  );
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (response.ok && isHtmlResponse(response)) await cache.put(SHELL_URL, response.clone());
    return response;
  } catch {
    const cached = await cache.match(SHELL_URL);
    if (cached) return cached;
    throw new Error("offline shell is not cached");
  }
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request, {
    cache: "reload",
    credentials: "same-origin",
  });
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function resetOfflineShell(request) {
  await cleanupChatviewCaches();
  await self.registration.unregister();
  try {
    return await fetch(request, {
      cache: "reload",
      credentials: "same-origin",
    });
  } catch {
    return new Response("Chatview offline shell reset. Reconnect and reload this page.", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

async function cleanupChatviewCaches() {
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name.startsWith("chatview-")).map((name) => caches.delete(name)));
}

function isHtmlResponse(response) {
  return response.headers.get("content-type")?.includes("text/html");
}

function isResetRequest(url) {
  return url.searchParams.get("reset-sw") === "1" || url.searchParams.get("resetServiceWorkers") === "1";
}

function isNetworkOnly(url) {
  return NETWORK_ONLY_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

function isCacheableAsset(request, url) {
  if (url.pathname === "/service-worker.js") return false;
  if (CORE_ASSETS.includes(url.pathname)) return true;
  return ["font", "image", "manifest", "script", "style"].includes(request.destination);
}
