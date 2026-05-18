// Vermillion Slayers — service worker for offline play.
//
// v17.3.14-3: smart auto-update flow. The page asks this SW for its
// cached BUILD_ID via postMessage; if it doesn't match the live page's
// BUILD_ID, the page tells us to CLEAR_CACHES and reloads. Friends
// never need to manually clear anything.
//
// Strategy:
//   - HTML (index.html and "/"): NETWORK-FIRST. A fresh deploy is picked
//     up immediately. Falls back to cache only when offline.
//   - Manifest, icons, Leaflet CDN: cache-first.
//   - ArcGIS map tiles: network-first with cache fallback.
//   - On message {type:'GET_BUILD_ID'}: reply with the BUILD_ID parsed
//     out of the cached index.html.
//   - On message {type:'CLEAR_CACHES'}: nuke all caches.
//   - On message {type:'SKIP_WAITING'}: activate new SW immediately.
//   - On path `/sw-kill`: backup nuclear option (unregister + clear).

const CACHE_VERSION = 'vs-v17.3.14-3';
const CORE_CACHE = `${CACHE_VERSION}-core`;
const TILE_CACHE = `${CACHE_VERSION}-tiles`;

const STATIC_ASSETS = [
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CORE_CACHE).then((cache) => {
      return Promise.all(
        STATIC_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] failed to pre-cache', url, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
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

self.addEventListener('message', (event) => {
  const msg = event.data || {};

  if (msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (msg.type === 'CLEAR_CACHES') {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map(k => caches.delete(k))))
    );
    return;
  }

  if (msg.type === 'GET_BUILD_ID') {
    const port = event.ports && event.ports[0];
    if (!port) return;
    extractCachedBuildId().then((buildId) => {
      port.postMessage({ buildId });
    }).catch(() => {
      port.postMessage({ buildId: null });
    });
    return;
  }
});

async function extractCachedBuildId() {
  const cache = await caches.open(CORE_CACHE);
  const candidates = [
    './',
    './index.html',
    self.registration && self.registration.scope,
    self.registration && (self.registration.scope + 'index.html'),
  ].filter(Boolean);
  for (const url of candidates) {
    const res = await cache.match(url).catch(() => null);
    if (res) {
      const text = await res.clone().text().catch(() => '');
      const m = text.match(/const BUILD_ID\s*=\s*['"]([^'"]+)['"]/);
      if (m) return m[1];
    }
  }
  return null;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.pathname.endsWith('/sw-kill')) {
    event.respondWith(killSwitch());
    return;
  }

  const isSameOrigin = url.origin === self.location.origin;
  const isHTML = isSameOrigin && (
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('.html') ||
    req.mode === 'navigate'
  );

  if (isHTML) {
    event.respondWith(networkFirst(req, CORE_CACHE));
    return;
  }

  if (url.hostname.includes('arcgisonline.com')) {
    event.respondWith(networkFirst(req, TILE_CACHE));
    return;
  }

  if (
    url.hostname.includes('cloudflare.com') ||
    isSameOrigin
  ) {
    event.respondWith(cacheFirst(req, CORE_CACHE));
    return;
  }
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

async function killSwitch() {
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
  if (self.registration) {
    self.registration.unregister().catch(() => {});
  }
  const html = `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Reset complete</title>
  <style>
    body{font-family:-apple-system,sans-serif;background:#0a3020;color:#c9a227;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}
    h1{font-size:22px;margin-bottom:12px}
    p{color:#8bbf8b;font-size:14px;line-height:1.6;max-width:340px;margin:0 auto}
    a{color:#e8c547}
  </style>
</head><body>
  <div>
    <h1>🧹 Cache cleared</h1>
    <p>Service worker unregistered and all caches purged. Close this tab completely and reopen the game URL in a new tab to load a fresh copy.</p>
    <p style="margin-top:20px"><a href="./">← Reload the game</a></p>
  </div>
</body></html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
