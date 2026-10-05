// Service worker giving the page "cross-origin isolation": the headers
// Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy, which GitHub
// Pages cannot send. Isolated, the page may use SharedArrayBuffer: the wall
// thickness workers then share one copy of the model (engine/thickpool.js)
// and every core of the computer can work on it.
//
// It only adds the two headers to the site's own files; it caches nothing.
// Registered by index.html (once, with one reload of the page).

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (new URL(request.url).origin !== self.location.origin) return; // other sites: untouched
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;
  event.respondWith(
    fetch(request).then((response) => {
      if (response.status === 0 || response.type === "opaqueredirect") return response;
      const headers = new Headers(response.headers);
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Cross-Origin-Embedder-Policy", "require-corp");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }),
  );
});
