// Service Worker — requisito real de Chrome para poder "instalar" la app
// (sin esto, el manifest.json solo sirve de bookmark con ícono, no aparece
// el banner de instalar de verdad). Estrategia: stale-while-revalidate para
// los archivos estáticos de la app (HTML/CSS/JS/ícono) — responde al toque
// desde caché y en paralelo pide una versión fresca para la próxima vez, así
// abre rápido incluso con mala señal. Las llamadas a /api/* NUNCA se cachean
// acá: esta app es 100% datos en vivo (búsquedas, requerimientos, alertas),
// mostrar una respuesta vieja de la API sería activamente confuso, no útil.

const CACHE = 'buscador-v1';
const PRECACHE = ['/', '/manifest.json', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Solo GET, mismo origen, y nunca /api/* — todo lo demás (POST, CDN
  // externo de Leaflet, llamadas a la API) pasa directo a la red sin que
  // este service worker lo toque.
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fresco = fetch(e.request)
        .then((resp) => {
          if (resp.ok) caches.open(CACHE).then((c) => c.put(e.request, resp.clone()));
          return resp;
        })
        .catch(() => cached);
      return cached || fresco;
    })
  );
});
