// sw.js — Diabolus PWA Service Worker
// Estrategia: Cache-first para el app shell; Network-only para /api/*
// Offline: muestra offline.html honesto, sin simular acciones.

const CACHE_NAME = 'diabolus-shell-v1';

// App shell — lo que se precarga al instalar el SW
const SHELL_URLS = [
  '/chat.html',
  '/dashboard.html',
  '/index-login.html',
  '/transactions.html',
  '/invoices.html',
  '/clients.html',
  '/onboarding.html',
  '/register.html',
  '/reports.html',
  '/api-client.js',
  '/manifest.json',
  '/offline.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
];

// ── Install: precarga el shell ──────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // addAll falla si alguna URL falla; usamos add individual para ser resilientes
      return Promise.allSettled(
        SHELL_URLS.map((url) => cache.add(url).catch(() => { /* silencio: no bloquea */ }))
      );
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: limpia caches viejas ─────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1) API calls → siempre red. Nunca caché. Si falla: el UI gestiona el error.
  if (
    url.hostname !== self.location.hostname ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/telegram/') ||
    url.pathname.startsWith('/webhooks/')
  ) {
    event.respondWith(fetch(request));
    return;
  }

  // 2) Navegación (HTML) → intenta red primero (contenido fresco);
  //    si no hay red, sirve desde caché; si tampoco está en caché, offline.html
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Guarda copia fresca en cache
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() =>
          caches.match(request).then(
            (cached) => cached || caches.match('/offline.html')
          )
        )
    );
    return;
  }

  // 3) Otros assets estáticos → cache-first, network fallback
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
    )
  );
});
