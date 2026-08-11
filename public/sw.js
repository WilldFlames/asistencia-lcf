const CACHE_VERSION = "lcf-familias-v3";
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

self.addEventListener("push", event => {
  let datos = {};
  try { datos = event.data ? event.data.json() : {}; } catch { datos = { body: event.data?.text() || "" }; }
  const titulo = datos.title || "Liceo de Calle Fallas";
  const opciones = {
    body: datos.body || "Tiene una nueva notificación institucional.",
    icon: "/icons/lcf-familias-192.png",
    badge: "/icons/lcf-familias-192.png",
    tag: datos.tag || "lcf-familias",
    renotify: true,
    silent: false,
    timestamp: Date.now(),
    vibrate: [180, 80, 180],
    requireInteraction: datos.requireInteraction === true,
    data: { url: datos.url || "/?app=familias", recibido:Date.now() },
  };
  const trabajos = [self.registration.showNotification(titulo, opciones)];
  if (self.navigator && "setAppBadge" in self.navigator) trabajos.push(self.navigator.setAppBadge(1).catch(() => {}));
  event.waitUntil(Promise.all(trabajos));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const destino = new URL(event.notification.data?.url || "/?app=familias", self.location.origin).href;
  event.waitUntil((async () => {
    const ventanas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const ventana of ventanas) {
      if (new URL(ventana.url).origin !== self.location.origin) continue;
      try {
        if ("navigate" in ventana) await ventana.navigate(destino);
      } catch (_) {
        // Algunos iPhone rechazan navigate() sobre una PWA suspendida; el
        // mensaje inferior abre la pestaña correcta cuando vuelve a primer plano.
      }
      try { await ventana.focus(); } catch (_) {}
      try { ventana.postMessage({ type:"LCF_OPEN_NOTIFICATION", url:destino }); } catch (_) {}
      return;
    }
    if (self.clients.openWindow) {
      try { await self.clients.openWindow(destino); } catch (_) {
        await self.clients.openWindow("/?app=familias");
      }
    }
  })());
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
