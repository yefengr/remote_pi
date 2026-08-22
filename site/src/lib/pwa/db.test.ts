import assert from "node:assert/strict";
import test from "node:test";
import { makePwaPeerId } from "./db";

test("creates a distinct pairing id for each Pi room", () => {
  const peer = "ER0CaBbQVX";
  assert.notEqual(makePwaPeerId(peer, "room-a"), makePwaPeerId(peer, "room-b"));
  assert.equal(makePwaPeerId(peer, "room/a"), "ER0CaBbQVX:room%2Fa");
});
