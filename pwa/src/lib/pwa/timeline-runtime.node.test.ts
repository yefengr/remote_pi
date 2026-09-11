import { expect, test } from "vitest";
import { TimelineRuntime, type TimelineScope } from "./timeline-runtime";
import type { ServerFrame } from "../remote-pi/protocol-v2/frames";
import type { TimelineEvent } from "../remote-pi/protocol-v2/schema";

const scope: TimelineScope = { deviceId: "device", endpointId: "endpoint", runtimeInstanceId: "runtime-a", sessionId: "session", historyGeneration: "generation", selfSenderRef: "self", channelId: "channel" };
function userEvent(messageId: string): Extract<TimelineEvent, { kind: "user" }> { return { event_id: messageId, message_id: messageId, session_id: scope.sessionId, history_generation: scope.historyGeneration, timestamp: 2, group_id: "group", kind: "user", blocks: [{ type: "text", text: "hello" }], origin: "pwa", sender_ref: scope.selfSenderRef, delivery: "normal", status: "committed" }; }
function partial(kind: "assistant" | "thinking", partialId: string): Extract<ServerFrame, { type: "timeline_partial" }> { return { protocol_version: 2, type: "timeline_partial", session_id: scope.sessionId, history_generation: scope.historyGeneration, group_id: "group", partial_id: partialId, kind, status: "delta", delta: "streaming" }; }

test("replaces pending output with a formal event in the matching live endpoint scope", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  const sent = runtime.sendUser("hello"); expect(sent).toBeTruthy();
  const started: ServerFrame = { protocol_version: 2, type: "user_message_started", target_channel_id: scope.channelId, in_reply_to: sent!.frame.id, session_id: scope.sessionId, history_generation: scope.historyGeneration, message: { id: "message", group_id: "group", blocks: [{ type: "text", text: "hello" }], origin: "pwa", sender_ref: scope.selfSenderRef, delivery: "normal" } };
  runtime.receive(started);
  const changed = runtime.replaceHistory([userEvent("message")]);
  expect(changed.items.some((item) => item.kind === "pending")).toBe(false);
  expect(changed.observed.map((frame) => frame.type)).toEqual(["user_message_observed"]);
});

test("replaces assistant and thinking partials with a provider error", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  runtime.receive(partial("assistant", "assistant-partial"));
  runtime.receive(partial("thinking", "thinking-partial"));
  const changed = runtime.receive({
    protocol_version: 2,
    type: "timeline_event",
    session_id: scope.sessionId,
    history_generation: scope.historyGeneration,
    event: { event_id: "error", session_id: scope.sessionId, history_generation: scope.historyGeneration, timestamp: 3, group_id: "group", kind: "provider_error", message: "failed" },
  });
  expect(changed.items.filter((item) => item.kind === "partial")).toEqual([]);
  expect(changed.items).toContainEqual(expect.objectContaining({ kind: "event", event: expect.objectContaining({ kind: "provider_error" }) }));
});

test("resets transient live state when a runtime is taken over", () => {
  const runtime = new TimelineRuntime(); runtime.setScope(scope); runtime.sendUser("hello");
  const changed = runtime.setScope({ ...scope, runtimeInstanceId: "runtime-b" });
  expect(changed.items.some((item) => item.kind === "pending" && item.delivery === "unknown_delivery")).toBe(true);
  expect(runtime.currentScope?.runtimeInstanceId).toBe("runtime-b");
});
