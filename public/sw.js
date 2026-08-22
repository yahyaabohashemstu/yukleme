// ============================================
// Yükleme Yönetim Sistemi - Service Worker
// Version: 1.0.0
// ============================================

const CACHE_NAME = 'yukleme-cache-v79';
const DYNAMIC_CACHE = 'yukleme-dynamic-v79';

// Files to cache immediately on install
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/loader.html',
  '/manager.html',
  '/styles.css',
  '/icons.js',
  '/mobile-form.js',
  '/sw-update.js',
  '/products.json',
  '/products_tr_to_ar.json',
  '/manifest.json',
  '/offline.html',
  '/i18n.js',
  '/locales/tr.json',
  '/locales/ar.json',
  '/locales/en.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png'
];

// API routes that should use network-first strategy
const API_ROUTES = [
  '/api/loadings',
  '/api/my-loadings',
  '/api/check-auth'
];

// ============================================
// INSTALL EVENT
// ============================================
self.addEventListener('install', (event) => {
  console.log('[ServiceWorker] Installing...');

  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[ServiceWorker] Pre-caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => {
        console.log('[ServiceWorker] Install complete');
        // Skip waiting to activate immediately
        return self.skipWaiting();
      })
      .catch((error) => {
        console.error('[ServiceWorker] Pre-cache failed:', error);
      })
  );
});

// ============================================
// ACTIVATE EVENT
// ============================================
self.addEventListener('activate', (event) => {
  console.log('[ServiceWorker] Activating...');

  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            // Delete old caches
            if (cacheName !== CACHE_NAME && cacheName !== DYNAMIC_CACHE) {
              console.log('[ServiceWorker] Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => {
        console.log('[ServiceWorker] Claiming clients');
        // Take control of all pages immediately
        return self.clients.claim();
      })
  );
});

// ============================================
// FETCH EVENT
// ============================================
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip chrome-extension and other non-http requests
  if (!url.protocol.startsWith('http')) {
    return;
  }

  // Skip Supabase storage requests (legacy external images, if any remain)
  if (url.hostname.includes('supabase')) {
    return;
  }

  // Don't intercept locally-served uploads (photos/videos/thumbnails). They can
  // be large and change per-report — let the browser fetch them from network
  // (they carry a long immutable cache header, so the browser caches them anyway).
  if (url.pathname.startsWith('/uploads/')) {
    return;
  }

  // API requests: NETWORK ONLY. We deliberately do NOT cache API responses — they
  // are per-user, auth-sensitive data; a cached copy keyed only by URL could be
  // shown to a different user on a shared device, or shown stale. Offline -> 503.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkOnly(request));
    return;
  }

  // HTML / navigation requests: Network First so UI updates ship immediately
  const isHtmlRequest =
    request.mode === 'navigate' ||
    request.destination === 'document' ||
    url.pathname.endsWith('.html') ||
    url.pathname === '/';

  if (isHtmlRequest) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Other static assets (CSS, JS, icons, manifest): Cache First, fallback to network
  event.respondWith(cacheFirst(request));
});

// ============================================
// CACHING STRATEGIES
// ============================================

/**
 * Cache First Strategy
 * - Try cache first
 * - If not found, fetch from network and cache it
 * - On network failure, show offline page for navigation requests
 */
async function cacheFirst(request) {
  const cachedResponse = await caches.match(request);

  if (cachedResponse) {
    // Return cached version
    return cachedResponse;
  }

  try {
    // Try network
    const networkResponse = await fetch(request);

    // Cache successful responses
    if (networkResponse.ok) {
      const cache = await caches.open(DYNAMIC_CACHE);
      cache.put(request, networkResponse.clone());
    }

    return networkResponse;
  } catch (error) {
    // Network failed
    console.log('[ServiceWorker] Network failed for:', request.url);

    // For navigation requests, show offline page
    if (request.mode === 'navigate') {
      const offlinePage = await caches.match('/offline.html');
      if (offlinePage) {
        return offlinePage;
      }
    }

    // For other requests, return a simple error response
    return new Response('Offline', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: new Headers({
        'Content-Type': 'text/plain'
      })
    });
  }
}

/**
 * Network First Strategy
 * - Try network first
 * - On success, cache the response
 * - On failure, try cache
 */
async function networkFirst(request) {
  try {
    const networkResponse = await fetch(request);

    // Cache successful API responses
    if (networkResponse.ok) {
      const cache = await caches.open(DYNAMIC_CACHE);
      cache.put(request, networkResponse.clone());
    }

    return networkResponse;
  } catch (error) {
    console.log('[ServiceWorker] Network failed, trying cache for:', request.url);

    // Try cache
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }

    // For navigation requests, show offline page
    if (request.mode === 'navigate') {
      const offlinePage = await caches.match('/offline.html');
      if (offlinePage) {
        return offlinePage;
      }
    }

    // Return error response
    return new Response(JSON.stringify({ error: 'Çevrimdışı - Offline' }), {
      status: 503,
      statusText: 'Service Unavailable',
      headers: new Headers({
        'Content-Type': 'application/json'
      })
    });
  }
}

/**
 * Network Only Strategy (for /api/*)
 * - Always go to the network; NEVER read or write the cache.
 * - On failure (offline), return a clear 503 JSON — never stale/cross-user data.
 */
async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Çevrimdışı - Offline' }), {
      status: 503,
      statusText: 'Service Unavailable',
      headers: new Headers({ 'Content-Type': 'application/json' })
    });
  }
}

// ============================================
// BACKGROUND SYNC (for future use)
// ============================================
self.addEventListener('sync', (event) => {
  console.log('[ServiceWorker] Background sync:', event.tag);

  if (event.tag === 'sync-loadings') {
    // Future: sync pending loadings when back online
  }
});

// ============================================
// PUSH NOTIFICATIONS (for future use)
// ============================================
self.addEventListener('push', (event) => {
  console.log('[ServiceWorker] Push received');

  const options = {
    body: event.data ? event.data.text() : 'Yeni bildirim',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-72x72.png',
    vibrate: [100, 50, 100],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: 1
    },
    actions: [
      { action: 'view', title: 'Görüntüle' },
      { action: 'close', title: 'Kapat' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification('Yükleme Yönetim Sistemi', options)
  );
});

// Handle notification click
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'view') {
    event.waitUntil(
      clients.openWindow('/manager.html')
    );
  }
});

// ============================================
// MESSAGE HANDLER
// ============================================
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data && event.data.type === 'CLEAR_CACHE') {
    caches.keys().then((names) => {
      names.forEach((name) => caches.delete(name));
    });
  }
});

console.log('[ServiceWorker] Script loaded');
