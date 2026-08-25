import { randomBytes } from "node:crypto";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  encodeServerFrameV2,
  getUtf8ByteLengthV2,
  MAX_FRAGMENT_DECODE_BYTES,
  MAX_HISTORY_CHUNK_BYTES,
  MAX_WINDOW_DECODE_BYTES,
  TimelineEventSchema,
  type ServerFrame,
  type TimelineEvent,
} from "../protocol/v2/index.js";

const MAX_GROUPS_PER_PAGE = 5;
const TIMELINE_MARKER = "remote-pi:timeline-v2";

type BranchEntry = ReturnType<SessionManager["getBranch"]>[number];
type RecoveryFn = (sessionManager: SessionManager) => readonly TimelineEvent[];
type GenerationProvider = (sessionManager: SessionManager) => string;

type HistorySyncRequest = {
  requestId: string;
  targetChannelId: string;
  before: string | null;
  limit?: number;
};

type CursorState = {
  sessionId: string;
  historyGeneration: string;
  snapshotHead: string;
  branchEntryIds: readonly string[];
  position: number;
  used: boolean;
  busy: boolean;
};

type EventRecord = {
  event: TimelineEvent;
  position: number;
  order: number;
  bytes: number;
};

type GroupRecord = {
  groupId: string;
  firstPosition: number;
  records: EventRecord[];
  bytes: number;
};

type HistoryItem =
  | { kind: "event"; event: TimelineEvent }
  | { kind: "fragment"; eventId: string; index: number; dataBase64: string; final: boolean };

type Payload = {
  events: TimelineEvent[];
  fragments: Array<{
    event_id: string;
    index: number;
    data_base64: string;
    final: boolean;
  }>;
};

export type TimelineHistorySync = HistorySyncRequest;
export type TimelineHistoryRecovery = RecoveryFn;
export type TimelineHistoryGenerationProvider = GenerationProvider;

export class TimelineHistoryPager {
  private readonly cursors = new Map<string, CursorState>();
  private initialBusy = false;
  private readonly generationProvider: GenerationProvider;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly recoverFn: RecoveryFn,
    generationProvider?: GenerationProvider,
  ) {
    this.generationProvider = generationProvider ?? ((manager) => manager.getSessionId());
  }

  sync(request: HistorySyncRequest): ServerFrame[] {
    const sessionId = this.sessionManager.getSessionId();
    const historyGeneration = this.generationProvider(this.sessionManager);

    if (request.before === null) {
      if (this.initialBusy) {
        return [this.protocolError(request, "invalid_cursor", "initial cursor is busy")];
      }
      this.initialBusy = true;
      try {
        return this.syncInitial(request, sessionId, historyGeneration);
      } finally {
        this.initialBusy = false;
      }
    }

    const cursor = this.cursors.get(request.before);
    if (!cursor) {
      return [this.reset(request, sessionId, historyGeneration, "invalid_cursor")];
    }
    if (cursor.busy) {
      return [this.protocolError(request, "invalid_cursor", "cursor is busy")];
    }
    if (cursor.used) {
      return [this.reset(request, sessionId, historyGeneration, "invalid_cursor")];
    }

    cursor.busy = true;
    cursor.used = true;
    try {
      if (cursor.sessionId !== sessionId) {
        return [this.reset(request, sessionId, historyGeneration, "session_replaced")];
      }
      if (cursor.historyGeneration !== historyGeneration) {
        return [this.reset(request, sessionId, historyGeneration, "generation_changed")];
      }
      const branchReason = this.snapshotInvalidReason(cursor);
      if (branchReason) {
        return [this.reset(request, sessionId, historyGeneration, branchReason)];
      }
      return this.page(request, cursor);
    } finally {
      cursor.busy = false;
    }
  }

  private syncInitial(request: HistorySyncRequest, sessionId: string, historyGeneration: string): ServerFrame[] {
    const branch = this.sessionManager.getBranch();
    const snapshotHead = this.sessionManager.getLeafId() ?? sessionId;
    if (branch.length > 0 && branch.at(-1)?.id !== snapshotHead) {
      return [this.protocolError(request, "reset_required", "session has no current snapshot head")];
    }

    const cursor: CursorState = {
      sessionId,
      historyGeneration,
      snapshotHead,
      branchEntryIds: branch.map((entry) => entry.id),
      position: branch.length,
      used: true,
      busy: true,
    };
    try {
      return this.page(request, cursor);
    } finally {
      cursor.busy = false;
    }
  }

  private page(request: HistorySyncRequest, cursor: CursorState): ServerFrame[] {
    const reason = this.snapshotInvalidReason(cursor);
    if (reason) {
      return [this.reset(request, cursor.sessionId, cursor.historyGeneration, reason)];
    }

    let records: EventRecord[];
    try {
      records = this.recoverRecords(cursor);
    } catch (error) {
      if (error instanceof HistoryTooLargeError) {
        return [this.protocolError(request, "too_large", error.message)];
      }
      return [this.protocolError(request, "internal_error", "history recovery failed")];
    }

    const afterRecoveryReason = this.snapshotInvalidReason(cursor);
    if (afterRecoveryReason) {
      return [this.reset(request, cursor.sessionId, cursor.historyGeneration, afterRecoveryReason)];
    }

    const window = this.selectWindow(records, cursor.position, request.limit);
    if (window.kind === "error") {
      return [this.protocolError(request, "too_large", window.message)];
    }

    const hasOlder = records.some((record) => record.position < window.nextPosition);
    const nextCursor = hasOlder
      ? this.issueCursor({
          sessionId: cursor.sessionId,
          historyGeneration: cursor.historyGeneration,
          snapshotHead: cursor.snapshotHead,
          branchEntryIds: cursor.branchEntryIds,
          position: window.nextPosition,
          used: false,
          busy: false,
        })
      : undefined;

    try {
      const frames = this.fragmentWindow(request, cursor, window.records, nextCursor);
      if (nextCursor) this.cursors.set(nextCursor, this.cursors.get(nextCursor)!);
      return frames;
    } catch (error) {
      if (nextCursor) this.cursors.delete(nextCursor);
      const message = error instanceof Error ? error.message : "history chunk construction failed";
      return [this.protocolError(request, "too_large", message)];
    }
  }

  private snapshotInvalidReason(cursor: CursorState): "session_replaced" | "generation_changed" | "branch_changed" | null {
    if (this.sessionManager.getSessionId() !== cursor.sessionId) return "session_replaced";
    if (this.generationProvider(this.sessionManager) !== cursor.historyGeneration) return "generation_changed";

    const currentBranch = this.sessionManager.getBranch();
    const snapshotIndex = currentBranch.findIndex((entry) => entry.id === cursor.snapshotHead);
    if (snapshotIndex < 0 && !(cursor.branchEntryIds.length === 0 && cursor.snapshotHead === cursor.sessionId && currentBranch.length === 0)) return "branch_changed";
    const currentPrefix = currentBranch.slice(0, cursor.branchEntryIds.length).map((entry) => entry.id);
    if (!sameIds(currentPrefix, cursor.branchEntryIds)) return "branch_changed";

    const frozenBranch = this.sessionManager.getBranch(cursor.snapshotHead).map((entry) => entry.id);
    if (!sameIds(frozenBranch, cursor.branchEntryIds)) return "branch_changed";
    return null;
  }

  private recoverRecords(cursor: CursorState): EventRecord[] {
    if (cursor.branchEntryIds.length === 0 && cursor.snapshotHead === cursor.sessionId) return [];
    const branch = this.sessionManager.getBranch(cursor.snapshotHead);
    const positions = new Map<string, number>();
    for (const [position, entry] of branch.entries()) {
      positions.set(entry.id, position);
      if (entry.type === "message") positions.set(`legacy:${entry.id}`, position);
      if (entry.type === "custom" && entry.customType === TIMELINE_MARKER) {
        const eventId = markerEventId(entry);
        if (eventId) positions.set(eventId, position);
      }
    }

    const records: EventRecord[] = [];
    const recovered = this.recoverFn(this.sessionManager);
    for (const [order, rawEvent] of recovered.entries()) {
      const parsed = TimelineEventSchema.safeParse(rawEvent);
      if (!parsed.success) throw new Error("recovery returned an invalid timeline event");
      const event = parsed.data;
      const position = positions.get(event.event_id);
      if (position === undefined || position >= cursor.position) continue;
      records.push({ event, position, order, bytes: getUtf8ByteLengthV2(event) });
    }
    return records.sort((left, right) => left.position - right.position || left.order - right.order);
  }

  private selectWindow(records: EventRecord[], position: number, limit = MAX_GROUPS_PER_PAGE):
    | { kind: "ok"; records: EventRecord[]; nextPosition: number }
    | { kind: "error"; message: string } {
    const groupLimit = normalizeLimit(limit);
    const groups = new Map<string, GroupRecord>();
    const systems: EventRecord[] = [];

    for (const record of records) {
      if (isSystemEvent(record.event)) {
        systems.push(record);
        continue;
      }
      const groupId = record.event.group_id;
      const existing = groups.get(groupId);
      if (existing) {
        existing.records.push(record);
        existing.bytes += record.bytes;
      } else {
        groups.set(groupId, {
          groupId,
          firstPosition: record.position,
          records: [record],
          bytes: record.bytes,
        });
      }
    }

    const orderedGroups = [...groups.values()]
      .filter((group) => group.firstPosition < position)
      .sort((left, right) => left.firstPosition - right.firstPosition);
    let selected = orderedGroups.slice(-groupLimit);

    if (selected.length > 0) {
      while (selected.length > 0) {
        const firstPosition = selected[0]!.firstPosition;
        const selectedSystems = systems.filter((record) => record.position >= firstPosition && record.position < position);
        const selectedRecords = [...selected.flatMap((group) => group.records), ...selectedSystems]
          .sort((left, right) => left.position - right.position || left.order - right.order);
        const bytes = selectedRecords.reduce((total, record) => total + record.bytes, 0);
        if (bytes <= MAX_WINDOW_DECODE_BYTES) {
          return { kind: "ok", records: selectedRecords, nextPosition: firstPosition };
        }
        if (selected.length === 1) {
          return { kind: "error", message: `group ${selected[0]!.groupId} exceeds ${MAX_WINDOW_DECODE_BYTES} bytes` };
        }
        selected = selected.slice(1);
      }
    }

    const selectedSystems = systems.filter((record) => record.position < position);
    if (selectedSystems.length === 0) {
      return { kind: "ok", records: [], nextPosition: 0 };
    }
    const systemBytes = selectedSystems.reduce((total, record) => total + record.bytes, 0);
    if (systemBytes > MAX_WINDOW_DECODE_BYTES) {
      return { kind: "error", message: `system history exceeds ${MAX_WINDOW_DECODE_BYTES} bytes` };
    }
    const nextPosition = Math.min(...selectedSystems.map((record) => record.position));
    return {
      kind: "ok",
      records: [...selectedSystems].sort((left, right) => left.position - right.position || left.order - right.order),
      nextPosition,
    };
  }

  private fragmentWindow(
    request: HistorySyncRequest,
    cursor: CursorState,
    records: EventRecord[],
    nextBefore: string | undefined,
  ): ServerFrame[] {
    const tailOverhead = this.finalFrameBytes(request, cursor, { events: [], fragments: [] }, nextBefore)
      - this.nonFinalFrameBytes(request, cursor, { events: [], fragments: [] });
    const contentLimit = MAX_HISTORY_CHUNK_BYTES - tailOverhead;
    const items: HistoryItem[] = [];

    for (const record of records) {
      const fullFrame = this.makeChunk(request, cursor, { events: [record.event], fragments: [] }, true, nextBefore);
      if (getUtf8ByteLengthV2(fullFrame) <= MAX_HISTORY_CHUNK_BYTES) {
        items.push({ kind: "event", event: record.event });
        continue;
      }
      const encoded = new TextEncoder().encode(JSON.stringify(record.event));
      let index = 0;
      for (let offset = 0; offset < encoded.byteLength; offset += MAX_FRAGMENT_DECODE_BYTES) {
        const slice = encoded.slice(offset, offset + MAX_FRAGMENT_DECODE_BYTES);
        items.push({
          kind: "fragment",
          eventId: record.event.event_id,
          index,
          dataBase64: Buffer.from(slice).toString("base64"),
          final: offset + slice.byteLength >= encoded.byteLength,
        });
        index += 1;
      }
    }

    const payloads: Payload[] = [];
    let current: Payload = { events: [], fragments: [] };
    for (const item of items) {
      const repeatedFragment = item.kind === "fragment" && current.fragments.some(
        (fragment) => fragment.event_id === item.eventId,
      );
      const candidate = appendItem(current, item);
      if (!repeatedFragment && this.nonFinalFrameBytes(request, cursor, candidate) + tailOverhead <= contentLimit + tailOverhead) {
        current = candidate;
        continue;
      }
      if (current.events.length === 0 && current.fragments.length === 0) {
        throw new HistoryTooLargeError("history item cannot fit in a 512 KiB chunk");
      }
      payloads.push(current);
      current = appendItem({ events: [], fragments: [] }, item);
    }
    if (current.events.length > 0 || current.fragments.length > 0 || payloads.length === 0) payloads.push(current);

    return payloads.map((payload, chunkIndex) => {
      const final = chunkIndex === payloads.length - 1;
      const frame = this.makeChunk(request, cursor, payload, final, nextBefore, chunkIndex);
      if (getUtf8ByteLengthV2(frame) > MAX_HISTORY_CHUNK_BYTES) {
        throw new HistoryTooLargeError("history chunk exceeds 512 KiB");
      }
      encodeServerFrameV2(frame);
      return frame;
    });
  }

  private makeChunk(
    request: HistorySyncRequest,
    cursor: CursorState,
    payload: Payload,
    final: boolean,
    nextBefore: string | undefined,
    chunkIndex = 0,
  ): ServerFrame {
    const tail = final
      ? nextBefore
        ? { final_chunk: true as const, eos: false as const, next_before: nextBefore }
        : { final_chunk: true as const, eos: true as const }
      : { final_chunk: false as const };
    return {
      protocol_version: 2,
      type: "session_history_chunk",
      target_channel_id: request.targetChannelId,
      in_reply_to: request.requestId,
      session_id: cursor.sessionId,
      history_generation: cursor.historyGeneration,
      snapshot_head: cursor.snapshotHead,
      chunk_index: chunkIndex,
      events: payload.events,
      fragments: payload.fragments,
      ...tail,
    } as ServerFrame;
  }

  private nonFinalFrameBytes(request: HistorySyncRequest, cursor: CursorState, payload: Payload): number {
    return getUtf8ByteLengthV2(this.makeChunk(request, cursor, payload, false, undefined));
  }

  private finalFrameBytes(request: HistorySyncRequest, cursor: CursorState, payload: Payload, nextBefore: string | undefined): number {
    return getUtf8ByteLengthV2(this.makeChunk(request, cursor, payload, true, nextBefore));
  }

  private issueCursor(state: CursorState): string {
    const token = randomBytes(32).toString("base64url");
    this.cursors.set(token, state);
    return token;
  }

  private protocolError(
    request: HistorySyncRequest,
    code: "invalid_cursor" | "reset_required" | "too_large" | "internal_error",
    message: string,
  ): ServerFrame {
    return {
      protocol_version: 2,
      type: "protocol_error",
      target_channel_id: request.targetChannelId,
      in_reply_to: request.requestId,
      code,
      message,
    };
  }

  private reset(
    request: HistorySyncRequest,
    sessionId: string,
    historyGeneration: string,
    reason: "generation_changed" | "branch_changed" | "session_replaced" | "conflict" | "invalid_cursor",
  ): ServerFrame {
    return {
      protocol_version: 2,
      type: "reset",
      target_channel_id: request.targetChannelId,
      session_id: sessionId,
      history_generation: historyGeneration,
      reason,
    };
  }
}

class HistoryTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryTooLargeError";
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return MAX_GROUPS_PER_PAGE;
  return Math.min(MAX_GROUPS_PER_PAGE, Math.max(1, Math.floor(limit)));
}

function markerEventId(entry: BranchEntry): string | undefined {
  if (entry.type !== "custom" || entry.customType !== TIMELINE_MARKER || !entry.data) return undefined;
  if (typeof entry.data !== "object" || Array.isArray(entry.data)) return undefined;
  const eventId = (entry.data as { event_id?: unknown }).event_id;
  return typeof eventId === "string" ? eventId : undefined;
}

function isSystemEvent(event: TimelineEvent): event is Extract<TimelineEvent, { kind: "compaction" | "branch_summary" | "custom" }> {
  return event.kind === "compaction" || event.kind === "branch_summary" || event.kind === "custom";
}

function appendItem(payload: Payload, item: HistoryItem): Payload {
  if (item.kind === "event") {
    return { events: [...payload.events, item.event], fragments: [...payload.fragments] };
  }
  return {
    events: [...payload.events],
    fragments: [
      ...payload.fragments,
      {
        event_id: item.eventId,
        index: item.index,
        data_base64: item.dataBase64,
        final: item.final,
      },
    ],
  };
}