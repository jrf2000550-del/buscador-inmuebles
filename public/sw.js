// Service Worker — requisito real de Chrome para poder "instalar" la app
// (sin esto, el manifest.json solo sirve de bookmark con ícono, no aparece
// el banner de instalar de verdad).
//
// Estrategia: network-first para HTML (navegaciones) — la app se sigue
// desarrollando activamente, así que mostrar una versión vieja apenas se
// publica un cambio es activamente confuso (pasó: cambios ya en el server
// que no se veían en el teléfono pinneado hasta el segundo o tercer abrir).
// Con la red disponible SIEMPRE se pide la versión fresca; el caché solo
// entra como respaldo si no hay conexión. Para íconos/manifest (que casi
// nunca cambian) sí sirve stale-while-revalidate, para que abran rápido.
// Las llamadas a /api/* NUNCA se cachean: esta app es 100% datos en vivo.

const CACHE = 'buscador-v2';
const PRECACHE = ['/manifest.json', '/icon.svg'];

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
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Navegación (HTML) o cualquier .html explícito: red primero, caché solo
  // como respaldo offline.
  const esHtml = e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/';
  if (esHtml) {
    e.respondWith(
      fetch(e.request)
        .then((resp) => {
          if (resp.ok) caches.open(CACHE).then((c) => c.put(e.request, resp.clone()));
          return resp;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Estáticos (ícono, manifest): stale-while-revalidate, abren rápido y se
  // actualizan solos en segundo plano.
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
