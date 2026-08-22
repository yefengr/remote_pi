import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeChallenge, decodeRelayFrame, decodeServerMessage, encodeOuterEnvelope } from "./protocol";

test("decodes known server messages and ignores unknown types", () => {
  const known = decodeServerMessage('{"type":"agent_chunk","in_reply_to":"m1","delta":"hello"}');
  assert.deepEqual(known, { type: "agent_chunk", in_reply_to: "m1", delta: "hello" });
  assert.equal(decodeServerMessage('{"type":"future_message","data":1}'), undefined);
  assert.equal(decodeServerMessage("not-json"), undefined);
});

test("decodes valid challenge and distinguishes relay frames", () => {
  assert.deepEqual(decodeChallenge('{"type":"challenge","nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}'), {
    type: "challenge",
    nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  });
  assert.equal(decodeChallenge('{"type":"challenge","nonce":"!"}'), undefined);
  const envelope = encodeOuterEnvelope("AQID", { type: "ping", id: "p1" }, "main");
  const relayFrame = decodeRelayFrame(envelope);
  assert.equal(relayFrame?.kind, "envelope");
});
