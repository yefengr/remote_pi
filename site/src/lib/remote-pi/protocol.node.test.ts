import { expect, test } from "vitest";
import { decodeChallenge, decodeRelayFrame } from "./protocol";

test("decodes strict owner challenge and endpoint control frames", () => {
  expect(decodeChallenge('{"type":"challenge","nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}')).toEqual({ type: "challenge", nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
  const frame = decodeRelayFrame({ type: "endpoints", device_id: "AQID", endpoints: [{ endpoint_id: "123e4567-e89b-42d3-a456-426614174001", runtime_instance_id: "123e4567-e89b-42d3-a456-426614174000", metadata: { kind: "daemon", pid: 1 } }] });
  expect(frame?.kind).toBe("control");
});
test("rejects routes with legacy fields", () => {
  expect(decodeRelayFrame({ type: "route", purpose: "session", device_id: "device", endpoint_id: "123e4567-e89b-42d3-a456-426614174001", runtime_instance_id: "123e4567-e89b-42d3-a456-426614174000", peer: "owner", ct: "opaque" })).toBeUndefined();
});

test("rejects unknown endpoint control and challenge fields", () => {
  expect(decodeRelayFrame({ type: "endpoint_ended", device_id: "device", endpoint_id: "123e4567-e89b-42d3-a456-426614174001", runtime_instance_id: "123e4567-e89b-42d3-a456-426614174000", extra: true })).toBeUndefined();
  expect(decodeChallenge('{"type":"challenge","nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","extra":true}')).toBeUndefined();
});
