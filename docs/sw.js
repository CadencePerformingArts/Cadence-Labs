/* DCI Tracker service worker — network-first with cache fallback.
   Fresh data always wins when online; the app shell and the last-seen data
   keep working offline. Nothing is ever served stale while connected. */
const CACHE = "cadence-v24";
const SHELL = ["./", "index.html", "app.css", "app.js", "charts.js", "recap.js", "arcade.js", "wrapped.js", "install.js", "manifest.webmanifest"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* score alerts (Web Push) */
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data.json(); } catch (err) {}
  e.waitUntil(self.registration.showNotification(d.title || "Cadence", {
    body: d.body || "New DCI scores are in.",
    icon: "icons/icon-192.png",
    // status-bar badge must be monochrome-on-transparent or Android
    // flattens it into a white square
    badge: "icons/badge-96.png",
    // tag keyed to the title: each show's scores get their OWN alert, and a
    // re-post for the same show replaces (and re-chimes) its earlier one
    tag: (d.tag || "cadence") + ":" + (d.title || "").slice(0, 48),
    renotify: true,
    data: { url: d.url || "./" },
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data || {}).url || "./";
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(ws => {
    for (const w of ws) if ("focus" in w) {
      // app already open: route it to the show, then bring it forward
      try { w.postMessage({ type: "navigate", url }); } catch (err) {}
      return w.focus();
    }
    return clients.openWindow(url); // cold start: opens straight to the deep link
  }));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || !req.url.startsWith(self.location.origin)) return;
  e.respondWith(
    // no-cache: revalidate with the server instead of trusting the browser's
    // 10-minute HTTP cache — new deploys appear on the next reload
    fetch(req, { cache: "no-cache" })
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
