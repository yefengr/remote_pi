import { expect, test } from "vitest";
import { encodeBase64 } from "./encoding";
import { createPairRequest, parsePairUri, relayMismatch } from "./pairing";

test("strictly parses an endpoint pairing URI", () => {
  const token = encodeBase64(new Uint8Array(16), "url"); const device = encodeBase64(new Uint8Array(32), "url");
  const payload = parsePairUri(`remotepi://pair?t=${token}&epk=${device}&n=Work%20Mac&ep=123e4567-e89b-42d3-a456-426614174001&rt=123e4567-e89b-42d3-a456-426614174000`);
  expect(payload).toBeTruthy(); expect(payload?.sessionName).toBe("Work Mac"); expect(payload?.endpointId).toBe("123e4567-e89b-42d3-a456-426614174001"); expect(payload?.runtimeInstanceId).toBe("123e4567-e89b-42d3-a456-426614174000");
});
test("rejects pairing URIs without endpoint runtime identity", () => {
  const token = encodeBase64(new Uint8Array(16), "url"); const device = encodeBase64(new Uint8Array(32), "url");
  expect(parsePairUri(`remotepi://pair?t=${token}&epk=${device}&n=Work&ep=123e4567-e89b-42d3-a456-426614174001`)).toBeUndefined();
  expect(parsePairUri(`remotepi://pair?t=${token}&epk=${device}&n=Work&ep=123e4567-e89b-42d3-a456-426614174001&rt=not-a-uuid`)).toBeUndefined();
  expect(parsePairUri(`remotepi://pair?t=${token}&epk=${device}&n=Work&ep=not-a-uuid&rt=123e4567-e89b-42d3-a456-426614174000`)).toBeUndefined();
});
test("creates pair request and detects relay mismatch", () => {
  expect(createPairRequest("token", "Browser", "request")).toEqual({ protocol_version: 2, type: "pair_request", token: "token", device_name: "Browser", id: "request" });
  expect(relayMismatch("https://relay.example.test", "wss://relay.example.test/")).toBe(false);
});
