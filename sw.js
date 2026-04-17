// ─── BPSC TRACKER v3 · sw.js ─────────────────────────────────────────────────
const CACHE = ‘bpsc-v3.1’; // bumped — forces old cache purge on update
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
Promise.all(keys.filter(k => k !== CACHE).map(k => {
console.log(’[SW] Deleting old cache:’, k);
return caches.delete(k);
}))
)
);
self.clients.claim();
});

self.addEventListener(‘fetch’, e => {
// Network-first for JS/CSS so updates always get through
const url = new URL(e.request.url);
const isAsset = /.(js|css|html)(?.*)?$/.test(url.pathname);

if (isAsset) {
e.respondWith(
fetch(e.request)
.then(response => {
if (response.status === 200) {
const clone = response.clone();
caches.open(CACHE).then(c => c.put(e.request, clone));
}
return response;
})
.catch(() => caches.match(e.request)) // fallback to cache on offline
);
} else {
// Cache-first for other assets (icons, fonts)
e.respondWith(
caches.match(e.request).then(cached => cached || fetch(e.request))
);
}
});
