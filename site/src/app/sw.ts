import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { CacheFirst, NetworkFirst, NetworkOnly, Serwist } from "serwist";

// Serwist replaces this placeholder with the production asset manifest.
declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const isAppNavigation = ({ request, sameOrigin, url }: { request: Request; sameOrigin: boolean; url: URL }) =>
  sameOrigin && request.mode === "navigate" && (url.pathname === "/app" || url.pathname.startsWith("/app/"));

const isStaticAsset = ({ request, sameOrigin, url }: { request: Request; sameOrigin: boolean; url: URL }) =>
  sameOrigin &&
  request.method === "GET" &&
  (url.pathname.startsWith("/_next/static/") ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname === "/logo.svg" ||
    url.pathname === "/app-icon-192.png" ||
    url.pathname === "/app-icon-512.png");

const isDynamicRequest = ({ sameOrigin }: { sameOrigin: boolean }) => sameOrigin;

const serwist = new Serwist({
  cacheId: "remote-pi",
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: false,
  clientsClaim: false,
  runtimeCaching: [
    {
      matcher: isAppNavigation,
      handler: new NetworkFirst({
        cacheName: "remote-pi-app",
        networkTimeoutSeconds: 5,
      }),
    },
    {
      matcher: isStaticAsset,
      handler: new CacheFirst({ cacheName: "remote-pi-static" }),
    },
    {
      matcher: isDynamicRequest,
      handler: new NetworkOnly(),
    },
  ],
});

serwist.addEventListeners();
