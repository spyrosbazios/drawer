/// <reference lib="webworker" />
import type { WorkboxPlugin } from "workbox-core";
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst } from "workbox-strategies";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | { url: string; revision: string | null })[] };

// Precache the build. API data is not cached: freshness belongs to TanStack Query and the event stream.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// SPA navigations fall back to index.html, never for the server's own paths.
registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html"), { denylist: [/^\/api\//] }));

// Images whose URL names their content (project thumbnails by key, render views by render key) never change,
// so they are served from the cache first: home paints its thumbnails at once, offline too. The newest
// IMAGE_LIMIT are kept.
const IMAGES = "drawer-images-v1";
const IMAGE_LIMIT = 400;
const IMMUTABLE_IMAGE = /^\/api\/(projects\/[^/]+\/thumbnail\/[0-9a-f]{32}\.png|renders\/[0-9a-f]{16,128}\/[\w.-]+\.png)$/;

const keepNewest: WorkboxPlugin = {
  cacheDidUpdate: async ({ cacheName }) => {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - IMAGE_LIMIT)).map((k) => cache.delete(k)));
  },
};

registerRoute(({ url, request }) => request.method === "GET" && url.origin === self.location.origin && IMMUTABLE_IMAGE.test(url.pathname), new CacheFirst({ cacheName: IMAGES, plugins: [keepNewest] }));

self.addEventListener("message", (e) => {
  const data: unknown = e.data;
  if (typeof data === "object" && data !== null && (data as { type?: unknown }).type === "SKIP_WAITING") void self.skipWaiting();
});
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
