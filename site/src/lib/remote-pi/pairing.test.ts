import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeBase64 } from "./encoding";
import { createPairRequest, parsePairUri, relayMismatch } from "./pairing";

test("strictly parses an endpoint pairing URI", () => {
  const token = encodeBase64(new Uint8Array(16), "url"); const device = encodeBase64(new Uint8Array(32), "url");
  const payload = parsePairUri(`remotepi://pair?t=${token}&epk=${device}&n=Work%20Mac&ep=123e4567-e89b-42d3-a456-426614174001&rt=123e4567-e89b-42d3-a456-426614174000`);
  assert.ok(payload); assert.equal(payload.sessionName, "Work Mac"); assert.equal(payload.endpointId, "123e4567-e89b-42d3-a456-426614174001"); assert.equal(payload.runtimeInstanceId, "123e4567-e89b-42d3-a456-426614174000");
});
test("rejects pairing URIs without endpoint runtime identity", () => {
  const token = encodeBase64(new Uint8Array(16), "url"); const device = encodeBase64(new Uint8Array(32), "url");
  assert.equal(parsePairUri(`remotepi://pair?t=${token}&epk=${device}&n=Work&ep=123e4567-e89b-42d3-a456-426614174001`), undefined);
  assert.equal(parsePairUri(`remotepi://pair?t=${token}&epk=${device}&n=Work&ep=123e4567-e89b-42d3-a456-426614174001&rt=not-a-uuid`), undefined);
  assert.equal(parsePairUri(`remotepi://pair?t=${token}&epk=${device}&n=Work&ep=not-a-uuid&rt=123e4567-e89b-42d3-a456-426614174000`), undefined);
});
test("creates pair request and detects relay mismatch", () => {
  assert.deepEqual(createPairRequest("token", "Browser", "request"), { protocol_version: 2, type: "pair_request", token: "token", device_name: "Browser", id: "request" });
  assert.equal(relayMismatch("https://relay.example.test", "wss://relay.example.test/"), false);
});
