import { describe, expect, test, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ClientFrame } from "../protocol/v2/index.js";
import { TimelineRuntime } from "./runtime.js";
import { TimelineV2Service } from "./v2_service.js";

function hello(channelId = "channel-1"): Extract<ClientFrame, { type: "session_hello" }> {
  return { protocol_version: 2, type: "session_hello", id: "hello-1", channel_id: channelId };
}

function user(
  generation: string,
  overrides: Partial<Extract<ClientFrame, { type: "user_message" }>> = {},
): Extract<ClientFrame, { type: "user_message" }> {
  return {
    protocol_version: 2,
    type: "user_message",
    id: "wire-1",
    channel_id: "channel-1",
    history_generation: generation,
    client_request_id: "request-1",
    text: "hello",
    ...overrides,
  };
}

describe("TimelineV2Service", () => {
  test("requires hello and returns direct ready with server-derived sender ref", () => {
    const session = SessionManager.inMemory(process.cwd());
    const runtime = new TimelineRuntime();
    const service = new TimelineV2Service({ sessionManager: session, senderRef: "owner-1", runtime, onUserMessage: () => false });
    expect(service.handle(user(service.generation))[0]).toMatchObject({ type: "protocol_error", code: "invalid_channel", target_channel_id: "channel-1" });
    expect(service.handle(hello())[0]).toMatchObject({
      type: "session_ready",
      target_channel_id: "channel-1",
      self_sender_ref: "owner-1",
      session_id: session.getSessionId(),
      history_generation: service.generation,
    });
  });

  test("keeps an explicit generation stable until the owner rotates it", () => {
    const session = SessionManager.inMemory(process.cwd());
    const service = new TimelineV2Service({
      sessionManager: session,
      senderRef: "owner-1",
      generation: "generation-1",
      runtime: new TimelineRuntime(),
      onUserMessage: () => false,
    });
    expect(service.handle(hello())[0]).toMatchObject({ history_generation: "generation-1" });
    expect(service.handle({
      protocol_version: 2,
      type: "ping",
      id: "ping-1",
      channel_id: "channel-1",
      history_generation: "generation-1",
    })[0]).toMatchObject({ type: "pong" });
    expect(service.generation).toBe("generation-1");

    expect(service.refreshGeneration("generation-2")).toBe(true);
    expect(service.generation).toBe("generation-2");
    expect(service.handle(user("generation-1"))[0]).toMatchObject({
      type: "reset",
      reason: "generation_changed",
      history_generation: "generation-2",
      target_channel_id: "channel-1",
    });
  });

  test("rejects old generation after hello", () => {
    const session = SessionManager.inMemory(process.cwd());
    const service = new TimelineV2Service({ sessionManager: session, senderRef: "owner-1", runtime: new TimelineRuntime(), onUserMessage: () => false });
    service.handle(hello());
    expect(service.handle(user("old"))[0]).toMatchObject({ type: "reset", reason: "generation_changed", target_channel_id: "channel-1" });
  });

  test("accepts reliable user once and replays idempotent status without a second SDK call", () => {
    const session = SessionManager.inMemory(process.cwd());
    const runtime = new TimelineRuntime();
    let correlation: Parameters<TimelineRuntime["runWithCorrelation"]>[0] | undefined;
    const send = vi.fn((_frame: unknown, value: Parameters<TimelineRuntime["runWithCorrelation"]>[0]) => {
      correlation = value;
      return true;
    });
    const service = new TimelineV2Service({ sessionManager: session, senderRef: "owner-1", runtime, onUserMessage: send });
    service.handle(hello());
    const first = service.handle(user(service.generation));
    expect(first).toEqual([expect.objectContaining({ type: "user_message_status", status: "received" })]);
    const message = { role: "user", content: "hello", timestamp: 1 };
    runtime.onAgentStart();
    const started = runtime.runWithCorrelation(correlation!, () => runtime.onMessageStart(message, session));
    expect(service.started(started!)[1]).toMatchObject({
      type: "user_message_started",
      message: { origin: "pwa", sender_ref: "owner-1", delivery: "normal" },
    });
    const replay = service.handle(user(service.generation, { id: "wire-2" }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(replay[0]).toMatchObject({ type: "user_message_status", status: "accepted" });
  });

  test("rejects same id with different payload and marks steer delivery unknown", () => {
    const session = SessionManager.inMemory(process.cwd());
    const service = new TimelineV2Service({ sessionManager: session, senderRef: "owner-1", runtime: new TimelineRuntime(), onUserMessage: () => false });
    service.handle(hello());
    expect(service.handle(user(service.generation, { streaming_behavior: "steer" }))[0]).toMatchObject({ type: "user_message_status", status: "unknown_delivery" });
    expect(service.handle(user(service.generation, { id: "wire-2", text: "different", streaming_behavior: "steer" }))[0]).toMatchObject({ type: "protocol_error", code: "invalid_message" });
  });

  test("observed clears the idempotency record after commit", () => {
    const session = SessionManager.inMemory(process.cwd());
    const service = new TimelineV2Service({ sessionManager: session, senderRef: "owner-1", runtime: new TimelineRuntime(), onUserMessage: () => true });
    service.handle(hello());
    service.handle(user(service.generation));
    const observed = service.handle({
      protocol_version: 2,
      type: "user_message_observed",
      id: "observed-1",
      channel_id: "channel-1",
      history_generation: service.generation,
      client_request_id: "request-1",
      message_id: "message-1",
      status: "committed",
    });
    expect(observed).toEqual([]);
    expect(service.handle(user(service.generation, { id: "wire-2" }))[0]).toMatchObject({ type: "user_message_status", status: "received" });
  });

  test("serves branch history as direct v2 chunks and broadcasts formal events without channel id", () => {
    const session = SessionManager.inMemory(process.cwd());
    const messageId = session.appendMessage({ role: "user", content: "legacy", timestamp: 1 } as never);
    const runtime = new TimelineRuntime({ getHistoryGeneration: () => session.getSessionId() });
    const service = new TimelineV2Service({ sessionManager: session, senderRef: "owner-1", runtime, onUserMessage: () => false });
    service.handle(hello());
    const frames = service.handle({
      protocol_version: 2,
      type: "session_sync",
      id: "sync-1",
      channel_id: "channel-1",
      history_generation: service.generation,
      before: null,
    });
    expect(frames[0]).toMatchObject({ type: "session_history_chunk", target_channel_id: "channel-1", final_chunk: true, eos: true });
    const event = runtime.recover(session)[0]!;
    expect(event.event_id).toBe(`legacy:${messageId}`);
    const broadcast = service.publish(event);
    expect(broadcast).toMatchObject({ type: "timeline_event", session_id: session.getSessionId() });
    expect(broadcast).not.toHaveProperty("target_channel_id");
  });
});
