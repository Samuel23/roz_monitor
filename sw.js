const CACHE_NAME = "roz-pwa-v1.3.1";
const ASSETS = [
  "./",
  "index.html",
  "style.css?v=1.3.1",
  "app.js?v=1.3.1",
  "manifest.json",
  "favicon.ico"
];

// Pre-cache core application shell
self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Purge obsolete cache versions on activate
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-First with Cache Fallback (Never cache live telemetry or maps)
self.addEventListener("fetch", e => {
  const url = e.request.url;
  if (url.includes("status.json") || url.includes("ntfy") || url.includes("map.png") || url.includes("stream")) {
    return; // Pass through directly to live network
  }
  
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.status === 200) {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, resClone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
