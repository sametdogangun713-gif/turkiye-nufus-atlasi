/* Türkiye Nüfus Atlası — service worker
   /sw.js adresinden sunulur; __VERSION__ sunucuda varlık özetiyle değiştirilir.
   Stratejiler:
     - Sayfalar (HTML): önce ağ, olmazsa önbellek (çevrimdışı son görülen sayfa)
     - /static/*: önce önbellek (dosya adları sürümlü, değişmez)
     - /api/*: önbellekten hemen yanıt + arka planda yenile (stale-while-revalidate) */

const VERSION = "__VERSION__";
const SHELL = `tna-shell-${VERSION}`;
const RUNTIME = "tna-runtime";
const PRECACHE = [
  "/",
  "/manifest.webmanifest",
  `/static/css/styles.css?v=${VERSION}`,
  `/static/js/map_app.js?v=${VERSION}`,
  `/static/fonts/fonts.css?v=${VERSION}`,
  "/static/fonts/BricolageGrotesque-latin.woff2",
  "/static/fonts/BricolageGrotesque-latin-ext.woff2",
  "/static/fonts/InstrumentSans-latin.woff2",
  "/static/fonts/InstrumentSans-latin-ext.woff2",
  "/static/icons/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("tna-shell-") && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME).then((c) => c.put(req, copy));
          return res;
        })
        .catch(async () => (await caches.match(req)) || (await caches.match("/"))),
    );
    return;
  }

  if (url.pathname.startsWith("/static/")) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(RUNTIME).then((c) => c.put(req, copy));
        return res;
      })),
    );
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      caches.open(RUNTIME).then(async (c) => {
        const hit = await c.match(req);
        const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
        return hit || net;
      }),
    );
  }
});
