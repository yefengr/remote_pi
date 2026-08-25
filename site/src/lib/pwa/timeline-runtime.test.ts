import assert from "node:assert/strict";
import test from "node:test";
import { TimelineRuntime, type TimelineScope } from "./timeline-runtime";
import type { ServerFrame } from "../remote-pi/protocol-v2/frames";
import type { TimelineEvent } from "../remote-pi/protocol-v2/schema";

const scope: TimelineScope = { peerEpk: "peer", roomId: "room", sessionId: "session", historyGeneration: "generation", selfSenderRef: "self", channelId: "channel" };

function userEvent(messageId: string): Extract<TimelineEvent, { kind: "user" }> {
  return { event_id: messageId, message_id: messageId, session_id: scope.sessionId, history_generation: scope.historyGeneration, timestamp: 2, group_id: "group", kind: "user", blocks: [{ type: "text", text: "hello" }], origin: "pwa", sender_ref: scope.selfSenderRef, delivery: "normal", status: "committed" };
}

test("replaces pending from a history formal event and emits observed by message id", () => {
  const runtime = new TimelineRuntime();
  runtime.setScope(scope);
  const sent = runtime.sendUser("hello");
  assert.ok(sent);
  const started: ServerFrame = { protocol_version: 2, type: "user_message_started", target_channel_id: scope.channelId, in_reply_to: sent.frame.id, session_id: scope.sessionId, history_generation: scope.historyGeneration, message: { id: "message", group_id: "group", blocks: [{ type: "text", text: "hello" }], origin: "pwa", sender_ref: scope.selfSenderRef, delivery: "normal" } };
  runtime.receive(started);
  const changed = runtime.replaceHistory([userEvent("message")]);
  assert.equal(changed.items.some((item) => item.kind === "pending"), false);
  assert.deepEqual(changed.observed.map((frame) => frame.type), ["user_message_observed"]);
});

test("reset always invalidates scope and keeps pending as unknown delivery", () => {
  const runtime = new TimelineRuntime();
  runtime.setScope(scope);
  runtime.sendUser("hello");
  const changed = runtime.receive({ protocol_version: 2, type: "reset", target_channel_id: scope.channelId, session_id: scope.sessionId, history_generation: scope.historyGeneration, reason: "conflict" });
  assert.equal(runtime.currentScope, null);
  assert.equal(changed.items.some((item) => item.kind === "pending" && item.delivery === "unknown_delivery"), true);
});

test("prepends earlier history without clearing recent events", () => {
  const runtime = new TimelineRuntime();
  runtime.setScope(scope);
  runtime.replaceHistory([userEvent("recent")]);
  const earlier = { ...userEvent("earlier"), timestamp: 1, group_id: "earlier-group" };
  const changed = runtime.prependHistory([earlier]);
  assert.deepEqual(changed.items.filter((item) => item.kind === "event").map((item) => item.event.event_id), ["earlier", "recent"]);
});
