// 離線快取：頁面外框優先讀快取，市場資料一律先連網，失敗時才用上次的資料
const SHELL = "tw-signal-shell-v8";
const FILES = ["./", "index.html", "app.js", "manifest.webmanifest", "icons/icon-180.png", "icons/icon-192.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL && k !== "tw-signal-data").map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.endsWith("/data/latest.json")) {
    e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open("tw-signal-data").then(c => c.put("latest", copy)); return r; })
      .catch(() => caches.open("tw-signal-data").then(c => c.match("latest"))));
    return;
  }
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
