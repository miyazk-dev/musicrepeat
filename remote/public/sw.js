/* MusicRepeat リモコン PWA Service Worker
 * アプリシェルをキャッシュして、2回目以降はオフライン(PC未起動)でも画面が出ます。
 * (曲リスト・操作はPC側が起動していないと使えません) */
const CACHE = 'mr-remote-v2';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // 画面遷移(/ と /staff は同じシェル)は network-first、落ちたらキャッシュへ
  if (e.request.mode === 'navigate') {
    const isShell = url.pathname === '/' || url.pathname === '/staff' || url.pathname === '/index.html';
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res.ok && isShell) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy));
        }
        return res;
      }).catch(() =>
        caches.match('/', { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html'))
      )
    );
    return;
  }

  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
