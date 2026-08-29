import { expect, test } from "vitest";
import { decodeBase64, decodeEnvelope, decodeUtf8, encodeBase64, encodeEnvelope, encodeUtf8, toWebSocketUrl } from "./encoding";

test("encodes and decodes standard and URL-safe base64", () => {
  const bytes = new Uint8Array([0xfb, 0xef, 0xff]);
  expect(encodeBase64(bytes)).toBe("++//");
  expect(encodeBase64(bytes, "url")).toBe("--__");
  expect(decodeBase64("++//", "standard")).toEqual(bytes);
  expect(decodeBase64("--__", "url")).toEqual(bytes);
});

test("converts HTTP relay URLs to WebSocket URLs", () => {
  expect(toWebSocketUrl("http://relay.example.test/path")).toBe("ws://relay.example.test/path");
  expect(toWebSocketUrl("https://relay.example.test/path")).toBe("wss://relay.example.test/path");
  expect(() => toWebSocketUrl("ftp://relay.example.test")).toThrow();
});

test("encodes and decodes outer envelope payload", () => {
  const envelope = encodeEnvelope("AQID", encodeUtf8("hello"), "room-a");
  const decoded = decodeEnvelope(envelope);
  expect(decoded).toBeTruthy();
  expect(decodeUtf8(decoded!.payload)).toBe("hello");
  expect(decoded!.envelope.room).toBe("room-a");
});
