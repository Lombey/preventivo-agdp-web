// Guarda la web en el celular para que abra sin señal. Los pedidos a Apps Script no pasan por la caché.
const CACHE = 'preventivo-v12';
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
  // Red primero para tomar actualizaciones; si no hay señal, la red tarda más de 4 s o responde con error, la copia guardada.
  // Solo se guarda una respuesta sana: un error de GitHub o la página de un Wi-Fi con portal no pisan la copia buena.
  const copiaGuardada = () => caches.match(e.request, { ignoreSearch: true })
    .then(r => r || (e.request.mode === 'navigate' ? caches.match('index.html') : undefined));
  const red = fetch(e.request).then(r => {
    if (r.ok && r.type === 'basic') { const copia = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copia)); return r; }
    return copiaGuardada().then(c => c || r);
  });
  const lenta = new Promise(res => setTimeout(res, 4000)).then(copiaGuardada);
  e.respondWith(Promise.race([red.catch(copiaGuardada), lenta.then(c => c || red)])
    .then(r => r || red).catch(() => new Response('Sin conexión', { status: 503 })));
});
