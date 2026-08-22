import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBase64, decodeEnvelope, decodeUtf8, encodeBase64, encodeEnvelope, encodeUtf8, toWebSocketUrl } from "./encoding";

test("encodes and decodes standard and URL-safe base64", () => {
  const bytes = new Uint8Array([0xfb, 0xef, 0xff]);
  assert.equal(encodeBase64(bytes), "++//");
  assert.equal(encodeBase64(bytes, "url"), "--__");
  assert.deepEqual(decodeBase64("++//", "standard"), bytes);
  assert.deepEqual(decodeBase64("--__", "url"), bytes);
});

test("converts HTTP relay URLs to WebSocket URLs", () => {
  assert.equal(toWebSocketUrl("http://relay.example.test/path"), "ws://relay.example.test/path");
  assert.equal(toWebSocketUrl("https://relay.example.test/path"), "wss://relay.example.test/path");
  assert.throws(() => toWebSocketUrl("ftp://relay.example.test"));
});

test("encodes and decodes outer envelope payload", () => {
  const envelope = encodeEnvelope("AQID", encodeUtf8("hello"), "room-a");
  const decoded = decodeEnvelope(envelope);
  assert.ok(decoded);
  assert.equal(decodeUtf8(decoded.payload), "hello");
  assert.equal(decoded.envelope.room, "room-a");
});
