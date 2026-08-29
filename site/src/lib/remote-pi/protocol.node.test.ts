import { expect, test } from "vitest";
import { decodeChallenge, decodeRelayFrame, decodeServerMessage, encodeOuterEnvelope } from "./protocol";

test("decodes known server messages and ignores unknown types", () => {
  const known = decodeServerMessage('{"type":"agent_chunk","in_reply_to":"m1","delta":"hello"}');
  expect(known).toEqual({ type: "agent_chunk", in_reply_to: "m1", delta: "hello" });
  expect(decodeServerMessage('{"type":"future_message","data":1}')).toBeUndefined();
  expect(decodeServerMessage("not-json")).toBeUndefined();
});

test("decodes valid challenge and distinguishes relay frames", () => {
  expect(decodeChallenge('{"type":"challenge","nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}')).toEqual({
    type: "challenge",
    nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  });
  expect(decodeChallenge('{"type":"challenge","nonce":"!"}')).toBeUndefined();
  const envelope = encodeOuterEnvelope("AQID", { type: "ping", id: "p1" }, "main");
  const relayFrame = decodeRelayFrame(envelope);
  expect(relayFrame?.kind).toBe("envelope");
});
