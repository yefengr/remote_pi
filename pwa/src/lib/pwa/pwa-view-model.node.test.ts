import { expect, test } from "vitest";
import type { PwaDeviceRecord, PwaEndpointRecord } from "./db";
import { derivePairingPresence } from "./pwa-view-model";

function device(id: string, deviceId = id): PwaDeviceRecord {
  return { id, deviceId, relayUrl: "https://relay.example.test", pairedAt: "2026-09-03T00:00:00.000Z" };
}

function endpoint(deviceId: string, endpointId: string, online: boolean | undefined, updatedAt: number): PwaEndpointRecord {
  return {
    id: `${deviceId}:${endpointId}`,
    deviceId,
    endpointId,
    runtimeInstanceId: `runtime-${endpointId}`,
    kind: "daemon",
    online,
    updatedAt,
  };
}

test("marks a device without discovered endpoints as checking", () => {
  expect(derivePairingPresence([device("device-a")], [])).toEqual({
    "device-a": { status: "checking", onlineEndpoints: 0, totalEndpoints: 0, lastSeenAt: undefined },
  });
});

test("derives offline, online, and partial device presence", () => {
  const devices = [device("offline"), device("online"), device("partial")];
  const endpoints = [
    endpoint("offline", "one", false, 1),
    endpoint("offline", "two", undefined, 2),
    endpoint("online", "one", true, 3),
    endpoint("online", "two", true, 4),
    endpoint("partial", "one", true, 5),
    endpoint("partial", "two", false, 6),
  ];

  expect(derivePairingPresence(devices, endpoints)).toEqual({
    offline: { status: "offline", onlineEndpoints: 0, totalEndpoints: 2, lastSeenAt: undefined },
    online: { status: "online", onlineEndpoints: 2, totalEndpoints: 2, lastSeenAt: 3 },
    partial: { status: "partial", onlineEndpoints: 1, totalEndpoints: 2, lastSeenAt: 5 },
  });
});

test("isolates endpoints by device identity and keeps the first online timestamp", () => {
  const devices = [device("record-a", "device-a"), device("record-b", "device-b")];
  const endpoints = [
    endpoint("device-b", "other", true, 90),
    endpoint("device-a", "first", true, 20),
    endpoint("device-a", "second", true, 80),
  ];

  expect(derivePairingPresence(devices, endpoints)).toEqual({
    "record-a": { status: "online", onlineEndpoints: 2, totalEndpoints: 2, lastSeenAt: 20 },
    "record-b": { status: "online", onlineEndpoints: 1, totalEndpoints: 1, lastSeenAt: 90 },
  });
});
