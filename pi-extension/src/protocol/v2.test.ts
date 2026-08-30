import { describe, expect, test } from "vitest";
import {
  DecodeError,
  MAX_ARRAY_ITEMS,
  MAX_FRAGMENT_DECODE_BYTES,
  MAX_FRAME_BYTES,
  MAX_HISTORY_CHUNK_BYTES,
  MAX_ID_CHARS,
  MAX_TEXT_CHARS,
  MAX_WINDOW_DECODE_BYTES,
  decodeClientFrameV2,
  decodeServerFrameV2,
  encodeClientFrameV2,
  encodeServerFrameV2,
  parseMarkerV2,
  parseTimelineEventV2,
  parseTimelinePartialV2,
  validateFragmentSizeV2,
  validateHistoryChunkSizeV2,
} from "./v2/index.js";

const version = { protocol_version: 2 as const };
const channel = { channel_id: "C1", history_generation: "G1" };
const direct = { target_channel_id: "C1" };
const session = { session_id: "S1", history_generation: "G1" };

function userEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "M1", session_id: "S1", history_generation: "G1", timestamp: 100,
    group_id: "GR1", kind: "user", message_id: "M1", blocks: [{ type: "text", text: "hello" }],
    origin: "pwa", sender_ref: "owner", delivery: "normal", status: "committed", ...overrides,
  };
}

function assistantEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "A1", session_id: "S1", history_generation: "G1", timestamp: 101,
    group_id: "GR1", kind: "assistant", blocks: [{ type: "text", text: "done" }], status: "complete", ...overrides,
  };
}

function toolEvent(status: "complete" | "error" | "interrupted" = "complete") {
  return {
    event_id: `T-${status}`, session_id: "S1", history_generation: "G1", timestamp: 102,
    group_id: "GR1", kind: "tool", tool_call_id: "TC1", tool: "read", args: { path: "a" }, truncated: false,
    status,
    ...(status === "complete" ? { result: { ok: true } } : status === "error" ? { error: "failed" } : {}),
  };
}

function expectCode(action: () => unknown, code: DecodeError["code"]): void {
  try {
    action();
    throw new Error("expected DecodeError");
  } catch (error) {
    expect(error).toBeInstanceOf(DecodeError);
    expect((error as DecodeError).code).toBe(code);
  }
}

const ask = {
  flow_id: "F1",
  tool_call_id: "TC1",
  source: "tool",
  title: "Pick one",
  questions: [{
    id: "q1",
    label: "Choice",
    prompt: "Choose",
    type: "single",
    required: true,
    presentedType: "single",
    requestedType: "single",
    options: [{ value: "yes", label: "Yes" }],
  }],
};

describe("v2 bounds and scalar schemas", () => {
  test("exports the frozen protocol limits", () => {
    expect(MAX_FRAME_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_HISTORY_CHUNK_BYTES).toBe(512 * 1024);
    expect(MAX_WINDOW_DECODE_BYTES).toBe(32 * 1024 * 1024);
    expect(MAX_FRAGMENT_DECODE_BYTES).toBe(50 * 1024);
    expect(MAX_ID_CHARS).toBe(256);
    expect(MAX_TEXT_CHARS).toBe(1024 * 1024);
    expect(MAX_ARRAY_ITEMS).toBe(4096);
  });

  test("requires non-negative finite timestamps and non-empty error text", () => {
    expectCode(() => parseTimelineEventV2(userEvent({ timestamp: -1 })), "schema");
    expectCode(() => parseTimelineEventV2(userEvent({ timestamp: Number.NaN })), "schema");
    expectCode(() => parseTimelineEventV2({ ...toolEvent("error"), error: "" }), "schema");
    expectCode(() => parseTimelineEventV2({ ...assistantEvent(), event_id: "P1", kind: "provider_error", group_id: "GR1", message: "" }), "schema");
  });

  test("validates image MIME, data and omitted branches", () => {
    const image = { type: "image", mime_type: "image/png", data: "abc", byte_length: 3 };
    expect(parseTimelineEventV2(userEvent({ blocks: [image] }))).toMatchObject({ blocks: [image] });
    expectCode(() => parseTimelineEventV2(userEvent({ blocks: [{ ...image, mime_type: "image" }] })), "schema");
    expectCode(() => parseTimelineEventV2(userEvent({ blocks: [{ ...image, data: "" }] })), "schema");
    expectCode(() => parseTimelineEventV2(userEvent({ blocks: [{ ...image, byte_length: MAX_WINDOW_DECODE_BYTES + 1 }] })), "schema");
    expectCode(() => parseTimelineEventV2(userEvent({ blocks: [{ type: "image", mime_type: "image/png", data: "abc", byte_length: 3, omitted: true }] })), "schema");
    expect(parseTimelineEventV2(userEvent({ blocks: [{ type: "image", mime_type: "image/png", byte_length: 0, omitted: true }] }))).toBeTruthy();
  });
});

describe("Protocol v2 client frames", () => {
  test("accepts the closed client catalog, including queue and approval frames", () => {
    const frames = [
      { ...version, type: "pair_request", id: "P1", token: "token", device_name: "phone" },
      { ...version, type: "session_hello", id: "H1", channel_id: "C1" },
      { ...version, type: "user_message", id: "U1", ...channel, client_request_id: "R1", text: "hello", images: [{ data: "abc", mime: "image/png" }] },
      { ...version, type: "user_message_observed", id: "O1", ...channel, client_request_id: "R1", message_id: "M1", status: "committed" },
      { ...version, type: "session_sync", id: "Y1", ...channel, before: null, limit: 5 },
      { ...version, type: "ping", id: "Q1", ...channel },
      { ...version, type: "cancel", id: "X1", ...channel },
      { ...version, type: "session_new", id: "N1", ...channel },
      { ...version, type: "session_compact", id: "N2", ...channel },
      { ...version, type: "model_set", id: "N3", ...channel, provider: "openai", model_id: "model" },
      { ...version, type: "thinking_set", id: "N4", ...channel, level: "high" },
      { ...version, type: "list_models", id: "N5", ...channel },
      { ...version, type: "queued_message_set", id: "N6", ...channel, text: "later", images: [{ data: "abc", mime: "image/png" }] },
      { ...version, type: "queued_message_clear", id: "N7", ...channel },
      { ...version, type: "approve_tool", id: "N8", ...channel, tool_call_id: "TC1", decision: "allow" },
    ];
    for (const frame of frames) expect(decodeClientFrameV2(frame).protocol_version).toBe(2);
    expectCode(() => decodeClientFrameV2({ ...version, type: "cancel", id: "X2", ...channel, target_id: "R1" }), "schema");
  });

  test("round-trips ask responses with the existing camelCase inner keys", () => {
    const frame = { ...version, type: "extension_ui_response", id: "UI1", ...channel, ask: { flow_id: "F1", kind: "answer", answers: { q1: { values: ["yes"], customText: "extra", optionNotes: { yes: "note" } } } } };
    const encoded = encodeClientFrameV2(frame);
    expect(decodeClientFrameV2(encoded)).toEqual(frame);
    expectCode(() => decodeClientFrameV2({ ...frame, ask: { ...frame.ask, answers: { q1: { custom_text: "wrong" } } } }), "schema");
  });

  test("does not classify server-only frames as client frames", () => {
    expectCode(() => decodeClientFrameV2({ ...version, type: "timeline_event", ...session, event: userEvent() }), "direction");
    expectCode(() => decodeClientFrameV2({ ...version, type: "pong", ...direct, in_reply_to: "Q1" }), "direction");
  });
});

describe("TimelineEvent and TimelinePartial", () => {
  test("accepts user, assistant, all tool statuses and system branches", () => {
    const events = [
      userEvent(), assistantEvent(), toolEvent("complete"), toolEvent("error"), toolEvent("interrupted"),
      { event_id: "SYS-compaction", session_id: "S1", history_generation: "G1", timestamp: 103, kind: "compaction", payload: { name: "compaction" }, truncated: false },
      { event_id: "SYS-branch", session_id: "S1", history_generation: "G1", timestamp: 104, group_id: "GR1", kind: "branch_summary", payload: { name: "branch" }, truncated: false },
      { event_id: "PE1", session_id: "S1", history_generation: "G1", timestamp: 105, group_id: "GR1", kind: "provider_error", message: "provider down" },
    ];
    for (const event of events) expect(parseTimelineEventV2(event).event_id).toBe(event.event_id);
  });

  test("requires sender identity for PWA users and forbids client-reported identity elsewhere", () => {
    const missingSender = { ...userEvent() };
    delete (missingSender as Record<string, unknown>).sender_ref;
    expectCode(() => parseTimelineEventV2(missingSender), "schema");

    const extensionWithSender = userEvent({ origin: "extension" });
    expectCode(() => parseTimelineEventV2(extensionWithSender), "schema");

    const extensionWithoutSender = { ...extensionWithSender };
    delete (extensionWithoutSender as Record<string, unknown>).sender_ref;
    expect(parseTimelineEventV2(extensionWithoutSender).origin).toBe("extension");
  });

  test("accepts only the flat partial shape and rejects nested/event_id variants", () => {
    const assistant = { ...version, type: "timeline_partial", ...session, group_id: "GR1", partial_id: "PA1", kind: "assistant", status: "running", delta: "hel" };
    const thinking = { ...version, type: "timeline_partial", ...session, group_id: "GR1", partial_id: "PT1", kind: "thinking", status: "delta", blocks: [{ type: "thinking", text: "reason" }] };
    const tool = { ...version, type: "timeline_partial", ...session, group_id: "GR1", partial_id: "PL1", kind: "tool", status: "running", tool_call_id: "TC1", tool: "read", args: { path: "a" } };
    expect(decodeServerFrameV2(assistant)).toEqual(assistant);
    expect(decodeServerFrameV2(thinking)).toEqual(thinking);
    expect(parseTimelinePartialV2(tool)).toEqual(tool);
    expectCode(() => decodeServerFrameV2({ ...assistant, partial: assistant }), "schema");
    expectCode(() => decodeServerFrameV2({ ...assistant, event_id: "A1" }), "schema");
    expectCode(() => decodeServerFrameV2({ ...assistant, kind: "user" }), "schema");
  });
});

describe("Protocol v2 server frames", () => {
  test("accepts started message, all status branches, timeline, fragments and history chunks", () => {
    const pairOk = { ...version, type: "pair_ok", in_reply_to: "P1", session_name: "demo", session_started_at: 1, endpoint_id: "E" };
    const pairError = { ...version, type: "pair_error", in_reply_to: "P2", code: "token_expired", message: "expired" };
    const ready = { ...version, type: "session_ready", in_reply_to: "H1", ...direct, ...session, self_sender_ref: "owner" };
    const started = { ...version, type: "user_message_started", ...direct, in_reply_to: "R1", ...session, message: { id: "M1", group_id: "GR1", blocks: [{ type: "text", text: "hello" }], origin: "pwa", sender_ref: "owner", delivery: "normal" } };
    const statuses = [
      { ...version, type: "user_message_status", ...direct, in_reply_to: "R1", ...session, client_request_id: "R1", status: "received" },
      { ...version, type: "user_message_status", ...direct, in_reply_to: "R1", ...session, client_request_id: "R1", status: "accepted", message_id: "M1", group_id: "GR1" },
      { ...version, type: "user_message_status", ...direct, in_reply_to: "R1", ...session, client_request_id: "R1", status: "committed", message_id: "M1", group_id: "GR1" },
      { ...version, type: "user_message_status", ...direct, in_reply_to: "R1", ...session, client_request_id: "R1", status: "unknown_delivery" },
    ];
    const timeline = { ...version, type: "timeline_event", ...session, event: userEvent() };
    const queuedState = { ...version, type: "queued_message_state", ...session, snapshot_id: "SNAP1", chunk_index: 0, final: true, items: [{ id: "Q1", text: "queued image", images: [{ data: "abc", mime: "image/png" }], editable: true, created_at: 1 }] };
    const fragment = { ...version, type: "timeline_event_fragment", ...session, event_id: "A1", index: 0, data_base64: "eA==", final: true };
    const chunks = [
      { ...version, type: "session_history_chunk", ...direct, in_reply_to: "Y1", ...session, snapshot_head: "HEAD", chunk_index: 0, events: [userEvent()], fragments: [], final_chunk: false },
      { ...version, type: "session_history_chunk", ...direct, in_reply_to: "Y1", ...session, snapshot_head: "HEAD", chunk_index: 1, events: [], fragments: [], final_chunk: true, eos: true },
      { ...version, type: "session_history_chunk", ...direct, in_reply_to: "Y1", ...session, snapshot_head: "HEAD", chunk_index: 2, events: [], fragments: [{ event_id: "A1", index: 0, data_base64: "eA==", final: true }], final_chunk: true, eos: false, next_before: "CURSOR" },
    ];
    for (const frame of [pairOk, pairError, ready, started, ...statuses, timeline, queuedState, fragment, ...chunks]) {
      expect(decodeServerFrameV2(frame).protocol_version).toBe(2);
    }
    expect(validateFragmentSizeV2(fragment)).toBe(1);
    expect(validateHistoryChunkSizeV2(chunks[0])).toBeLessThanOrEqual(MAX_HISTORY_CHUNK_BYTES);
  });

  test("uses strict direct/broadcast branches for control and extension UI frames", () => {
    const request = { ...version, type: "extension_ui_request", ...direct, id: "UI1", method: "select", title: "Pick", options: ["one"], ask };
    const frames = [
      { ...version, type: "protocol_error", ...direct, code: "too_large", message: "too large" },
      { ...version, type: "protocol_error", code: "invalid_generation", message: "generation changed" },
      { ...version, type: "reset", ...direct, ...session, reason: "generation_changed" },
      { ...version, type: "pong", ...direct, in_reply_to: "Q1" },
      { ...version, type: "cancelled", ...direct, in_reply_to: "X1" },
      { ...version, type: "action_ok", ...direct, in_reply_to: "N1", action: "session_new" },
      { ...version, type: "action_error", ...direct, in_reply_to: "N2", action: "session_compact", error: "busy" },
      { ...version, type: "models_list", ...direct, in_reply_to: "N5", models: [{ id: "m", name: "M", provider: "p", reasoning: true, context_window: 100, vision: false }] },
      { ...version, type: "queued_message_state", ...session, snapshot_id: "SNAP2", chunk_index: 0, final: true, items: [] },
      request,
      { ...version, type: "bye", ...session, reason: "shutdown" },
    ];
    for (const frame of frames) expect(decodeServerFrameV2(frame).protocol_version).toBe(2);
    expectCode(() => decodeServerFrameV2({ ...version, type: "cancelled", ...direct, in_reply_to: "X2", target_id: "R1" }), "schema");
    expectCode(() => decodeServerFrameV2({ ...version, type: "timeline_event", ...session, event: userEvent(), target_channel_id: "C1" }), "schema");
    expectCode(() => decodeServerFrameV2({ ...version, type: "bye", ...session, target_channel_id: "C1", reason: "shutdown" }), "schema");
    expectCode(() => decodeServerFrameV2({ ...version, type: "protocol_error", ...direct, code: "invalid_message", message: "bad", extra: true }), "schema");
    expectCode(() => decodeServerFrameV2({ ...request, ask: { ...ask, questions: [{ ...ask.questions[0], presented_type: "single" }] } }), "schema");
  });

  test("requires direct targets and exact user-message status fields", () => {
    const base = { ...version, type: "user_message_status", ...direct, in_reply_to: "R1", ...session, client_request_id: "R1" };
    expectCode(() => decodeServerFrameV2({ ...version, type: "session_ready", in_reply_to: "H1", ...session }), "schema");
    expectCode(() => decodeServerFrameV2({ ...base, status: "received", message: { id: "M1" } }), "schema");
    expectCode(() => decodeServerFrameV2({ ...base, status: "unknown_delivery", group_id: "GR1" }), "schema");
    expectCode(() => decodeServerFrameV2({ ...base, status: "committed" }), "schema");
  });

  test("binds sender identity on started user messages to their origin", () => {
    const started = { ...version, type: "user_message_started", ...direct, in_reply_to: "R1", ...session, message: { id: "M1", group_id: "GR1", blocks: [{ type: "text", text: "hello" }], origin: "pwa", sender_ref: "owner", delivery: "normal" } };
    const missingSender = { ...started, message: { ...started.message } };
    delete (missingSender.message as Record<string, unknown>).sender_ref;
    expectCode(() => decodeServerFrameV2(missingSender), "schema");

    const extensionWithSender = { ...started, message: { ...started.message, origin: "extension" } };
    expectCode(() => decodeServerFrameV2(extensionWithSender), "schema");

    const extensionWithoutSender = { ...extensionWithSender, message: { ...extensionWithSender.message } };
    delete (extensionWithoutSender.message as Record<string, unknown>).sender_ref;
    expect(decodeServerFrameV2(extensionWithoutSender)).toMatchObject({ type: "user_message_started", message: { origin: "extension" } });
  });
});

describe("strict boundary and size errors", () => {
  test("classifies missing/version/unknown type and wrong direction", () => {
    expectCode(() => decodeClientFrameV2({ type: "ping", id: "Q1", ...channel }), "version");
    expectCode(() => decodeClientFrameV2({ ...version, type: "ping", id: "Q1", ...channel, protocol_version: 1 }), "version");
    expectCode(() => decodeClientFrameV2({ ...version, type: "made_up" }), "unsupported");
    expectCode(() => decodeClientFrameV2({ ...version, type: "ping", id: "Q1", ...channel, extra: true }), "schema");
  });

  test("enforces the 2 MiB frame limit for raw decode and both encoders", () => {
    const oversized = { ...version, type: "user_message", id: "U1", ...channel, client_request_id: "R1", text: "x".repeat(MAX_FRAME_BYTES) };
    expectCode(() => decodeClientFrameV2(oversized), "size");
    expectCode(() => encodeClientFrameV2(oversized as never), "size");
    expectCode(() => decodeClientFrameV2({
      ...version,
      type: "queued_message_set",
      id: "N6",
      ...channel,
      text: "later",
      images: [{ data: "abc", mime: "image/png", unexpected: true }],
    }), "schema");
    expectCode(() => encodeServerFrameV2({ ...version, type: "protocol_error", code: "too_large", message: "x".repeat(MAX_FRAME_BYTES) } as never), "size");
    const padded = `${" ".repeat(MAX_FRAME_BYTES)}{"protocol_version":2,"type":"ping","id":"Q1","channel_id":"C1","history_generation":"G1"}`;
    expectCode(() => decodeClientFrameV2(padded), "size");
  });

  test("enforces decoded fragment limits in the default server decoder", () => {
    const data_base64 = Buffer.alloc(MAX_FRAGMENT_DECODE_BYTES + 1).toString("base64");
    const fragment = { ...version, type: "timeline_event_fragment", ...session, event_id: "A1", index: 0, data_base64, final: true };
    expectCode(() => validateFragmentSizeV2(fragment), "size");
    expectCode(() => decodeServerFrameV2(fragment), "size");
    const chunk = { ...version, type: "session_history_chunk", ...direct, in_reply_to: "Y1", ...session, snapshot_head: "HEAD", chunk_index: 0, events: [], fragments: [{ event_id: "A1", index: 0, data_base64, final: true }], final_chunk: true, eos: true };
    expectCode(() => decodeServerFrameV2(chunk), "size");
  });

  test("rejects invalid history final rules and duplicate/overlapping fragments", () => {
    const base = { ...version, type: "session_history_chunk", ...direct, in_reply_to: "Y1", ...session, snapshot_head: "HEAD", chunk_index: 0, events: [], fragments: [] };
    expectCode(() => decodeServerFrameV2({ ...base, final_chunk: false, eos: true }), "schema");
    expectCode(() => decodeServerFrameV2({ ...base, final_chunk: true, eos: false }), "schema");
    expectCode(() => decodeServerFrameV2({ ...base, final_chunk: true, eos: true, next_before: "CURSOR" }), "schema");
    const fragment = { event_id: "A1", index: 0, data_base64: "eA==", final: true };
    expectCode(() => decodeServerFrameV2({ ...base, final_chunk: true, eos: true, fragments: [fragment, fragment] }), "schema");
    expectCode(() => decodeServerFrameV2({ ...base, final_chunk: true, eos: true, events: [userEvent({ event_id: "A1", message_id: "A1" })], fragments: [fragment] }), "schema");
  });

  test("marker is closed and binds sender identity to PWA users", () => {
    const marker = { version: 2, event_id: "M1", group_id: "GR1", kind: "user", origin: "pwa", delivery: "normal", sender_ref: "owner" };
    expect(parseMarkerV2(marker)).toEqual(marker);

    const missingSender = { ...marker };
    delete (missingSender as Record<string, unknown>).sender_ref;
    expectCode(() => parseMarkerV2(missingSender), "schema");
    expectCode(() => parseMarkerV2({ ...marker, origin: "extension" }), "schema");
    const extensionWithoutSender = { ...marker, origin: "extension" };
    delete (extensionWithoutSender as Record<string, unknown>).sender_ref;
    expect(parseMarkerV2(extensionWithoutSender).origin).toBe("extension");

    expectCode(() => parseMarkerV2({ ...marker, body: "hello" }), "schema");
    expectCode(() => parseMarkerV2({ ...marker, client_request_id: "R1" }), "schema");
    expectCode(() => parseMarkerV2({ ...marker, channel_id: "C1" }), "schema");
    expectCode(() => parseMarkerV2({ ...marker, request_id: "R1" }), "schema");
    expectCode(() => parseMarkerV2({ ...marker, message_id: "M2" }), "schema");
  });

  test("encoders parse strictly before serializing", () => {
    const frame = { ...version, type: "ping", id: "Q1", ...channel };
    expect(JSON.parse(encodeClientFrameV2(frame))).toEqual(frame);
    expectCode(() => encodeClientFrameV2({ ...frame, extra: true } as never), "schema");
    expectCode(() => encodeServerFrameV2({ ...version, type: "ping", id: "Q1", ...channel } as never), "direction");
  });
});
