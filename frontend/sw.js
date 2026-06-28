// sw.js — Diabolus PWA Service Worker v3
// Estrategia: Cache-first para el app shell; Network-only para /api/*
// v3: FIX — no interceptar peticiones externas (evita CORS bug en Safari)

const CACHE_NAME = 'diabolus-shell-v4';

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
  '/manifest.json',
  '/offline.html',
  '/sidebar.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        SHELL_URLS.map((url) => cache.add(url).catch(() => {}))
      );
    }).then(() => self.skipWaiting())
  );
});

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

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1) Peticiones externas (API, etc.) → NO interceptar.
  //    El navegador las maneja directamente con CORS nativo.
  //    IMPORTANTE: en Safari, event.respondWith(fetch(req)) en SW puede
  //    cortar los headers CORS. Dejamos que el browser lo gestione solo.
  if (url.hostname !== self.location.hostname) {
    return; // no llamar event.respondWith → browser maneja CORS nativo
  }

  // 2) Internal API calls → siempre red (nunca caché)
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/telegram/') ||
    url.pathname.startsWith('/webhooks/')
  ) {
    event.respondWith(fetch(request));
    return;
  }

  // 3) Navegación HTML → network first, cache fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
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

  // 4) Otros assets → cache first, network fallback
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
