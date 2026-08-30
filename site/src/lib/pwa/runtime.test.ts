import assert from "node:assert/strict";
import test from "node:test";
import { acceptEndpointRuntime, mergeEndpoints, migrateLegacyDefaultRelay } from "./runtime";

const LEGACY_RELAY = "https://relay-rp1.jacobmoura.work";
const CURRENT_RELAY = "https://relay-pi.yefengr.cn";
const endpoint = { id: "device:endpoint", deviceId: "device", endpointId: "endpoint", runtimeInstanceId: "runtime-old", kind: "interactive" as const, online: false, model: "old", updatedAt: 1 };

test("keeps the preferred endpoint runtime over a cached endpoint", () => {
  const cached = [endpoint];
  const current = [{ ...endpoint, runtimeInstanceId: "runtime-current", online: true, model: "new", updatedAt: 2 }];
  assert.deepEqual(mergeEndpoints(cached, current), current);
});

test("migrates only missing or legacy default Relay URLs", () => {
  assert.equal(migrateLegacyDefaultRelay(undefined, LEGACY_RELAY, CURRENT_RELAY), CURRENT_RELAY);
  assert.equal(migrateLegacyDefaultRelay(LEGACY_RELAY, LEGACY_RELAY, CURRENT_RELAY), CURRENT_RELAY);
  assert.equal(migrateLegacyDefaultRelay("https://custom.example.com", LEGACY_RELAY, CURRENT_RELAY), "https://custom.example.com");
});

test("rejects a late event from a runtime that already lost endpoint takeover", () => {
  const history = new Map<string, Set<string>>();
  const oldRuntime = { ...endpoint, runtimeInstanceId: "runtime-old" };
  const newRuntime = { ...oldRuntime, runtimeInstanceId: "runtime-new" };
  assert.equal(acceptEndpointRuntime(history, undefined, oldRuntime), true);
  assert.equal(acceptEndpointRuntime(history, oldRuntime, newRuntime), true);
  assert.equal(acceptEndpointRuntime(history, oldRuntime, oldRuntime), false);
});
