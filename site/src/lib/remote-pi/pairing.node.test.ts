import { expect, test } from "vitest";
import { encodeBase64 } from "./encoding";
import { createPairRequest, parsePairUri, relayMismatch } from "./pairing";

test("strictly parses a pairing URI", () => {
  const token = encodeBase64(new Uint8Array(16), "url");
  const epk = encodeBase64(new Uint8Array(32), "url");
  const payload = parsePairUri(`remotepi://pair?t=${token}&epk=${epk}&n=Work%20Mac&rm=room-a`);
  expect(payload).toBeTruthy();
  expect(payload!.sessionName).toBe("Work Mac");
  expect(payload!.roomId).toBe("room-a");
});

test("rejects malformed or wrong-length QR values", () => {
  expect(parsePairUri("https://pair?t=x&epk=y&n=z")).toBeUndefined();
  expect(parsePairUri("remotepi://pair?t=bad&epk=bad&n=z")).toBeUndefined();
  expect(parsePairUri(`remotepi://pair?t=${encodeBase64(new Uint8Array(16), "url")}&epk=${encodeBase64(new Uint8Array(31), "url")}&n=z`)).toBeUndefined();
});

test("creates pair requests and detects relay mismatch", () => {
  const request = createPairRequest("token", "Browser", "request-1");
  expect(request).toEqual({ protocol_version: 2, type: "pair_request", token: "token", device_name: "Browser", id: "request-1" });
  expect(relayMismatch("https://relay.example.test", "wss://relay.example.test/")).toBe(false);
  expect(relayMismatch("https://other.example.test", "wss://relay.example.test")).toBe(true);
});
