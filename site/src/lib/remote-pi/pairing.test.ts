import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeBase64 } from "./encoding";
import { createPairRequest, parsePairUri, relayMismatch } from "./pairing";

test("strictly parses a pairing URI", () => {
  const token = encodeBase64(new Uint8Array(16), "url");
  const epk = encodeBase64(new Uint8Array(32), "url");
  const payload = parsePairUri(`remotepi://pair?t=${token}&epk=${epk}&n=Work%20Mac&rm=room-a`);
  assert.ok(payload);
  assert.equal(payload.sessionName, "Work Mac");
  assert.equal(payload.roomId, "room-a");
});

test("rejects malformed or wrong-length QR values", () => {
  assert.equal(parsePairUri("https://pair?t=x&epk=y&n=z"), undefined);
  assert.equal(parsePairUri("remotepi://pair?t=bad&epk=bad&n=z"), undefined);
  assert.equal(parsePairUri(`remotepi://pair?t=${encodeBase64(new Uint8Array(16), "url")}&epk=${encodeBase64(new Uint8Array(31), "url")}&n=z`), undefined);
});

test("creates pair requests and detects relay mismatch", () => {
  const request = createPairRequest("token", "Browser", "request-1");
  assert.deepEqual(request, { protocol_version: 2, type: "pair_request", token: "token", device_name: "Browser", id: "request-1" });
  assert.equal(relayMismatch("https://relay.example.test", "wss://relay.example.test/"), false);
  assert.equal(relayMismatch("https://other.example.test", "wss://relay.example.test"), true);
});
