import { expect, test } from "vitest";
import {
  DecodeError,
  MAX_ARRAY_ITEMS,
  MAX_FRAGMENT_BYTES,
  MAX_FRAME_BYTES,
  MAX_HISTORY_CHUNK_BYTES,
  MAX_ID_CHARS,
  MAX_STRING_CHARS,
  MAX_WINDOW_BYTES,
  decodeClientFrameV2,
  decodeServerFrameV2,
  encodeClientFrameV2,
  encodeServerFrameV2,
  parseTimelineEventV2,
  validateFragmentSizeV2,
  validateHistoryChunkSizeV2,
  type ClientFrame,
} from "./protocol-v2";

const version = { protocol_version: 2 as const };
const channel = { channel_id: "C1", history_generation: "G1" };
const session = { session_id: "S1", history_generation: "G1" };
const direct = { target_channel_id: "C1" };

function userEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "M1", session_id: "S1", history_generation: "G1", timestamp: 100,
    group_id: "GR1", kind: "user", message_id: "M1", blocks: [{ type: "text", text: "hello" }],
    origin: "pwa", sender_ref: "sender-1", delivery: "normal", status: "committed", ...overrides,
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
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DecodeError);
  expect((thrown as DecodeError).code).toBe(code);
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

test("exports the frozen limits and validates scalar/event invariants", () => {
  expect(MAX_FRAME_BYTES).toBe(2 * 1024 * 1024);
  expect(MAX_HISTORY_CHUNK_BYTES).toBe(512 * 1024);
  expect(MAX_WINDOW_BYTES).toBe(32 * 1024 * 1024);
  expect(MAX_FRAGMENT_BYTES).toBe(50 * 1024);
  expect(MAX_ID_CHARS).toBe(256);
  expect(MAX_STRING_CHARS).toBe(1024 * 1024);
  expect(MAX_ARRAY_ITEMS).toBe(4096);

  expect(parseTimelineEventV2(userEvent())).toEqual(userEvent());
  for (const event of [assistantEvent(), toolEvent("complete"), toolEvent("error"), toolEvent("interrupted")]) {
    expect(parseTimelineEventV2(event).event_id).toBe(event.event_id);
  }
  expect(parseTimelineEventV2({
    event_id: "SYS1", session_id: "S1", history_generation: "G1", timestamp: 103,
    kind: "custom", payload: { ok: true }, truncated: false,
  })).toEqual({
    event_id: "SYS1", session_id: "S1", history_generation: "G1", timestamp: 103,
    kind: "custom", payload: { ok: true }, truncated: false,
  });
  expectCode(() => parseTimelineEventV2(userEvent({ timestamp: -1 })), "schema");
  expectCode(() => parseTimelineEventV2(userEvent({ timestamp: Number.NaN })), "schema");
  expectCode(() => parseTimelineEventV2({ ...toolEvent("error"), error: "" }), "schema");
});

test("enforces image MIME/data/omitted and sender identity rules", () => {
  const image = { type: "image", mime_type: "image/png", data: "abc", byte_length: 3 };
  expect(parseTimelineEventV2(userEvent({ blocks: [image] }))).toEqual(userEvent({ blocks: [image] }));
  expect(parseTimelineEventV2(userEvent({ blocks: [{ type: "image", mime_type: "image/png", byte_length: 0, omitted: true }] }))).toEqual(userEvent({ blocks: [{ type: "image", mime_type: "image/png", byte_length: 0, omitted: true }] }));
  expectCode(() => parseTimelineEventV2(userEvent({ blocks: [{ ...image, mime_type: "image" }] })), "schema");
  expectCode(() => parseTimelineEventV2(userEvent({ blocks: [{ ...image, data: "" }] })), "schema");
  expectCode(() => parseTimelineEventV2(userEvent({ blocks: [{ ...image, data: "abc", omitted: true }] })), "schema");
  expectCode(() => parseTimelineEventV2(userEvent({ sender_ref: undefined })), "schema");
  expectCode(() => parseTimelineEventV2(userEvent({ origin: "extension", sender_ref: "forged" })), "schema");
  expect(parseTimelineEventV2(userEvent({ origin: "extension", sender_ref: undefined }))).toEqual(userEvent({ origin: "extension", sender_ref: undefined }));
});

test("accepts the closed client catalog, including queue, approval and strict ask frames", () => {
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

  const askResponse: Extract<ClientFrame, { type: "extension_ui_response" }> = { ...version, type: "extension_ui_response", id: "UI1", ...channel, ask: { flow_id: "F1", kind: "answer", answers: { q1: { values: ["yes"], customText: "extra", optionNotes: { yes: "note" } } } } };
  const encoded = encodeClientFrameV2(askResponse);
  expect(encoded).toBeInstanceOf(Uint8Array);
  expect(decodeClientFrameV2(encoded)).toEqual(askResponse);
  expectCode(() => decodeClientFrameV2({ ...askResponse, ask: { ...askResponse.ask, answers: { q1: { custom_text: "wrong" } } } }), "schema");
  expectCode(() => decodeClientFrameV2({ ...askResponse, ask: { ...askResponse.ask, answers: { q1: { optionNotes: { yes: "note" }, extra: true } } } }), "schema");
  expectCode(() => decodeClientFrameV2({ ...version, type: "user_message", id: "U2", ...channel, client_request_id: "R2", text: "", images: [{ data: "abc", mime: "image/png" }, { data: "def", mime: "image/jpeg" }] }), "schema");
  expectCode(() => decodeClientFrameV2({ ...askResponse, extra: true }), "schema");
  expectCode(() => decodeClientFrameV2({ ...version, type: "cancel", id: "X1", ...channel, target_id: "R1" }), "schema");
});

test("accepts server frames while rejecting old wrappers and direction drift", () => {
  const ready = { ...version, type: "session_ready", ...direct, in_reply_to: "H1", session_id: "S1", history_generation: "G1", self_sender_ref: "sender-1" };
  const started = { ...version, type: "user_message_started", ...direct, in_reply_to: "R1", ...session, message: { id: "M1", group_id: "GR1", blocks: [{ type: "text", text: "hello" }], origin: "pwa", sender_ref: "sender-1", delivery: "normal" } };
  const statuses = [
    { ...version, type: "user_message_status", ...direct, in_reply_to: "R1", ...session, client_request_id: "R1", status: "received" },
    { ...version, type: "user_message_status", ...direct, in_reply_to: "R1", ...session, client_request_id: "R1", status: "accepted", message_id: "M1", group_id: "GR1" },
    { ...version, type: "user_message_status", ...direct, in_reply_to: "R1", ...session, client_request_id: "R1", status: "committed", message_id: "M1", group_id: "GR1" },
    { ...version, type: "user_message_status", ...direct, in_reply_to: "R1", ...session, client_request_id: "R1", status: "unknown_delivery" },
  ];
  const frames = [
    { ...version, type: "pair_ok", in_reply_to: "P1", session_name: "demo", session_started_at: 1, endpoint_id: "E" },
    { ...version, type: "pair_error", in_reply_to: "P2", code: "token_expired", message: "expired" },
    ready,
    started,
    ...statuses,
    { ...version, type: "timeline_event", ...session, event: userEvent() },
    { ...version, type: "timeline_partial", ...session, group_id: "GR1", partial_id: "PA1", kind: "assistant", status: "running", delta: "hel" },
    { ...version, type: "timeline_event_fragment", ...session, event_id: "A1", index: 0, data_base64: "eA==", final: true },
    { ...version, type: "session_history_chunk", ...direct, in_reply_to: "Y1", ...session, snapshot_head: "HEAD", chunk_index: 0, events: [userEvent()], fragments: [], final_chunk: true, eos: true },
    { ...version, type: "protocol_error", ...direct, code: "too_large", message: "too large" },
    { ...version, type: "protocol_error", code: "invalid_generation", message: "generation changed" },
    { ...version, type: "reset", ...direct, ...session, reason: "conflict" },
    { ...version, type: "pong", ...direct, in_reply_to: "Q1" },
    { ...version, type: "cancelled", ...direct, in_reply_to: "X1" },
    { ...version, type: "action_ok", ...direct, in_reply_to: "N1", action: "session_new" },
    { ...version, type: "action_error", ...direct, in_reply_to: "N2", action: "session_compact", error: "busy" },
    { ...version, type: "models_list", ...direct, in_reply_to: "N5", models: [] },
    { ...version, type: "queued_message_state", ...session, snapshot_id: "SNAP1", chunk_index: 0, final: true, items: [{ id: "Q1", text: "queued image", images: [{ data: "abc", mime: "image/png" }], editable: true, created_at: 1 }] },
    { ...version, type: "extension_ui_request", ...direct, id: "UI1", method: "select", title: "Pick", options: ["one"], ask },
    { ...version, type: "bye", ...session, reason: "shutdown" },
  ];
  for (const frame of frames) expect(decodeServerFrameV2(frame).protocol_version).toBe(2);
  expectCode(() => decodeClientFrameV2({ ...version, type: "timeline_event", ...session, event: userEvent() }), "direction");
  expectCode(() => decodeServerFrameV2({ ...version, type: "ping", id: "Q1", ...channel }), "direction");
  expectCode(() => decodeServerFrameV2({ ...version, type: "timeline_partial", ...session, group_id: "GR1", partial_id: "PA1", kind: "assistant", status: "running", partial: {} }), "schema");
  expectCode(() => decodeServerFrameV2({ ...version, type: "timeline_partial", ...session, group_id: "GR1", partial_id: "PA1", kind: "assistant", status: "running", event_id: "A1" }), "schema");
  expectCode(() => decodeServerFrameV2({ ...ready, extra: true }), "schema");
  expectCode(() => decodeServerFrameV2({ ...version, type: "cancelled", ...direct, in_reply_to: "X1", target_id: "R1" }), "schema");
});

test("validates fragments and history chunk overlap/final rules", () => {
  const fragment = { ...version, type: "timeline_event_fragment", ...session, event_id: "A1", index: 0, data_base64: "eA==", final: true };
  expect(validateFragmentSizeV2(fragment)).toBe(1);
  const base = { ...version, type: "session_history_chunk", ...direct, in_reply_to: "Y1", ...session, snapshot_head: "HEAD", chunk_index: 0, events: [], fragments: [] };
  expect(decodeServerFrameV2({ ...base, final_chunk: true, eos: true }).type).toBe("session_history_chunk");
  expect(decodeServerFrameV2({ ...base, final_chunk: true, eos: false, next_before: "NEXT" }).type).toBe("session_history_chunk");
  expect(validateHistoryChunkSizeV2({ ...base, final_chunk: true, eos: true })).toBe(getUtf8Size({ ...base, final_chunk: true, eos: true }));
  expectCode(() => decodeServerFrameV2({ ...base, final_chunk: false, eos: true }), "schema");
  expectCode(() => decodeServerFrameV2({ ...base, final_chunk: true }), "schema");
  expectCode(() => decodeServerFrameV2({ ...base, final_chunk: true, eos: false }), "schema");
  expectCode(() => decodeServerFrameV2({ ...base, final_chunk: true, eos: true, next_before: "NEXT" }), "schema");
  expectCode(() => decodeServerFrameV2({ ...base, final_chunk: true, eos: true, fragments: [fragment, fragment] }), "schema");
  expectCode(() => decodeServerFrameV2({ ...base, final_chunk: true, eos: true, events: [userEvent({ event_id: "A1", message_id: "A1" })], fragments: [{ event_id: "A1", index: 0, data_base64: "eA==", final: true }] }), "schema");

  const oversizedFragment = { ...fragment, data_base64: Buffer.alloc(MAX_FRAGMENT_BYTES + 1).toString("base64") };
  expectCode(() => validateFragmentSizeV2(oversizedFragment), "size");
  expectCode(() => decodeServerFrameV2(oversizedFragment), "size");
});

test("enforces the 2 MiB boundary for raw decode and both encoders", () => {
  const oversized = { ...version, type: "user_message", id: "U1", ...channel, client_request_id: "R1", text: "x".repeat(MAX_FRAME_BYTES) };
  expectCode(() => decodeClientFrameV2(oversized), "size");
  expectCode(() => encodeClientFrameV2(oversized as never), "size");
  expectCode(() => encodeServerFrameV2({ ...version, type: "protocol_error", code: "too_large", message: "x".repeat(MAX_FRAME_BYTES) } as never), "size");
  const padded = `${" ".repeat(MAX_FRAME_BYTES)}{"protocol_version":2,"type":"ping","id":"Q1","channel_id":"C1","history_generation":"G1"}`;
  expectCode(() => decodeClientFrameV2(padded), "size");
});

function getUtf8Size(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
