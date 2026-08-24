"use client";

import { Download, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type ServiceWorkerMessage = { type: "SKIP_WAITING" };

const DEV_SW_CLEANUP_KEY = "remote-pi-dev-sw-cleanup-v1";

export function ServiceWorkerRegister() {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [updateReady, setUpdateReady] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [updateRequested, setUpdateRequested] = useState(false);
  const updateRequestedRef = useRef(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      if (!sessionStorage.getItem(DEV_SW_CLEANUP_KEY) && "serviceWorker" in navigator) {
        sessionStorage.setItem(DEV_SW_CLEANUP_KEY, "1");
        void navigator.serviceWorker.getRegistrations().then((registrations) => Promise.all(registrations.map((current) => current.unregister())))
          .then(() => typeof caches === "undefined" ? [] : caches.keys())
          .then((keys) => Promise.all(keys.filter((key) => key.startsWith("remote-pi-")).map((key) => caches.delete(key))));
      }
      return;
    }

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => setInstallPrompt(null);
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);

    if (!("serviceWorker" in navigator)) {
      queueMicrotask(() => setUnsupported(true));
      return () => {
        window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
        window.removeEventListener("appinstalled", onAppInstalled);
      };
    }

    let disposed = false;
    let currentRegistration: ServiceWorkerRegistration | null = null;
    const onControllerChange = () => {
      if (updateRequestedRef.current) window.location.reload();
    };
    const inspectWaitingWorker = () => {
      if (!disposed && currentRegistration?.waiting && navigator.serviceWorker.controller) setUpdateReady(true);
    };
    const onUpdateFound = () => {
      const worker = currentRegistration?.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed") inspectWaitingWorker();
      });
    };

    void navigator.serviceWorker.register("/sw.js", { scope: "/app" }).then((nextRegistration) => {
      if (disposed) return;
      currentRegistration = nextRegistration;
      setRegistration(nextRegistration);
      inspectWaitingWorker();
      nextRegistration.addEventListener("updatefound", onUpdateFound);
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    }).catch(() => {
      if (!disposed) setUnsupported(true);
    });

    return () => {
      disposed = true;
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
      currentRegistration?.removeEventListener("updatefound", onUpdateFound);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  if (process.env.NODE_ENV !== "production") return null;
  const showNotice = !dismissed && (unsupported || updateReady || Boolean(installPrompt));
  if (!showNotice) return null;

  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };
  const applyUpdate = () => {
    const waiting = registration?.waiting;
    if (!waiting) return;
    updateRequestedRef.current = true;
    setUpdateRequested(true);
    waiting.postMessage({ type: "SKIP_WAITING" } satisfies ServiceWorkerMessage);
  };

  return (
    <div className="pwa-runtime-notice" role="status">
      <div className="pwa-runtime-notice-copy">
        {unsupported ? <><strong>Offline app mode unavailable</strong><span>This browser can still use Remote Pi online, but it cannot provide PWA offline startup.</span></> : updateReady ? <><strong>Remote Pi update ready</strong><span>Refresh when you are ready to use the new app version.</span></> : <><strong>Install Remote Pi</strong><span>Open this workspace from your device launcher.</span></>}
      </div>
      <div className="pwa-runtime-notice-actions">
        {installPrompt ? <button className="pwa-secondary-button" type="button" onClick={() => void install()}><Download size={15} /> Install app</button> : null}
        {updateReady ? <button className="pwa-primary-button" type="button" onClick={applyUpdate} disabled={updateRequested}><RefreshCw size={15} /> {updateRequested ? "Updating" : "Refresh"}</button> : null}
        <button className="pwa-icon-button" type="button" onClick={() => setDismissed(true)} aria-label="Dismiss PWA notice" title="Dismiss"><X size={16} /></button>
      </div>
    </div>
  );
}
