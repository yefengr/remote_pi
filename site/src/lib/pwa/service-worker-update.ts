const UPDATE_ACTIVATION_TIMEOUT_MS = 5000;
const SERVICE_WORKER_SCOPE = "/app";

type WaitingWorker = {
  postMessage: (message: { type: "SKIP_WAITING" }) => void;
};

type WaitingRegistration = {
  waiting: WaitingWorker | null;
};

export type RefreshPwaAppDependencies = {
  getRegistration: () => Promise<WaitingRegistration | undefined>;
  listenForControllerChange: (listener: () => void) => () => void;
  scheduleFallback: (listener: () => void, delay: number) => () => void;
  reload: () => void;
};

const browserDependencies: RefreshPwaAppDependencies = {
  getRegistration: () => "serviceWorker" in navigator
    ? navigator.serviceWorker.getRegistration(SERVICE_WORKER_SCOPE)
    : Promise.resolve(undefined),
  listenForControllerChange: (listener) => {
    if (!("serviceWorker" in navigator)) return () => {};
    navigator.serviceWorker.addEventListener("controllerchange", listener, { once: true });
    return () => navigator.serviceWorker.removeEventListener("controllerchange", listener);
  },
  scheduleFallback: (listener, delay) => {
    const timeout = window.setTimeout(listener, delay);
    return () => window.clearTimeout(timeout);
  },
  reload: () => window.location.reload(),
};

export async function refreshPwaApp(
  registration?: WaitingRegistration | null,
  dependencies: RefreshPwaAppDependencies = browserDependencies,
): Promise<"reload_requested" | "update_requested"> {
  let currentRegistration = registration;
  if (!currentRegistration) {
    try {
      currentRegistration = await dependencies.getRegistration();
    } catch {
      dependencies.reload();
      return "reload_requested";
    }
  }

  const waiting = currentRegistration?.waiting;
  if (!waiting) {
    dependencies.reload();
    return "reload_requested";
  }

  let finished = false;
  let stopListening = () => {};
  let cancelFallback = () => {};
  const reloadOnce = () => {
    if (finished) return;
    finished = true;
    stopListening();
    cancelFallback();
    dependencies.reload();
  };

  stopListening = dependencies.listenForControllerChange(reloadOnce);
  cancelFallback = dependencies.scheduleFallback(reloadOnce, UPDATE_ACTIVATION_TIMEOUT_MS);

  try {
    waiting.postMessage({ type: "SKIP_WAITING" });
  } catch {
    reloadOnce();
    return "reload_requested";
  }

  return "update_requested";
}
