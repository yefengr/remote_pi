import assert from "node:assert/strict";
import test from "node:test";
import { recoverServerFrame } from "./server-frame-recovery";
import type { ServerFrame } from "../remote-pi/protocol-v2/frames";

const base = { protocol_version: 2 as const, session_id: "session", history_generation: "generation" };
const direct = { target_channel_id: "channel" };

type Calls = { invalidate: number; rehello: number; reconnect: number; disconnect: number };

function effects(calls: Calls) {
  return {
    invalidateScope: () => { calls.invalidate += 1; },
    rehello: () => { calls.rehello += 1; },
    reconnect: () => { calls.reconnect += 1; },
    disconnect: () => { calls.disconnect += 1; },
  };
}

test("reset invalidates once and rehellos once on the current channel", () => {
  const calls: Calls = { invalidate: 0, rehello: 0, reconnect: 0, disconnect: 0 };
  const frame: ServerFrame = { ...base, ...direct, type: "reset", reason: "generation_changed" };
  assert.equal(recoverServerFrame(frame, effects(calls)), "rehello");
  assert.deepEqual(calls, { invalidate: 1, rehello: 1, reconnect: 0, disconnect: 0 });
});

test("session_replaced invalidates once and reconnects without rehello", () => {
  const calls: Calls = { invalidate: 0, rehello: 0, reconnect: 0, disconnect: 0 };
  const frame: ServerFrame = { ...base, type: "bye", reason: "session_replaced" };
  assert.equal(recoverServerFrame(frame, effects(calls)), "reconnect");
  assert.deepEqual(calls, { invalidate: 1, rehello: 0, reconnect: 1, disconnect: 0 });
});

test("terminal bye reasons invalidate once and disconnect without rehello", () => {
  for (const reason of ["peer_stop", "shutdown"] as const) {
    const calls: Calls = { invalidate: 0, rehello: 0, reconnect: 0, disconnect: 0 };
    const frame: ServerFrame = { ...base, type: "bye", reason };
    assert.equal(recoverServerFrame(frame, effects(calls)), "disconnect");
    assert.deepEqual(calls, { invalidate: 1, rehello: 0, reconnect: 0, disconnect: 1 });
  }
});

test("other frames do not trigger any recovery effect", () => {
  const calls: Calls = { invalidate: 0, rehello: 0, reconnect: 0, disconnect: 0 };
  const frame: ServerFrame = { ...base, ...direct, type: "pong", in_reply_to: "request" };
  assert.equal(recoverServerFrame(frame, effects(calls)), "ignore");
  assert.deepEqual(calls, { invalidate: 0, rehello: 0, reconnect: 0, disconnect: 0 });
});
