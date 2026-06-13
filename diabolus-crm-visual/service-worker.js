// Diabolus PWA Service Worker
const CACHE_NAME = 'diabolus-v1';
const API_BASE = 'https://diabolus-crm-api.vercel.app';

const CACHE_URLS = [
  '/diabolus-crm/',
  '/diabolus-crm/index.html',
  '/diabolus-crm/dashboard.html',
  '/diabolus-crm/clientes.html',
  '/diabolus-crm/transacciones.html',
  '/diabolus-crm/reportes.html',
  '/diabolus-crm/js/config.js',
  '/diabolus-crm/manifest.json',
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/chart.js'
];

// Install event
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(CACHE_URLS).catch(() => {
        // Ignora errores de cache (algunos recursos pueden fallar)
        console.log('Cache precarga parcial completada');
      });
    })
  );
  self.skipWaiting();
});

// Activate event
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch event - Cache first, then network
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API calls: Network first, fall back to cache
  if (url.origin === API_BASE) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache successful API responses
          if (response.ok) {
            const clonedResponse = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, clonedResponse);
            });
          }
          return response;
        })
        .catch(() => {
          // Return cached response if network fails
          return caches.match(request);
        })
    );
    return;
  }

  // Static assets: Cache first, fall back to network
  event.respondWith(
    caches.match(request).then((response) => {
      return response || fetch(request)
        .then((response) => {
          // Cache new assets
          if (response.ok) {
            const clonedResponse = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, clonedResponse);
            });
          }
          return response;
        })
        .catch(() => {
          // Return offline page if available
          return new Response('Offline. Algunos datos no están disponibles.', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: new Headers({
              'Content-Type': 'text/plain'
            })
          });
        });
    })
  );
});

// Background sync (para intentos fallidos de API en offline)
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-api') {
    event.waitUntil(
      // Aquí iría lógica para reintentar API calls que fallaron offline
      Promise.resolve()
    );
  }
});
