// The build id arrives as ?v=<buildId> on the registration URL (see
// src/main.tsx) — sw.js is a static file, so it can't be stamped at build time
// the way the bundles are. Scoping the asset cache per build is what makes a
// deploy actually evict the previous build's hashed chunks instead of letting
// them pile up forever under one fixed key.
const BUILD_ID = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE_NAME = `dk-pos-${BUILD_ID}`;
const API_CACHE_NAME = 'dk-api-v1';

// GET API endpoints eligible for stale-while-revalidate caching
const CACHEABLE_API_PATTERNS = [
  '/api/menu/categories',
  '/api/menu/items',
  '/api/menu/items/popular',
  '/api/menu/categories/suggested-order',
  '/api/modifiers/items-with-modifiers',
  '/api/combos',
  '/api/order-templates',
];

function isApiCacheable(url) {
  return CACHEABLE_API_PATTERNS.some((p) => url.pathname.startsWith(p));
}

// Install: do NOT skip waiting.
//
// A new worker seizing control of an already-running tab is actively harmful
// here: the old page still asks for the previous build's chunk hashes, which no
// longer exist in dist/, so lazy imports 404 and the screen dies mid-shift. The
// new worker waits until the page reloads into the matching build, and the
// client tells it to take over then (applyAppUpdate in src/lib/appUpdate.ts).
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Activate: clean old caches, claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== API_CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch handler
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle http/https requests (skip chrome-extension://, etc.)
  if (!url.protocol.startsWith('http')) return;

  // Skip non-GET requests (POST/PUT can't be cached)
  if (request.method !== 'GET') return;

  // Admin API requests: always network-only (not under /api prefix)
  if (url.pathname.startsWith('/admin')) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(JSON.stringify({ error: 'Offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    return;
  }

  // GET API requests: stale-while-revalidate for cacheable endpoints
  if (url.pathname.startsWith('/api')) {
    if (isApiCacheable(url)) {
      event.respondWith(staleWhileRevalidate(request));
    } else {
      // Non-cacheable API: network only
      event.respondWith(
        fetch(request).catch(() =>
          new Response(JSON.stringify({ error: 'Offline' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      );
    }
    return;
  }

  // HTML navigation requests (/, /index.html): network-first
  // This ensures new deploys are picked up immediately
  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Static assets (JS/CSS with content hashes): cache-first
  event.respondWith(cacheFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Last resort: try cached root
    const root = await cache.match('/');
    if (root) return root;
    return new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(API_CACHE_NAME);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    fetchPromise;
    return cached;
  }

  const networkResponse = await fetchPromise;
  if (networkResponse) return networkResponse;

  return new Response(JSON.stringify({ error: 'Offline' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}
