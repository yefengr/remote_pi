import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeChallenge, decodeRelayFrame } from "./protocol";

test("decodes strict owner challenge and endpoint control frames", () => {
  assert.deepEqual(decodeChallenge('{"type":"challenge","nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}'), { type: "challenge", nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
  const frame = decodeRelayFrame({ type: "endpoints", device_id: "AQID", endpoints: [{ endpoint_id: "123e4567-e89b-42d3-a456-426614174001", runtime_instance_id: "123e4567-e89b-42d3-a456-426614174000", metadata: { kind: "daemon", pid: 1 } }] });
  assert.equal(frame?.kind, "control");
});
test("rejects routes with legacy fields", () => {
  assert.equal(decodeRelayFrame({ type: "route", purpose: "session", device_id: "device", endpoint_id: "123e4567-e89b-42d3-a456-426614174001", runtime_instance_id: "123e4567-e89b-42d3-a456-426614174000", peer: "owner", ct: "opaque" }), undefined);
});

test("rejects unknown endpoint control and challenge fields", () => {
  assert.equal(decodeRelayFrame({ type: "endpoint_ended", device_id: "device", endpoint_id: "123e4567-e89b-42d3-a456-426614174001", runtime_instance_id: "123e4567-e89b-42d3-a456-426614174000", extra: true }), undefined);
  assert.equal(decodeChallenge('{"type":"challenge","nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","extra":true}'), undefined);
});
