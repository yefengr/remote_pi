import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { MessageUpdateEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  MarkerSchemaV2,
  TimelineEventSchema,
  type JsonValue,
  type MarkerV2,
  type TimelineEvent,
  type TimelinePartial,
} from "../protocol/v2/index.js";

export const TIMELINE_MARKER = "remote-pi:timeline-v2" as const;
const MAX_PARTIAL_DELTA_CHARS = 64 * 1024;

type MessageRole = "user" | "assistant" | "toolResult";

type MessageRecord = {
  role: MessageRole;
  content?: unknown;
  timestamp?: number;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  args?: unknown;
  api?: string;
  provider?: string;
  model?: string;
};

export type Correlation = {
  clientRequestId?: string;
  channelId?: string;
  requestId?: string;
  origin: "pwa" | "extension" | "unknown";
  delivery: "normal" | "queued" | "unknown";
  senderRef?: string;
};

type PendingMessage = {
  message: object;
  role: MessageRole;
  marker: MarkerV2;
  correlation: Correlation;
  identity: string | null;
};

type SessionEntry = ReturnType<SessionManager["getBranch"]>[number];
type MessageEntry = Extract<SessionEntry, { type: "message" }>;

export type TimelineStarted = {
  eventId: string;
  groupId: string;
  role: MessageRole;
  correlation: Correlation;
  blocks: JsonValue[];
};

export type TimelineRuntimeOptions = {
  getHistoryGeneration?: () => string;
  onStarted?: (started: TimelineStarted) => void;
  onPublished?: (event: TimelineEvent, correlation: Correlation) => void;
  onPartial?: (partial: TimelinePartial, correlation: Correlation) => void;
};

export class TimelineRuntime {
  private readonly correlations = new AsyncLocalStorage<Correlation>();
  private readonly messageCorrelations = new WeakMap<object, Correlation>();
  private readonly pending = new WeakMap<object, PendingMessage>();
  private readonly pendingByRole: Record<MessageRole, PendingMessage[]> = {
    user: [],
    assistant: [],
    toolResult: [],
  };
  private readonly published: TimelineEvent[] = [];
  private sessionManager: SessionManager | null = null;
  private epoch = 0;
  private activeGroupId: string | null = null;
  private active = false;
  private readonly getHistoryGenerationValue?: () => string;
  private readonly onStarted?: (started: TimelineStarted) => void;
  private readonly onPublished?: (event: TimelineEvent, correlation: Correlation) => void;
  private readonly onPartial?: (partial: TimelinePartial, correlation: Correlation) => void;

  constructor(options: TimelineRuntimeOptions = {}) {
    this.getHistoryGenerationValue = options.getHistoryGeneration;
    this.onStarted = options.onStarted;
    this.onPublished = options.onPublished;
    this.onPartial = options.onPartial;
  }

  attach(sessionManager: SessionManager): void {
    if (this.sessionManager === sessionManager) return;
    this.sessionManager = sessionManager;
    this.resetState();
  }

  resetSession(sessionManager: SessionManager): void {
    this.sessionManager = sessionManager;
    this.resetState();
  }

  private resetState(): void {
    this.epoch = 0;
    this.activeGroupId = null;
    this.active = false;
    this.published.length = 0;
    this.pendingByRole.user = [];
    this.pendingByRole.assistant = [];
    this.pendingByRole.toolResult = [];
  }

  get sessionId(): string | null {
    return this.sessionManager?.getSessionId() ?? null;
  }

  get historyGeneration(): string | null {
    if (!this.sessionManager) return null;
    return this.getHistoryGenerationValue?.() ?? this.sessionManager.getSessionId();
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  get currentGroupId(): string | null {
    return this.activeGroupId;
  }

  getPublishedEvents(): readonly TimelineEvent[] {
    return [...this.published];
  }

  getCorrelation(message: object): Correlation | undefined {
    return this.messageCorrelations.get(message);
  }

  publishSessionEntry(entry: SessionEntry, sessionManager: SessionManager): TimelineEvent | null {
    this.attach(sessionManager);
    const event = this.toSystemEvent(entry, sessionManager);
    if (!event) return null;
    this.publish(event, { origin: "unknown", delivery: "unknown" });
    return event;
  }

  runWithCorrelation<T>(correlation: Correlation, callback: () => T): T {
    return this.correlations.run(correlation, callback);
  }

  currentCorrelation(): Correlation | undefined {
    return this.correlations.getStore();
  }

  onAgentStart(): void {
    this.epoch += 1;
    this.active = true;
    this.activeGroupId = null;
  }

  onAgentEnd(): void {
    this.active = false;
    this.activeGroupId = null;
    this.pendingByRole.user = [];
    this.pendingByRole.assistant = [];
    this.pendingByRole.toolResult = [];
  }

  onMessageStart(message: unknown, sessionManager: SessionManager): TimelineStarted | null {
    this.attach(sessionManager);
    const record = this.asMessageRecord(message);
    if (!record) return null;
    if (!this.active) {
      this.onAgentStart();
    }
    const correlation = this.correlationFor(message);
    const groupId = this.activeGroupId ?? randomUUID();
    this.activeGroupId = groupId;
    const eventId = randomUUID();
    const marker = this.buildMarker(record.role, eventId, groupId, correlation);
    sessionManager.appendCustomEntry(TIMELINE_MARKER, marker);
    const objectMessage = message as object;
    this.messageCorrelations.set(objectMessage, correlation);
    const pending = { message: objectMessage, role: record.role, marker, correlation, identity: this.messageIdentity(record) };
    this.pending.set(objectMessage, pending);
    this.pendingByRole[record.role].push(pending);
    const started: TimelineStarted = {
      eventId,
      groupId,
      role: record.role,
      correlation: { ...correlation },
      blocks: record.role === "user" ? this.userBlocks(record.content) : [],
    };
    this.onStarted?.(started);
    return started;
  }

  onMessageUpdate(event: MessageUpdateEvent, sessionManager: SessionManager): void {
    if (this.sessionManager !== sessionManager || this.messageRole(event.message) !== "assistant") return;
    const pending = this.findPending(event.message, "assistant");
    if (!pending) return;
    const update = event.assistantMessageEvent;
    if (update.type === "text_start") {
      this.publishPartial(pending, "assistant", update.contentIndex, "running");
    } else if (update.type === "thinking_start") {
      this.publishPartial(pending, "thinking", update.contentIndex, "running");
    } else if (update.type === "text_delta" && update.delta) {
      this.publishPartial(pending, "assistant", update.contentIndex, "delta", update.delta);
    } else if (update.type === "thinking_delta" && update.delta) {
      this.publishPartial(pending, "thinking", update.contentIndex, "delta", update.delta);
    }
  }

  onMessageEnd(message: unknown, sessionManager: SessionManager): void {
    this.attach(sessionManager);
    if (typeof message !== "object" || message === null) return;
    const objectMessage = message as object;
    const role = this.messageRole(message);
    const pending = role ? this.findPending(message, role) : undefined;
    if (!pending) return;
    this.pending.delete(pending.message);
    this.pending.delete(objectMessage);
    this.pendingByRole[pending.role] = this.pendingByRole[pending.role].filter((candidate) => candidate !== pending);
    setImmediate(() => {
      const branch = sessionManager.getBranch();
      const markerIndex = branch.findIndex((entry) => entry.id === pending.marker.event_id || (
        entry.type === "custom" && entry.customType === TIMELINE_MARKER && entry.data &&
        typeof entry.data === "object" && (entry.data as { event_id?: unknown }).event_id === pending.marker.event_id
      ));
      if (markerIndex < 0) return;
      const target = this.scanTargetAfterMarker(branch, markerIndex, pending.role);
      if (!target) return;
      const event = this.toTimelineEvent(target, pending.marker, pending.correlation, sessionManager);
      if (!event) return;
      this.publish(event, pending.correlation);
    });
  }

  recover(sessionManager: SessionManager): TimelineEvent[] {
    this.attach(sessionManager);
    const branch = sessionManager.getBranch();
    const matched = new Set<string>();
    const recovered: TimelineEvent[] = [];
    for (let index = 0; index < branch.length; index += 1) {
      const entry = branch[index]!;
      if (entry.type === "custom" && entry.customType === TIMELINE_MARKER) {
        const marker = this.parseMarker(entry.data);
        if (!marker) continue;
        const target = this.scanTargetAfterMarker(branch, index, this.roleForMarker(marker));
        if (!target || target.type !== "message") continue;
        matched.add(target.id);
        const event = this.toTimelineEvent(target, marker, this.correlationFromMarker(marker), sessionManager);
        if (event) recovered.push(event);
      }
    }
    const legacyGroup = `legacy:${sessionManager.getSessionId()}`;
    for (const entry of branch) {
      if (entry.type !== "message" || matched.has(entry.id)) continue;
      const role = this.messageRole(entry.message);
      if (!role) continue;
      const marker: MarkerV2 = role === "user"
        ? { version: 2, event_id: `legacy:${entry.id}`, group_id: legacyGroup, kind: "user", origin: "unknown", delivery: "unknown" }
        : { version: 2, event_id: `legacy:${entry.id}`, group_id: legacyGroup, kind: role === "assistant" ? "assistant" : "tool" };
      const event = this.toTimelineEvent(entry, marker, this.correlationFromMarker(marker), sessionManager);
      if (event) recovered.push(event);
    }
    for (const entry of branch) {
      const event = this.toSystemEvent(entry, sessionManager);
      if (event) recovered.push(event);
    }
    return recovered;
  }

  private findPending(message: unknown, role: MessageRole): PendingMessage | undefined {
    if (typeof message !== "object" || message === null) return undefined;
    const direct = this.pending.get(message);
    if (direct?.role === role && this.pendingByRole[role].includes(direct)) return direct;
    const record = this.asMessageRecord(message);
    const identity = record ? this.messageIdentity(record) : null;
    if (!identity) return undefined;
    return this.pendingByRole[role].find((candidate) => candidate.identity === identity);
  }

  private messageIdentity(message: MessageRecord): string | null {
    if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) return null;
    return [message.role, message.timestamp, message.api ?? "", message.provider ?? "", message.model ?? ""].join(":");
  }

  private publish(event: TimelineEvent, correlation: Correlation): void {
    if (this.published.some((existing) => existing.event_id === event.event_id)) return;
    this.published.push(event);
    this.onPublished?.(event, { ...correlation });
  }

  private publishPartial(
    pending: PendingMessage,
    kind: "assistant" | "thinking",
    contentIndex: number,
    status: "running" | "delta",
    delta?: string,
  ): void {
    const sessionId = this.sessionId;
    const historyGeneration = this.historyGeneration;
    const groupId = pending.marker.group_id;
    if (!sessionId || !historyGeneration || !groupId) return;
    const publish = (chunk?: string): void => {
      const partial: TimelinePartial = {
        protocol_version: 2,
        type: "timeline_partial",
        session_id: sessionId,
        history_generation: historyGeneration,
        group_id: groupId,
        partial_id: `${pending.marker.event_id}:${kind}:${contentIndex}`,
        kind,
        status,
        ...(chunk === undefined ? {} : { delta: chunk }),
      };
      this.onPartial?.(partial, { ...pending.correlation });
    };
    if (delta === undefined) {
      publish();
      return;
    }
    for (const chunk of this.partialDeltaChunks(delta)) publish(chunk);
  }

  private partialDeltaChunks(delta: string): string[] {
    const chunks: string[] = [];
    for (let offset = 0; offset < delta.length;) {
      let end = Math.min(delta.length, offset + MAX_PARTIAL_DELTA_CHARS);
      const finalCodeUnit = delta.charCodeAt(end - 1);
      const nextCodeUnit = delta.charCodeAt(end);
      if (end < delta.length && finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF && nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF) end -= 1;
      chunks.push(delta.slice(offset, end));
      offset = end;
    }
    return chunks;
  }

  private correlationFor(message: unknown): Correlation {
    const existing = this.currentCorrelation();
    if (existing) return { ...existing };
    const objectMessage = typeof message === "object" && message !== null ? message : null;
    const known = objectMessage ? this.messageCorrelations.get(objectMessage) : undefined;
    return known ? { ...known } : { origin: "unknown", delivery: "unknown" };
  }

  private buildMarker(role: MessageRole, eventId: string, groupId: string, correlation: Correlation): MarkerV2 {
    if (role === "user") {
      const marker: Record<string, unknown> = {
        version: 2, event_id: eventId, group_id: groupId, kind: "user",
        origin: correlation.origin, delivery: correlation.delivery,
      };
      if (correlation.senderRef !== undefined) marker.sender_ref = correlation.senderRef;
      return MarkerSchemaV2.parse(marker) as MarkerV2;
    }
    return MarkerSchemaV2.parse({ version: 2, event_id: eventId, group_id: groupId, kind: role === "assistant" ? "assistant" : "tool" }) as MarkerV2;
  }

  private parseMarker(data: unknown): MarkerV2 | null {
    const parsed = MarkerSchemaV2.safeParse(data);
    return parsed.success ? parsed.data : null;
  }

  private correlationFromMarker(marker: MarkerV2): Correlation {
    if (marker.kind !== "user") return { origin: "unknown", delivery: "unknown" };
    return {
      origin: marker.origin,
      delivery: marker.delivery,
      ...(marker.sender_ref ? { senderRef: marker.sender_ref } : {}),
    };
  }

  private roleForMarker(marker: MarkerV2): MessageRole {
    if (marker.kind === "user") return "user";
    return marker.kind === "assistant" ? "assistant" : "toolResult";
  }

  private scanTargetAfterMarker(branch: readonly SessionEntry[], markerIndex: number, role: MessageRole): MessageEntry | undefined {
    for (let index = markerIndex + 1; index < branch.length; index += 1) {
      const entry = branch[index]!;
      if (entry.type === "custom" && entry.customType === TIMELINE_MARKER) return undefined;
      if (entry.type === "custom") continue;
      if (entry.type !== "message") return undefined;
      return this.messageRole(entry.message) === role ? entry : undefined;
    }
    return undefined;
  }

  private toTimelineEvent(entry: MessageEntry, marker: MarkerV2, correlation: Correlation, sessionManager: SessionManager): TimelineEvent | null {
    const message = this.asMessageRecord(entry.message);
    if (!message) return null;
    const sessionId = sessionManager.getSessionId();
    const timestamp = this.timestamp(entry.timestamp, message.timestamp);
    const historyGeneration = this.getHistoryGenerationValue?.() ?? sessionId;
    const base = { event_id: marker.event_id, session_id: sessionId, history_generation: historyGeneration, timestamp };
    const groupId = marker.group_id;
    if (message.role === "user") {
      const senderRef = marker.kind === "user" && marker.sender_ref ? { sender_ref: marker.sender_ref } : {};
      return TimelineEventSchema.parse({
        ...base, group_id: groupId, kind: "user", message_id: marker.event_id,
        blocks: this.userBlocks(message.content), origin: correlation.origin, delivery: correlation.delivery,
        status: "committed", ...senderRef,
      });
    }
    if (message.role === "assistant") {
      if (message.stopReason === "error") {
        return TimelineEventSchema.parse({
          ...base,
          group_id: groupId,
          kind: "provider_error",
          message: this.nonEmpty(message.errorMessage ?? this.textFromContent(message.content) ?? "Provider error"),
        });
      }
      return TimelineEventSchema.parse({
        ...base, group_id: groupId, kind: "assistant", blocks: this.assistantBlocks(message.content),
        status: message.stopReason === "aborted" ? "interrupted" : "complete",
      });
    }
    const result = this.jsonValue(message.content);
    if (message.isError) {
      return TimelineEventSchema.parse({
        ...base, group_id: groupId, kind: "tool", tool_call_id: message.toolCallId ?? marker.event_id,
        tool: message.toolName ?? "unknown", args: this.jsonValue(message.args ?? {}), truncated: false,
        status: "error", error: this.nonEmpty(message.errorMessage ?? this.textFromContent(message.content) ?? "tool failed"),
      });
    }
    return TimelineEventSchema.parse({
      ...base, group_id: groupId, kind: "tool", tool_call_id: message.toolCallId ?? marker.event_id,
      tool: message.toolName ?? "unknown", args: this.jsonValue(message.args ?? {}), truncated: false,
      status: "complete", result,
    });
  }

  private toSystemEvent(entry: SessionEntry, sessionManager: SessionManager): TimelineEvent | null {
    const base = {
      event_id: entry.id,
      session_id: sessionManager.getSessionId(),
      history_generation: this.getHistoryGenerationValue?.() ?? sessionManager.getSessionId(),
      timestamp: this.timestamp(entry.timestamp),
      truncated: false,
    };
    let candidate: unknown;
    if (entry.type === "compaction") {
      candidate = {
        ...base,
        kind: "compaction",
        payload: {
          summary: entry.summary,
          first_kept_entry_id: entry.firstKeptEntryId,
          tokens_before: entry.tokensBefore,
          from_hook: entry.fromHook ?? false,
          ...(entry.details === undefined ? {} : { details: this.jsonValue(entry.details) }),
        },
      };
    } else if (entry.type === "branch_summary") {
      candidate = {
        ...base,
        kind: "branch_summary",
        payload: {
          summary: entry.summary,
          from_id: entry.fromId,
          from_hook: entry.fromHook ?? false,
          ...(entry.details === undefined ? {} : { details: this.jsonValue(entry.details) }),
        },
      };
    } else if (entry.type === "custom" && entry.customType !== TIMELINE_MARKER) {
      candidate = {
        ...base,
        kind: "custom",
        payload: {
          custom_type: entry.customType,
          ...(entry.data === undefined ? {} : { data: this.jsonValue(entry.data) }),
        },
      };
    } else {
      return null;
    }
    const parsed = TimelineEventSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }

  private asMessageRecord(value: unknown): MessageRecord | null {
    if (typeof value !== "object" || value === null) return null;
    const record = value as Partial<MessageRecord>;
    const role = record.role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult") return null;
    return record as MessageRecord;
  }

  private messageRole(value: unknown): MessageRole | null {
    return this.asMessageRecord(value)?.role ?? null;
  }

  private timestamp(entryTimestamp: string, messageTimestamp?: number): number {
    const entryMs = Date.parse(entryTimestamp);
    if (Number.isFinite(entryMs) && entryMs >= 0) return entryMs;
    if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp) && messageTimestamp >= 0) return messageTimestamp;
    return Date.now();
  }

  private userBlocks(content: unknown): JsonValue[] {
    if (typeof content === "string") return [{ type: "text", text: content }];
    if (!Array.isArray(content)) return [{ type: "text", text: "" }];
    return content.flatMap((part): JsonValue[] => {
      if (!part || typeof part !== "object") return [];
      const item = part as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
      if (item.type === "text" && typeof item.text === "string") return [{ type: "text", text: item.text }];
      if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
        return [{ type: "image", mime_type: item.mimeType, data: item.data, byte_length: this.base64Length(item.data) }];
      }
      return [];
    });
  }

  private assistantBlocks(content: unknown): JsonValue[] {
    if (typeof content === "string") return [{ type: "text", text: content }];
    if (!Array.isArray(content)) return [];
    return content.flatMap((part): JsonValue[] => {
      if (!part || typeof part !== "object") return [];
      const item = part as { type?: unknown; text?: unknown; thinking?: unknown };
      if (item.type === "text" && typeof item.text === "string") return [{ type: "text", text: item.text }];
      if (item.type === "thinking" && typeof item.thinking === "string") return [{ type: "thinking", text: item.thinking }];
      return [];
    });
  }

  private textFromContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.flatMap((part): string[] => {
      if (!part || typeof part !== "object") return [];
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    }).join(" ");
  }

  private nonEmpty(value: string): string {
    return value.trim() || "tool failed";
  }

  private base64Length(value: string): number {
    try {
      return Buffer.from(value, "base64").byteLength;
    } catch {
      return 0;
    }
  }

  private jsonValue(value: unknown): JsonValue {
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (Array.isArray(value)) return value.map((item) => this.jsonValue(item));
    if (typeof value === "object") {
      const result: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(value)) result[key] = this.jsonValue(item);
      return result;
    }
    return null;
  }
}
