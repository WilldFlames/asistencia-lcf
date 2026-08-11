const CACHE_VERSION = "lcf-familias-v1";
const APP_ASSETS = [
  "/offline.html",
  "/manifest.webmanifest",
  "/pwa.css",
  "/pwa.js",
  "/icons/lcf-familias-32.png",
  "/icons/lcf-familias-180.png",
  "/icons/lcf-familias-192.png",
  "/icons/lcf-familias-512.png",
  "/icons/lcf-familias-maskable-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_VERSION).then(cache => cache.addAll(APP_ASSETS)));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_VERSION).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Nunca se guardan respuestas con datos personales, sesiones o información académica.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request));
    return;
  }

  // Las pantallas siempre vienen de Railway; sin conexión solo se muestra un aviso neutro.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/offline.html")));
    return;
  }

  if (APP_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request).then(response => {
        const copy = response.clone();
        caches.open(CACHE_VERSION).then(cache => cache.put(request, copy));
        return response;
      }))
    );
  }
});
