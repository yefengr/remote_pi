import assert from "node:assert/strict";
import test from "node:test";
import { HistoryWindowAssembler, TimelineEventFragmentAssembler } from "./timeline-transfer";
import type { HistoryChunkFrame, TimelineEventFragmentFrame } from "./timeline-transfer";
import type { TimelineEvent } from "../remote-pi/protocol-v2/schema";

const scope = { session_id: "S1", history_generation: "G1" } as const;
const version = { protocol_version: 2 as const };
const direct = { target_channel_id: "C1" };

function userEvent(eventId: string): TimelineEvent {
  return {
    event_id: eventId,
    session_id: scope.session_id,
    history_generation: scope.history_generation,
    timestamp: 100,
    group_id: "GR1",
    kind: "user",
    message_id: eventId,
    blocks: [{ type: "text", text: eventId }],
    origin: "pwa",
    sender_ref: "sender-1",
    delivery: "normal",
    status: "committed",
  };
}

function assistantEvent(eventId = "A1"): TimelineEvent {
  return {
    event_id: eventId,
    session_id: scope.session_id,
    history_generation: scope.history_generation,
    timestamp: 101,
    group_id: "GR1",
    kind: "assistant",
    blocks: [{ type: "text", text: "done" }],
    status: "complete",
  };
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodeJson(value: unknown): string {
  return encodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function fragmentFrame(
  eventId: string,
  index: number,
  data: string,
  final: boolean,
  overrides: Partial<TimelineEventFragmentFrame> = {},
): TimelineEventFragmentFrame {
  return {
    ...version,
    type: "timeline_event_fragment",
    ...scope,
    event_id: eventId,
    index,
    data_base64: data,
    final,
    ...overrides,
  };
}

function historyChunk(
  requestId: string,
  index: number,
  overrides: Partial<HistoryChunkFrame> = {},
): HistoryChunkFrame {
  const base = {
    ...version,
    type: "session_history_chunk" as const,
    ...direct,
    in_reply_to: requestId,
    ...scope,
    snapshot_head: "HEAD",
    chunk_index: index,
    events: [],
    fragments: [],
  };
  const scopedBase = {
    ...base,
    session_id: overrides.session_id ?? base.session_id,
    history_generation: overrides.history_generation ?? base.history_generation,
    snapshot_head: overrides.snapshot_head ?? base.snapshot_head,
  };
  if (overrides.final_chunk === true && overrides.eos === true) return { ...scopedBase, events: overrides.events ?? [], fragments: overrides.fragments ?? [], final_chunk: true, eos: true };
  if (overrides.final_chunk === true && overrides.eos === false && overrides.next_before) return { ...scopedBase, events: overrides.events ?? [], fragments: overrides.fragments ?? [], final_chunk: true, eos: false, next_before: overrides.next_before };
  return { ...scopedBase, events: overrides.events ?? [], fragments: overrides.fragments ?? [], final_chunk: false };
}

test("assembles out-of-order history chunks in chunk order", () => {
  const assembler = new HistoryWindowAssembler("REQ1");
  const first = historyChunk("REQ1", 0, { events: [userEvent("U1")] });
  const tail = historyChunk("REQ1", 1, { events: [assistantEvent()], final_chunk: true, eos: false, next_before: "NEXT" });

  assert.deepEqual(assembler.accept(tail), { status: "pending" });
  assert.deepEqual(assembler.accept(first), {
    status: "complete",
    events: [userEvent("U1"), assistantEvent()],
    eos: false,
    next_before: "NEXT",
  });
});

test("discards missing, duplicate, and wrong-generation history windows", () => {
  const missing = new HistoryWindowAssembler("REQ1");
  assert.deepEqual(missing.accept(historyChunk("REQ1", 1, { final_chunk: true, eos: true })), { status: "pending" });
  assert.deepEqual(missing.finalize(), { status: "discarded", reason: "history_chunk_gap" });

  const duplicate = new HistoryWindowAssembler("REQ1");
  assert.deepEqual(duplicate.accept(historyChunk("REQ1", 0)), { status: "pending" });
  assert.deepEqual(duplicate.accept(historyChunk("REQ1", 0)), { status: "discarded", reason: "duplicate_chunk" });

  const generation = new HistoryWindowAssembler("REQ1");
  assert.deepEqual(generation.accept(historyChunk("REQ1", 0, { events: [userEvent("G1")] })), { status: "pending" });
  assert.deepEqual(generation.accept(historyChunk("REQ1", 1, {
    final_chunk: true,
    eos: true,
    history_generation: "G2",
  })), { status: "discarded", reason: "history_scope_mismatch" });
});

test("reassembles a realtime fragment event across chunks and rejects invalid JSON", () => {
  const event = assistantEvent();
  const encoded = new TextEncoder().encode(JSON.stringify(event));
  const split = Math.floor(encoded.length / 2);
  const assembler = new TimelineEventFragmentAssembler(scope);

  assert.deepEqual(assembler.accept(fragmentFrame("A1", 0, encodeBytes(encoded.slice(0, split)), false)), { status: "pending" });
  assert.deepEqual(assembler.accept(fragmentFrame("A1", 1, encodeBytes(encoded.slice(split)), true)), { status: "complete", event });

  const invalid = new TimelineEventFragmentAssembler(scope);
  assert.deepEqual(invalid.accept(fragmentFrame("BAD", 0, encodeJson("invalid"), true)), { status: "discarded", reason: "fragment_event_invalid" });
});

test("discards duplicate or missing fragment indexes and scope violations", () => {
  const event = assistantEvent("A2");
  const encoded = encodeJson(event);
  const assembler = new TimelineEventFragmentAssembler(scope);
  assert.deepEqual(assembler.accept(fragmentFrame("A2", 0, encoded.slice(0, 4), false)), { status: "pending" });
  assert.deepEqual(assembler.accept(fragmentFrame("A2", 0, encodeJson("different"), false)), { status: "discarded", reason: "invalid_fragment_sequence" });

  const missing = new TimelineEventFragmentAssembler(scope);
  assert.deepEqual(missing.accept(fragmentFrame("A2", 1, encoded.slice(4), true)), { status: "pending" });
  const wrongScope = new TimelineEventFragmentAssembler(scope);
  assert.deepEqual(wrongScope.accept(fragmentFrame("A2", 0, encoded, true, { history_generation: "G2" })), { status: "discarded", reason: "fragment_scope_mismatch" });
});

test("enforces the 32 MiB decoded window budget", () => {
  const assembler = new HistoryWindowAssembler("REQ1");
  const chunks = Array.from({ length: 73 }, (_, index) => historyChunk("REQ1", index, {
    events: [userEvent(`E${index}`)],
  }));
  for (const chunk of chunks) {
    const event = chunk.events[0] as Extract<TimelineEvent, { kind: "user" }>;
    event.blocks = [{ type: "text", text: "x".repeat(450 * 1024) }];
  }
  chunks[72] = historyChunk("REQ1", 72, {
    events: chunks[72].events,
    final_chunk: true,
    eos: true,
  });
  for (const chunk of chunks.slice(0, -1)) assert.deepEqual(assembler.accept(chunk), { status: "pending" });
  assert.deepEqual(assembler.accept(chunks[72]), { status: "discarded", reason: "window_too_large" });
});
