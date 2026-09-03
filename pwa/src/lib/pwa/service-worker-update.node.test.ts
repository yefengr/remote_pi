import { expect, test } from "vitest";
import { refreshPwaApp, type RefreshPwaAppDependencies } from "./service-worker-update";

function createDependencies(registration?: { waiting: { postMessage: (message: { type: "SKIP_WAITING" }) => void } | null }) {
  let controllerChange: (() => void) | undefined;
  let fallback: (() => void) | undefined;
  let fallbackDelay: number | undefined;
  let reloads = 0;

  const dependencies: RefreshPwaAppDependencies = {
    getRegistration: async () => registration,
    listenForControllerChange: (listener) => {
      controllerChange = listener;
      return () => { controllerChange = undefined; };
    },
    scheduleFallback: (listener, delay) => {
      fallback = listener;
      fallbackDelay = delay;
      return () => { fallback = undefined; };
    },
    reload: () => { reloads += 1; },
  };

  return {
    dependencies,
    controllerChange: () => controllerChange,
    fallback: () => fallback,
    fallbackDelay: () => fallbackDelay,
    reloads: () => reloads,
  };
}

test("activates a waiting worker before reloading the app", async () => {
  const messages: { type: "SKIP_WAITING" }[] = [];
  const harness = createDependencies({ waiting: { postMessage: (message) => messages.push(message) } });

  const result = await refreshPwaApp(undefined, harness.dependencies);

  expect(result).toBe("update_requested");
  expect(messages).toEqual([{ type: "SKIP_WAITING" }]);
  expect(harness.fallbackDelay()).toBe(5000);
  expect(harness.reloads()).toBe(0);

  harness.controllerChange()?.();
  expect(harness.reloads()).toBe(1);
  expect(harness.fallback()).toBeUndefined();
});

test("uses an ordinary reload when no update is waiting", async () => {
  const harness = createDependencies({ waiting: null });

  const result = await refreshPwaApp(undefined, harness.dependencies);

  expect(result).toBe("reload_requested");
  expect(harness.reloads()).toBe(1);
  expect(harness.controllerChange()).toBeUndefined();
});

test("reloads once when worker activation does not emit controllerchange", async () => {
  const harness = createDependencies({ waiting: { postMessage: () => {} } });

  await refreshPwaApp(undefined, harness.dependencies);
  const fallback = harness.fallback();
  expect(fallback).toBeDefined();
  fallback?.();

  expect(harness.reloads()).toBe(1);
  expect(harness.controllerChange()).toBeUndefined();
});
