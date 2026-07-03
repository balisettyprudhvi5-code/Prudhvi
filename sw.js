/*
 * Smart Compress — Service Worker
 * ------------------------------------------------------------------
 * Strategy:
 *   - HTML (navigation requests, "/"):  NETWORK FIRST  -> always tries
 *     to fetch the newest deployed index.html; falls back to cache,
 *     then to the offline page, only when the network is unreachable.
 *   - Static assets (icons, manifest, CDN libraries, fonts): CACHE FIRST
 *     -> served instantly from cache, refreshed in the background.
 *
 * Versioning:
 *   Bump CACHE_VERSION on every deploy that changes STATIC_ASSETS.
 *   This guarantees old caches are wiped on activate(), so no stale
 *   asset can ever be served after a new release goes live.
 * ------------------------------------------------------------------
 */

const CACHE_VERSION = "v1.0.0";
const STATIC_CACHE = `smart-compress-static-${CACHE_VERSION}`;
const PAGES_CACHE = `smart-compress-pages-${CACHE_VERSION}`;
const OFFLINE_URL = "/offline.html";

// Everything here is safe to cache aggressively — none of it changes
// without a new CACHE_VERSION being shipped.
const STATIC_ASSETS = [
  "/manifest.webmanifest",
  "/offline.html",
  "/favicon.ico",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/apple-touch-icon.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-192.png",
  "/icons/icon-maskable-512.png",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
];

/* ---------------------------------------------------------------- */
/* INSTALL — pre-cache static assets. Stays WAITING until the page  */
/* tells us to take over (see the SKIP_WAITING message below), so   */
/* a visitor already using the app is never interrupted mid-session.*/
/* ---------------------------------------------------------------- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(STATIC_ASSETS.map((url) => new Request(url, { cache: "reload" }))).catch(() => {
        // Don't let one failed (e.g. offline) precache request block install.
      });
    })
  );
});

/* ---------------------------------------------------------------- */
/* ACTIVATE — delete every cache that doesn't match the current     */
/* version, then take control of all open tabs immediately.         */
/* ---------------------------------------------------------------- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name !== STATIC_CACHE && name !== PAGES_CACHE)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

/* ---------------------------------------------------------------- */
/* MESSAGE — the page's "Update Now" button sends SKIP_WAITING so   */
/* the new worker activates on demand instead of automatically.     */
/* ---------------------------------------------------------------- */
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING" || event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

/* ---------------------------------------------------------------- */
/* FETCH                                                            */
/* ---------------------------------------------------------------- */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never intercept analytics/ads/search-console beacons — let them
  // hit the network directly exactly as before.
  if (
    url.hostname.includes("google-analytics.com") ||
    url.hostname.includes("googletagmanager.com") ||
    url.hostname.includes("googlesyndication.com") ||
    url.hostname.includes("doubleclick.net") ||
    url.hostname.includes("adsbygoogle")
  ) {
    return;
  }

  const isNavigation =
    request.mode === "navigate" ||
    (request.method === "GET" &&
      request.headers.get("accept")?.includes("text/html"));

  if (isNavigation) {
    event.respondWith(networkFirst(request));
    return;
  }

  const isKnownStatic =
    STATIC_ASSETS.includes(request.url) ||
    url.origin === self.location.origin && (
      url.pathname.startsWith("/icons/") ||
      url.pathname === "/manifest.webmanifest" ||
      url.pathname === "/favicon.ico" ||
      /\.(png|jpg|jpeg|svg|webp|ico|woff2?|ttf|otf)$/.test(url.pathname)
    ) ||
    url.hostname === "cdnjs.cloudflare.com" ||
    url.hostname === "fonts.gstatic.com" ||
    url.hostname === "fonts.googleapis.com";

  if (isKnownStatic) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Anything else (cross-origin AI/API calls, etc.) — pass through to
  // the network untouched. Never cache dynamic/API responses.
  return;
});

/* ---------------------------------------------------------------- */
/* Strategy: NETWORK FIRST (used for index.html / navigations)      */
/* ---------------------------------------------------------------- */
async function networkFirst(request) {
  const cache = await caches.open(PAGES_CACHE);
  try {
    const fresh = await fetch(request, { cache: "no-store" });
    if (fresh && fresh.ok) {
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    const offline = await caches.match(OFFLINE_URL);
    if (offline) return offline;
    throw err;
  }
}

/* ---------------------------------------------------------------- */
/* Strategy: CACHE FIRST (used for static assets), with a silent    */
/* background revalidation so caches self-heal over time.           */
/* ---------------------------------------------------------------- */
async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);

  const networkFetch = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    // Serve instantly, refresh in the background.
    networkFetch;
    return cached;
  }

  const fresh = await networkFetch;
  if (fresh) return fresh;

  // Last resort — nothing cached and network failed.
  return new Response("", { status: 504, statusText: "Offline" });
}
