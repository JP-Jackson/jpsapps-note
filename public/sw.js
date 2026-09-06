/**
 * Service worker — offline shell only.
 *
 * Its job is narrow on purpose: keep the app openable with no signal (§6, "expect to
 * work offline; this is not optional"). Captured data is NOT cached here — queued
 * entries and photos live in IndexedDB, which survives independently of this cache and
 * does not risk a stale response being served as if it were fresh.
 *
 * API requests are never cached. A cached /api/me or /api/entries would be a lie, and
 * a capture tool that lies about what synced is worse than one that says "offline".
 */
const CACHE = "note-shell-1.4.0";
const SHELL = ["/", "/icon-192.png", "/icon-512.png", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  // Never cache the API, and never serve a stale one.
  if (url.pathname.startsWith("/api/")) return;

  // Cloudflare Access redirects must reach the network or login breaks.
  if (url.pathname.startsWith("/cdn-cgi/")) return;

  // Network-first for the shell: fresh when online, cached when not.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("/"))),
  );
});
