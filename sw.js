const CACHE_NAME = "roz-pwa-v1.6.0";
const ASSETS = [
  "./",
  "index.html",
  "style.css?v=1.6.0",
  "app.js?v=1.6.0",
  "manifest.json",
  "favicon.ico"
];

const LIVE = ["status.json", "inventory.json", "map.json", "chat.json",
              "history.json", "map.png", "ntfy", "stream"];

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
  // Live data, every one of them cache-busted by the caller and none of them
  // meaningful a second later. inventory.json, map.json and chat.json joined
  // this list when the containers, the walked trail and the chat log were
  // split out of status.json: caching a per-client endpoint keyed by a
  // ?t=<now> URL grows the cache without a single hit ever being reused.
  if (LIVE.some(name => url.includes(name))) {
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
