// Оболочка приложения работает без сети: отдаём из кэша, в фоне обновляем кэш.
// Запросы к api.github.com не перехватываются.
const CACHE = 'schety-v10';
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const key = req.mode === 'navigate' ? 'index.html' : req;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(key, { ignoreSearch: true });
    const network = fetch(req).then(res => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    }).catch(() => null);
    if (cached) { e.waitUntil(network); return cached; }
    return (await network) || new Response('Нет сети', { status: 503 });
  }));
});
