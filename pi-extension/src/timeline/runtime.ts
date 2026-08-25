import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  MarkerSchemaV2,
  TimelineEventSchema,
  type JsonValue,
  type MarkerV2,
  type TimelineEvent,
} from "../protocol/v2/index.js";

export const TIMELINE_MARKER = "remote-pi:timeline-v2" as const;

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
};

export type Correlation = {
  clientRequestId?: string;
  origin: "pwa" | "extension" | "unknown";
  delivery: "normal" | "queued" | "unknown";
  senderRef?: string;
};

type PendingMessage = {
  message: object;
  role: MessageRole;
  marker: MarkerV2;
  correlation: Correlation;
};

type SessionEntry = ReturnType<SessionManager["getBranch"]>[number];
type MessageEntry = Extract<SessionEntry, { type: "message" }>;

export type TimelineRuntimeOptions = {
  onPublished?: (event: TimelineEvent) => void;
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
  private readonly onPublished?: (event: TimelineEvent) => void;

  constructor(options: TimelineRuntimeOptions = {}) {
    this.onPublished = options.onPublished;
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
    return this.sessionId;
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  getPublishedEvents(): readonly TimelineEvent[] {
    return [...this.published];
  }

  getCorrelation(message: object): Correlation | undefined {
    return this.messageCorrelations.get(message);
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
  }

  onMessageStart(message: unknown, sessionManager: SessionManager): void {
    this.attach(sessionManager);
    const record = this.asMessageRecord(message);
    if (!record) return;
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
    const pending = { message: objectMessage, role: record.role, marker, correlation };
    this.pending.set(objectMessage, pending);
    this.pendingByRole[record.role].push(pending);
  }

  onMessageEnd(message: unknown, sessionManager: SessionManager): void {
    this.attach(sessionManager);
    if (typeof message !== "object" || message === null) return;
    const objectMessage = message as object;
    const direct = this.pending.get(objectMessage);
    const role = this.messageRole(message);
    const pending = direct ?? (role && role !== "user" ? this.pendingByRole[role][0] : undefined);
    if (!pending) return;
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
      this.publish(event);
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
    return recovered;
  }

  private publish(event: TimelineEvent): void {
    if (this.published.some((existing) => existing.event_id === event.event_id)) return;
    this.published.push(event);
    this.onPublished?.(event);
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
    const base = { event_id: marker.event_id, session_id: sessionId, history_generation: sessionId, timestamp };
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
      return TimelineEventSchema.parse({
        ...base, group_id: groupId, kind: "assistant", blocks: this.assistantBlocks(message.content),
        status: message.stopReason === "error" ? "interrupted" : "complete",
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
      const item = part as { type?: unknown; text?: unknown };
      if ((item.type === "text" || item.type === "thinking") && typeof item.text === "string") {
        return [{ type: item.type, text: item.text }];
      }
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
