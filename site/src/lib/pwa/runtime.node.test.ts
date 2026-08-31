import { expect, test } from "vitest";
import { acceptEndpointRuntime, mergeEndpoints, migrateLegacyDefaultRelay } from "./runtime";

const LEGACY_RELAY = "https://relay-rp1.jacobmoura.work";
const CURRENT_RELAY = "https://relay-pi.yefengr.cn";
const endpoint = { id: "device:endpoint", deviceId: "device", endpointId: "endpoint", runtimeInstanceId: "runtime-old", kind: "interactive" as const, online: false, model: "old", updatedAt: 1 };

test("keeps the preferred endpoint runtime over a cached endpoint", () => {
  const cached = [endpoint];
  const current = [{ ...endpoint, runtimeInstanceId: "runtime-current", online: true, model: "new", updatedAt: 2 }];
  expect(mergeEndpoints(cached, current)).toEqual(current);
});

test("migrates only missing or legacy default Relay URLs", () => {
  expect(migrateLegacyDefaultRelay(undefined, LEGACY_RELAY, CURRENT_RELAY)).toBe(CURRENT_RELAY);
  expect(migrateLegacyDefaultRelay(LEGACY_RELAY, LEGACY_RELAY, CURRENT_RELAY)).toBe(CURRENT_RELAY);
  expect(migrateLegacyDefaultRelay("https://custom.example.com", LEGACY_RELAY, CURRENT_RELAY)).toBe("https://custom.example.com");
});

test("rejects a late event from a runtime that already lost endpoint takeover", () => {
  const history = new Map<string, Set<string>>();
  const oldRuntime = { ...endpoint, runtimeInstanceId: "runtime-old" };
  const newRuntime = { ...oldRuntime, runtimeInstanceId: "runtime-new" };
  expect(acceptEndpointRuntime(history, undefined, oldRuntime)).toBe(true);
  expect(acceptEndpointRuntime(history, oldRuntime, newRuntime)).toBe(true);
  expect(acceptEndpointRuntime(history, oldRuntime, oldRuntime)).toBe(false);
});
