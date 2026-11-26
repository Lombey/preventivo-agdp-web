// Guarda la web en el celular para que abra sin señal. Los pedidos a Apps Script no pasan por la caché.
const CACHE = 'preventivo-v9';
const ARCHIVOS = ['./', 'index.html', 'estilos.css', 'config.js', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'favicon.png', 'logo-corvus.png', 'logo-corvus-blanco.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Red primero para tomar actualizaciones; si no hay señal, la copia guardada.
  e.respondWith(
    fetch(e.request).then(r => {
      const copia = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copia));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
