// ─── BPSC TRACKER v3 · sw.js ─────────────────────────────────────────────────
const CACHE = ‘bpsc-v3’;  // FIX: bumped version so stale v1 cache is purged
const FILES = [
‘./’,
‘./index.html’,
‘./style.css’,
‘./app.js’,
‘./data.js’,
‘./manifest.json’,
];

self.addEventListener(‘install’, e => {
e.waitUntil(
caches.open(CACHE).then(c => c.addAll(FILES))
);
self.skipWaiting();
});

self.addEventListener(‘activate’, e => {
e.waitUntil(
caches.keys().then(keys =>
Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
)
);
self.clients.claim();
});

self.addEventListener(‘fetch’, e => {
// Cache-first for app shell, network-first could be used for data
e.respondWith(
caches.match(e.request).then(cached => {
if (cached) return cached;
return fetch(e.request).then(response => {
// Cache valid GET responses dynamically
if (e.request.method === ‘GET’ && response.status === 200) {
const clone = response.clone();
caches.open(CACHE).then(c => c.put(e.request, clone));
}
return response;
}).catch(() => cached); // fallback to cache on network failure
})
);
});
