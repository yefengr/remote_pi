import assert from "node:assert/strict";
import test from "node:test";
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

  assert.equal(result, "update_requested");
  assert.deepEqual(messages, [{ type: "SKIP_WAITING" }]);
  assert.equal(harness.fallbackDelay(), 5000);
  assert.equal(harness.reloads(), 0);

  harness.controllerChange()?.();
  assert.equal(harness.reloads(), 1);
  assert.equal(harness.fallback(), undefined);
});

test("uses an ordinary reload when no update is waiting", async () => {
  const harness = createDependencies({ waiting: null });

  const result = await refreshPwaApp(undefined, harness.dependencies);

  assert.equal(result, "reload_requested");
  assert.equal(harness.reloads(), 1);
  assert.equal(harness.controllerChange(), undefined);
});

test("reloads once when worker activation does not emit controllerchange", async () => {
  const harness = createDependencies({ waiting: { postMessage: () => {} } });

  await refreshPwaApp(undefined, harness.dependencies);
  const fallback = harness.fallback();
  assert.ok(fallback);
  fallback();

  assert.equal(harness.reloads(), 1);
  assert.equal(harness.controllerChange(), undefined);
});
