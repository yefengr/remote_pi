"use client";

import { useEffect } from "react";

const DEV_SW_CLEANUP_KEY = "remote-pi-dev-sw-cleanup-v1";

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") {
      if (sessionStorage.getItem(DEV_SW_CLEANUP_KEY)) return;
      sessionStorage.setItem(DEV_SW_CLEANUP_KEY, "1");
      void navigator.serviceWorker.getRegistrations().then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
        .then(() => caches.keys())
        .then((keys) => Promise.all(keys.filter((key) => key.startsWith("remote-pi-pwa-")) .map((key) => caches.delete(key))));
      return;
    }
    void navigator.serviceWorker.register("/sw.js", { scope: "/app" });
  }, []);

  return null;
}
