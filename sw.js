// Vermillion Slayers — service worker for offline play.
// Cache strategy:
//   - The HTML, manifest, and icons: cache-first, network fallback
//   - The Leaflet CDN: cache-first (versioned URL means safe to cache forever)
//   - ArcGIS map tiles: network-first, falling back to cache so previously-
//     viewed parts of the lake still appear without a connection
//   - Everything else: network passthrough
// Bump CACHE_VERSION whenever index.html changes — old caches get cleaned up
// on the next activation.

const CACHE_VERSION = 'vs-v17.3.13-1';
const CORE_CACHE = `${CACHE_VERSION}-core`;
const TILE_CACHE = `${CACHE_VERSION}-tiles`;

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
];

self.addEventListener('install', (event) => {
  // Pre-cache the core assets so the game works offline immediately.
  event.waitUntil(
    caches.open(CORE_CACHE).then((cache) => {
      // Cache opportunistically — if any single asset fails (e.g. the
      // CDN is down at install time), don't reject the whole install.
      return Promise.all(
        CORE_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] failed to cache', url, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  // Clean up old caches whenever we deploy a new version.
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CORE_CACHE && key !== TILE_CACHE) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // ArcGIS map tiles: network-first, fall back to cache.
  if (url.hostname.includes('arcgisonline.com')) {
    event.respondWith(networkFirst(req, TILE_CACHE));
    return;
  }

  // Core assets and Leaflet CDN: cache-first.
  if (
    url.hostname.includes('cloudflare.com') ||
    url.origin === self.location.origin
  ) {
    event.respondWith(cacheFirst(req, CORE_CACHE));
    return;
  }

  // Everything else: pass through.
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    // Last-ditch: return cached at all even if it's a stale match
    return cached || new Response('Offline', { status: 503 });
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const cached = await cache.match(req);
    return cached || new Response('Offline', { status: 503 });
  }
}
