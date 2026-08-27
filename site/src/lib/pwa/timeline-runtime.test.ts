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

test("accumulates deltas for the same assistant partial id", () => {
  const runtime = new TimelineRuntime();
  runtime.setScope(scope);
  for (const delta of ["a", "b", "c"]) {
    runtime.receive({ protocol_version: 2, type: "timeline_partial", session_id: scope.sessionId, history_generation: scope.historyGeneration, group_id: "assistant-group", partial_id: "assistant-partial", kind: "assistant", status: "delta", delta });
  }

  const partial = runtime.receive({ protocol_version: 2, type: "session_ready", session_id: scope.sessionId, history_generation: scope.historyGeneration }).items.find((item) => item.kind === "partial");
  assert.equal(partial?.kind, "partial");
  assert.equal(partial?.partial.delta, "abc");
});

test("formal assistant clears assistant and thinking partials from the same group", () => {
  const runtime = new TimelineRuntime();
  runtime.setScope(scope);
  runtime.receive({ protocol_version: 2, type: "timeline_partial", session_id: scope.sessionId, history_generation: scope.historyGeneration, group_id: "assistant-group", partial_id: "assistant-partial", kind: "assistant", status: "delta", delta: "answer" });
  runtime.receive({ protocol_version: 2, type: "timeline_partial", session_id: scope.sessionId, history_generation: scope.historyGeneration, group_id: "assistant-group", partial_id: "thinking-partial", kind: "thinking", status: "delta", delta: "reasoning" });

  const changed = runtime.commit({
    event_id: "assistant-event",
    session_id: scope.sessionId,
    history_generation: scope.historyGeneration,
    timestamp: 3,
    group_id: "assistant-group",
    kind: "assistant",
    blocks: [
      { type: "thinking", text: "reasoning" },
      { type: "text", text: "answer" },
    ],
    status: "complete",
  });

  assert.equal(changed.items.some((item) => item.kind === "partial"), false);
});

test("renders and removes broadcast queued image state", () => {
  const runtime = new TimelineRuntime();
  runtime.setScope(scope);
  const queued = runtime.receive({
    protocol_version: 2,
    type: "queued_message_state",
    session_id: scope.sessionId,
    history_generation: scope.historyGeneration,
    snapshot_id: "snapshot-1",
    chunk_index: 0,
    final: true,
    items: [{ id: "queued-1", text: "inspect", images: [{ data: "aW1hZ2U=", mime: "image/png" }], editable: true, created_at: 4 }],
  });
  const pending = queued.items.find((item) => item.kind === "pending");
  assert.equal(pending?.delivery, "accepted");
  assert.equal(pending?.images?.[0].mime, "image/png");
  const cleared = runtime.receive({ protocol_version: 2, type: "queued_message_state", session_id: scope.sessionId, history_generation: scope.historyGeneration, snapshot_id: "snapshot-2", chunk_index: 0, final: true, items: [] });
  assert.equal(cleared.items.some((item) => item.kind === "pending" && item.clientRequestId === "queued-1"), false);
});

test("moves a locally rejected send to retryable unknown delivery", () => {
  const runtime = new TimelineRuntime();
  runtime.setScope(scope);
  const sent = runtime.sendUser("retry", [{ data: "aW1hZ2U=", mime: "image/png" }]);
  assert.ok(sent);
  const changed = runtime.receive({ protocol_version: 2, type: "protocol_error", in_reply_to: sent.frame.id, code: "too_large", message: "queue full" });
  assert.equal(changed.items.find((item) => item.kind === "pending")?.delivery, "unknown_delivery");
  const retried = runtime.retryUnknown(sent.frame.client_request_id);
  assert.equal(retried?.frame.client_request_id, sent.frame.client_request_id);
  assert.deepEqual(retried?.frame.images, sent.frame.images);
});

test("ignores queued state from an old timeline generation", () => {
  const runtime = new TimelineRuntime();
  runtime.setScope(scope);
  const changed = runtime.receive({ protocol_version: 2, type: "queued_message_state", session_id: scope.sessionId, history_generation: "old-generation", snapshot_id: "snapshot-old", chunk_index: 0, final: true, items: [{ id: "stale", text: "stale", editable: true, created_at: 1 }] });
  assert.equal(changed.items.some((item) => item.kind === "pending"), false);
});

test("allows pure image messages and retries unknown delivery with the same client request id", () => {
  const runtime = new TimelineRuntime();
  runtime.setScope(scope);
  const images = [{ data: "aW1hZ2U=", mime: "image/png" }];
  const sent = runtime.sendUser("", images);
  assert.ok(sent);
  assert.deepEqual(sent.frame.images, images);
  assert.equal(sent.change.items.find((item) => item.kind === "pending")?.images?.[0].data, images[0].data);

  runtime.receive({ protocol_version: 2, type: "user_message_status", target_channel_id: scope.channelId, in_reply_to: sent.frame.id, session_id: scope.sessionId, history_generation: scope.historyGeneration, client_request_id: sent.frame.client_request_id, status: "unknown_delivery" });
  const retried = runtime.retryUnknown(sent.frame.client_request_id);
  assert.ok(retried);
  assert.equal(retried.frame.client_request_id, sent.frame.client_request_id);
  assert.notEqual(retried.frame.id, sent.frame.id);
  assert.deepEqual(retried.frame.images, images);
});
