import {
  decodeBase64,
  decodeUtf8,
} from "../remote-pi/encoding";
import {
  getUtf8ByteLengthV2,
  parseTimelineEventV2,
  validateFragmentSizeV2,
  validateHistoryChunkSizeV2,
  validateWindowSizeV2,
} from "../remote-pi/protocol-v2/codec";
import {
  sessionHistoryChunkFrameSchema,
  timelineEventFragmentFrameSchema,
} from "../remote-pi/protocol-v2/frames";
import {
  MAX_ARRAY_ITEMS,
  MAX_WINDOW_BYTES,
} from "../remote-pi/protocol-v2/schema";
import type { ServerFrame } from "../remote-pi/protocol-v2/frames";
import type { TimelineEvent, TimelineEventFragment } from "../remote-pi/protocol-v2/schema";

export type TimelineTransferScope = Pick<TimelineEvent, "session_id" | "history_generation">;
export type HistoryChunkFrame = Extract<ServerFrame, { type: "session_history_chunk" }>;
export type TimelineEventFragmentFrame = Extract<ServerFrame, { type: "timeline_event_fragment" }>;
export type HistoryFragment = HistoryChunkFrame["fragments"][number];

export type TransferResult =
  | { status: "pending" }
  | { status: "complete"; event: TimelineEvent }
  | { status: "discarded"; reason: string }
  | { status: "ignored"; reason: string };

export type HistoryWindowResult =
  | { status: "pending" }
  | { status: "complete"; events: TimelineEvent[]; eos: boolean; next_before?: string }
  | { status: "discarded"; reason: string }
  | { status: "ignored"; reason: string };

type FragmentInput = TimelineEventFragment | HistoryFragment;
type FragmentEntry = { bytes: Uint8Array; final: boolean };

type FragmentState = {
  entries: Map<number, FragmentEntry>;
  finalIndex?: number;
  decodedBytes: number;
};

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function discardFragmentState(states: Map<string, FragmentState>, eventId: string): TransferResult {
  states.delete(eventId);
  return { status: "discarded", reason: "invalid_fragment_sequence" };
}

function decodeFragment(fragment: FragmentInput): Uint8Array {
  validateFragmentSizeV2(fragment);
  return decodeBase64(fragment.data_base64, "standard");
}

function addFragment(
  states: Map<string, FragmentState>,
  fragment: FragmentInput,
): { state: FragmentState; result?: TransferResult } {
  const bytes = decodeFragment(fragment);
  let state = states.get(fragment.event_id);
  if (!state) {
    state = { entries: new Map(), decodedBytes: 0 };
    states.set(fragment.event_id, state);
  }

  const previous = state.entries.get(fragment.index);
  if (previous) {
    if (previous.final !== fragment.final || !bytesEqual(previous.bytes, bytes)) {
      return { state, result: discardFragmentState(states, fragment.event_id) };
    }
    return { state, result: { status: "pending" } };
  }

  if (state.entries.size >= MAX_ARRAY_ITEMS) {
    return { state, result: discardFragmentState(states, fragment.event_id) };
  }
  if (state.finalIndex !== undefined) {
    if (fragment.index > state.finalIndex || fragment.final) {
      return { state, result: discardFragmentState(states, fragment.event_id) };
    }
  }
  if (fragment.final) {
    if (state.finalIndex !== undefined || [...state.entries.keys()].some((index) => index > fragment.index)) {
      return { state, result: discardFragmentState(states, fragment.event_id) };
    }
    state.finalIndex = fragment.index;
  }

  state.entries.set(fragment.index, { bytes, final: fragment.final });
  state.decodedBytes += bytes.byteLength;
  if (state.decodedBytes > MAX_WINDOW_BYTES) {
    return { state, result: discardFragmentState(states, fragment.event_id) };
  }
  return { state };
}

function finishFragment(
  states: Map<string, FragmentState>,
  eventId: string,
  scope: TimelineTransferScope,
): TransferResult {
  const state = states.get(eventId);
  if (!state || state.finalIndex === undefined) return { status: "pending" };
  if (state.finalIndex + 1 !== state.entries.size) return { status: "pending" };

  const encoded = new Uint8Array(state.decodedBytes);
  let offset = 0;
  for (let index = 0; index <= state.finalIndex; index += 1) {
    const entry = state.entries.get(index);
    if (!entry) return { status: "pending" };
    encoded.set(entry.bytes, offset);
    offset += entry.bytes.byteLength;
  }

  try {
    const event = parseTimelineEventV2(decodeUtf8(encoded));
    if (event.event_id !== eventId || event.session_id !== scope.session_id || event.history_generation !== scope.history_generation) {
      states.delete(eventId);
      return { status: "discarded", reason: "fragment_event_scope_mismatch" };
    }
    states.delete(eventId);
    return { status: "complete", event };
  } catch {
    states.delete(eventId);
    return { status: "discarded", reason: "fragment_event_invalid" };
  }
}

/** Assembles one owner-broadcast event stream for one session/generation scope. */
export class TimelineEventFragmentAssembler {
  private readonly states = new Map<string, FragmentState>();
  private activeBytes = 0;

  constructor(private readonly scope: TimelineTransferScope) {}

  accept(frame: TimelineEventFragmentFrame): TransferResult {
    if (frame.session_id !== this.scope.session_id || frame.history_generation !== this.scope.history_generation) {
      this.reset();
      return { status: "discarded", reason: "fragment_scope_mismatch" };
    }
    try {
      const parsed = timelineEventFragmentFrameSchema.safeParse(frame);
      if (!parsed.success) {
        const bytes = this.states.get(frame.event_id)?.decodedBytes ?? 0;
        this.states.delete(frame.event_id);
        this.activeBytes -= bytes;
        return { status: "discarded", reason: "invalid_fragment" };
      }
      const previousBytes = this.states.get(frame.event_id)?.decodedBytes ?? 0;
      const added = addFragment(this.states, parsed.data);
      const nextBytes = this.states.get(frame.event_id)?.decodedBytes ?? 0;
      this.activeBytes += nextBytes - previousBytes;
      if (this.states.size > MAX_ARRAY_ITEMS || this.activeBytes > MAX_WINDOW_BYTES) {
        this.reset();
        return { status: "discarded", reason: "fragment_window_too_large" };
      }
      if (added.result?.status === "discarded") {
        this.activeBytes -= nextBytes;
        return added.result;
      }
      const result = finishFragment(this.states, frame.event_id, this.scope);
      if (result.status === "complete" || result.status === "discarded") this.activeBytes -= nextBytes;
      return result;
    } catch {
      const bytes = this.states.get(frame.event_id)?.decodedBytes ?? 0;
      this.states.delete(frame.event_id);
      this.activeBytes -= bytes;
      return { status: "discarded", reason: "invalid_fragment" };
    }
  }

  reset(): void {
    this.states.clear();
    this.activeBytes = 0;
  }
}

type StoredChunk = { frame: HistoryChunkFrame };

type HistoryScope = TimelineTransferScope & { snapshot_head: string };

function isContiguous(chunks: Map<number, StoredChunk>, finalIndex: number): boolean {
  if (finalIndex + 1 !== chunks.size) return false;
  for (let index = 0; index <= finalIndex; index += 1) {
    if (!chunks.has(index)) return false;
  }
  return true;
}

/** Assembles a single session_history_chunk response, bound to its request id. */
export class HistoryWindowAssembler {
  private readonly chunks = new Map<number, StoredChunk>();
  private readonly fragmentStates = new Map<string, FragmentState>();
  private readonly completeEvents = new Map<string, TimelineEvent>();
  private readonly formalEventIds = new Set<string>();
  private scope?: HistoryScope;
  private totalDecodedBytes = 0;
  private finalTail?: { index: number; eos: boolean; next_before?: string };
  private state: "open" | "complete" | "discarded" = "open";

  constructor(private readonly inReplyTo: string, private readonly expectedScope?: TimelineTransferScope) {}

  accept(chunk: HistoryChunkFrame): HistoryWindowResult {
    if (this.state !== "open") return { status: "ignored", reason: `window_${this.state}` };
    if (chunk.in_reply_to !== this.inReplyTo) return { status: "ignored", reason: "request_mismatch" };

    try {
      const parsed = sessionHistoryChunkFrameSchema.safeParse(chunk);
      if (!parsed.success) return this.discard("invalid_history_chunk");
      validateHistoryChunkSizeV2(parsed.data);
      const frame = parsed.data;
      if (this.expectedScope && (frame.session_id !== this.expectedScope.session_id || frame.history_generation !== this.expectedScope.history_generation)) return this.discard("history_scope_mismatch");

      if (!this.scope) {
        this.scope = {
          session_id: frame.session_id,
          history_generation: frame.history_generation,
          snapshot_head: frame.snapshot_head,
        };
      } else if (
        frame.session_id !== this.scope.session_id
        || frame.history_generation !== this.scope.history_generation
        || (this.scope.snapshot_head !== "" && frame.snapshot_head !== this.scope.snapshot_head)
      ) {
        return this.discard("history_scope_mismatch");
      }

      if (this.chunks.has(frame.chunk_index)) return this.discard("duplicate_chunk");
      if (this.finalTail && (frame.chunk_index > this.finalTail.index || frame.final_chunk)) {
        return this.discard("invalid_final_tail");
      }
      if (frame.final_chunk) {
        if (this.finalTail || [...this.chunks.keys()].some((index) => index > frame.chunk_index)) {
          return this.discard("invalid_final_tail");
        }
        this.finalTail = frame.eos
          ? { index: frame.chunk_index, eos: true }
          : { index: frame.chunk_index, eos: false, next_before: frame.next_before };
      }

      this.chunks.set(frame.chunk_index, { frame });
      const chunkBytes = frame.events.reduce((total, event) => total + getUtf8ByteLengthV2(event), 0);
      const fragmentBytes = frame.fragments.reduce((total, fragment) => total + decodeFragment(fragment).byteLength, 0);
      this.totalDecodedBytes += chunkBytes + fragmentBytes;
      if (this.totalDecodedBytes > MAX_WINDOW_BYTES) return this.discard("window_too_large");

      for (const eventValue of frame.events) {
        const event = parseTimelineEventV2(eventValue);
        if (
          event.session_id !== this.scope.session_id
          || event.history_generation !== this.scope.history_generation
          || this.formalEventIds.has(event.event_id)
          || this.completeEvents.has(event.event_id)
          || this.fragmentStates.has(event.event_id)
        ) return this.discard("duplicate_or_conflicting_event");
        this.formalEventIds.add(event.event_id);
        this.completeEvents.set(event.event_id, event);
      }

      for (const fragment of frame.fragments) {
        if (this.formalEventIds.has(fragment.event_id) || this.completeEvents.has(fragment.event_id)) {
          return this.discard("duplicate_or_conflicting_event");
        }
        const added = addFragment(this.fragmentStates, fragment);
        if (added.result?.status === "discarded") return this.discard(added.result.reason);
        const result = finishFragment(this.fragmentStates, fragment.event_id, this.scope);
        if (result.status === "discarded") return this.discard(result.reason);
        if (result.status === "complete") {
          if (this.completeEvents.has(result.event.event_id)) return this.discard("duplicate_or_conflicting_event");
          this.completeEvents.set(result.event.event_id, result.event);
        }
      }

      if (!this.finalTail || !isContiguous(this.chunks, this.finalTail.index) || this.fragmentStates.size > 0) return { status: "pending" };
      return this.completeWindow();
    } catch {
      return this.discard("invalid_history_window");
    }
  }

  finalize(): HistoryWindowResult {
    if (this.state !== "open") return { status: "ignored", reason: `window_${this.state}` };
    if (!this.finalTail || !isContiguous(this.chunks, this.finalTail.index)) return this.discard("history_chunk_gap");
    if (this.fragmentStates.size > 0) return this.discard("incomplete_fragment");
    return this.completeWindow();
  }

  reset(): void {
    this.chunks.clear();
    this.fragmentStates.clear();
    this.completeEvents.clear();
    this.formalEventIds.clear();
    this.scope = undefined;
    this.totalDecodedBytes = 0;
    this.finalTail = undefined;
    this.state = "open";
  }

  private completeWindow(): HistoryWindowResult {
    const events = [...this.chunks.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap(([, stored]) => stored.frame.events.map((event) => this.completeEvents.get(event.event_id)!));
    const formalIds = new Set(events.map((event) => event.event_id));
    for (const event of this.completeEvents.values()) {
      if (!formalIds.has(event.event_id)) events.push(event);
    }
    validateWindowSizeV2([...this.completeEvents.values()]);
    this.state = "complete";
    return { status: "complete", events, eos: this.finalTail!.eos, ...(this.finalTail!.next_before ? { next_before: this.finalTail!.next_before } : {}) };
  }

  private discard(reason: string): HistoryWindowResult {
    this.chunks.clear();
    this.fragmentStates.clear();
    this.completeEvents.clear();
    this.formalEventIds.clear();
    this.scope = undefined;
    this.totalDecodedBytes = 0;
    this.finalTail = undefined;
    this.state = "discarded";
    return { status: "discarded", reason };
  }
}
