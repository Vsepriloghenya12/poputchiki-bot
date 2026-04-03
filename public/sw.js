const CACHE_NAME = 'poputchiki-pwa-v3';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/assets/css/base.css?v=20260403b',
  '/assets/css/app.css?v=20260403b',
  '/assets/js/app.js?v=20260403b',
  '/assets/js/shared/api.js?v=20260403b',
  '/assets/js/shared/format.js?v=20260403b',
  '/assets/js/shared/pwa.js?v=20260403b',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/assets/icons/apple-touch-icon.png',
  '/assets/icons/badge-72.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', clone)).catch(() => {});
          return response;
        })
        .catch(async () => (await caches.match(request)) || caches.match('/index.html'))
    );
    return;
  }

  const isStaticAsset =
    url.pathname === '/manifest.webmanifest' ||
    url.pathname === '/index.html' ||
    url.pathname.startsWith('/assets/');

  if (!isStaticAsset) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {});
        return response;
      })
      .catch(async () => (await caches.match(request)) || caches.match('/index.html'))
  );
});

self.addEventListener('push', (event) => {
  let payload = {};

  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = {
      body: event.data ? event.data.text() : 'У вас новое уведомление',
    };
  }

  const title = payload.title || 'Попутчики';
  const options = {
    body: payload.body || 'Откройте приложение, чтобы посмотреть детали.',
    icon: payload.icon || '/assets/icons/icon-192.png',
    badge: payload.badge || '/assets/icons/badge-72.png',
    tag: payload.tag || 'poputchiki-notification',
    data: {
      url: payload.url || '/',
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const rawUrl = event.notification?.data?.url || '/';
  const targetUrl = new URL(rawUrl, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url === targetUrl && 'focus' in client) {
          return client.focus();
        }
      }

      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }

      return null;
    })
  );
});
