const CACHE_NAME = "cutframe-assets-v2";
const APP_SHELL = ["./", "./index.html", "./style.css", "./script.js"];

async function warmupAssets(assets) {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(
    (assets || []).map(async (url) => {
      try {
        const req = new Request(url, { mode: "no-cors" });
        const res = await fetch(req);
        if (res && (res.ok || res.type === "opaque")) {
          await cache.put(req, res.clone());
        }
      } catch {}
    }),
  );
}

const shouldCache = (url) => {
  if (url.origin === self.location.origin) {
    return APP_SHELL.some((p) => url.pathname.endsWith(p.replace("./", "/")));
  }
  return (
    url.hostname === "cdn.jsdelivr.net" ||
    url.hostname === "storage.googleapis.com"
  );
};

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (!shouldCache(url)) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && (res.ok || res.type === "opaque")) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => cached);

      return cached || networkFetch;
    }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "warmup-ai-cache") return;
  event.waitUntil(warmupAssets(event.data.assets));
});
