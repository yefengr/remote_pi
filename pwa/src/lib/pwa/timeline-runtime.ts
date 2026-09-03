import type { ClientFrame, ServerFrame } from "../remote-pi/protocol-v2/frames";
import type { TimelineEvent, TimelinePartial } from "../remote-pi/protocol-v2/schema";
import { parseTimelineEventV2, parseTimelinePartialV2 } from "../remote-pi/protocol-v2/codec";

type UserMessageFrame = Extract<ClientFrame, { type: "user_message" }>;
type UserMessageImages = NonNullable<UserMessageFrame["images"]>;
type UserMessageSendResult = { frame: UserMessageFrame; change: TimelineRuntimeChange };

/** A timeline's live scope is endpoint/runtime-bound while persistence omits runtime. */
export type TimelineScope = {
  deviceId: string;
  endpointId: string;
  runtimeInstanceId: string;
  sessionId: string;
  historyGeneration: string;
  selfSenderRef: string;
  channelId: string;
};

export type PendingDelivery = "pending" | "received" | "accepted" | "committed" | "unknown_delivery";
export type TimelinePending = {
  kind: "pending";
  id: string;
  clientRequestId: string;
  text: string;
  images?: UserMessageImages;
  cancelable?: boolean;
  createdAt: number;
  delivery: PendingDelivery;
  requestId: string;
  messageId?: string;
};
export type TimelinePartialView = { kind: "partial"; partial: TimelinePartial; createdAt: number };
export type TimelineViewItem = { kind: "event"; event: TimelineEvent } | TimelinePending | TimelinePartialView;
export type TimelineRuntimeChange = {
  items: TimelineViewItem[];
  committed: TimelineEvent[];
  observed: ClientFrame[];
  unknown: TimelinePending[];
  reset?: Extract<ServerFrame, { type: "reset" }>;
};
type Pending = TimelinePending & { kind: "pending" };

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function compareItems(a: TimelineViewItem, b: TimelineViewItem): number {
  const aTime = a.kind === "event" ? a.event.timestamp : a.createdAt;
  const bTime = b.kind === "event" ? b.event.timestamp : b.createdAt;
  return aTime - bTime || itemId(a).localeCompare(itemId(b));
}
function itemId(item: TimelineViewItem): string {
  return item.kind === "event" ? item.event.event_id : item.kind === "partial" ? item.partial.partial_id : item.clientRequestId;
}
function isMatchingScope(scope: TimelineScope | null, frame: { session_id: string; history_generation: string }): boolean {
  return scope !== null && scope.sessionId === frame.session_id && scope.historyGeneration === frame.history_generation;
}
function mergePartial(previous: TimelinePartial | undefined, next: TimelinePartial): TimelinePartial {
  if (!previous || ("blocks" in next && next.blocks !== undefined)) return next;
  if (next.delta === undefined) return { ...next, ...(previous.delta === undefined ? {} : { delta: previous.delta }) };
  return { ...next, delta: `${previous.delta ?? ""}${next.delta}` };
}

/** In-memory v2 timeline state. It never persists pending or partial output. */
export class TimelineRuntime {
  private scope: TimelineScope | null = null;
  private readonly events = new Map<string, TimelineEvent>();
  private readonly partials = new Map<string, TimelinePartialView>();
  private readonly pending = new Map<string, Pending>();
  private historyEvents: TimelineEvent[] = [];
  private unknown: Pending[] = [];
  private readonly queuedIds = new Set<string>();
  private queuedSnapshotId: string | null = null;
  private readonly queuedSnapshotItems = new Map<string, (Extract<ServerFrame, { type: "queued_message_state" }>["items"])[number]>();
  private readonly observedQueue: ClientFrame[] = [];

  setScope(scope: TimelineScope): TimelineRuntimeChange {
    const changed = this.scope?.deviceId !== scope.deviceId
      || this.scope.endpointId !== scope.endpointId
      || this.scope.runtimeInstanceId !== scope.runtimeInstanceId
      || this.scope.sessionId !== scope.sessionId
      || this.scope.historyGeneration !== scope.historyGeneration;
    if (changed) {
      this.clearTransient(true);
      this.events.clear();
      this.historyEvents = [];
    }
    this.scope = scope;
    return this.change();
  }
  invalidateScope(): TimelineRuntimeChange {
    this.clearTransient(true);
    this.scope = null;
    this.events.clear();
    this.historyEvents = [];
    return this.change();
  }
  clear(): TimelineRuntimeChange {
    this.scope = null;
    this.events.clear();
    this.partials.clear();
    this.pending.clear();
    this.historyEvents = [];
    this.unknown = [];
    return this.change();
  }
  markDisconnected(): TimelineRuntimeChange {
    this.clearTransient(true);
    return this.change();
  }
  sendUser(text: string, images?: UserMessageImages, requestIds?: { clientRequestId: string; requestId: string }): UserMessageSendResult | null {
    const scope = this.scope;
    const hasImages = Boolean(images?.length);
    if (!scope || images?.length && images.length > 1 || (!text.trim() && !hasImages)) return null;
    const clientRequestId = requestIds?.clientRequestId ?? randomId();
    const requestId = requestIds?.requestId ?? randomId();
    this.pending.set(clientRequestId, { kind: "pending", id: `pending:${clientRequestId}`, clientRequestId, requestId, text, ...(hasImages ? { images } : {}), createdAt: Date.now(), delivery: "pending" });
    return { frame: this.userMessageFrame(scope, requestId, clientRequestId, text, images), change: this.change() };
  }
  markUnknownDelivery(clientRequestId: string): TimelineRuntimeChange {
    const pending = this.pending.get(clientRequestId);
    if (!pending) return this.change();
    this.pending.delete(clientRequestId);
    this.unknown.push({ ...pending, delivery: "unknown_delivery" });
    return this.change();
  }
  retryUnknown(clientRequestId: string): UserMessageSendResult | null {
    const scope = this.scope;
    const index = this.unknown.findIndex((pending) => pending.clientRequestId === clientRequestId);
    if (!scope || index < 0) return null;
    const previous = this.unknown[index];
    const requestId = randomId();
    const pending = { ...previous, requestId, delivery: "pending" as const };
    this.unknown.splice(index, 1);
    this.pending.set(clientRequestId, pending);
    return { frame: this.userMessageFrame(scope, requestId, clientRequestId, pending.text, pending.images), change: this.change() };
  }
  receive(frame: ServerFrame): TimelineRuntimeChange {
    if (frame.type === "session_ready") return this.change();
    if (frame.type === "reset") return { ...this.invalidateScope(), reset: frame };
    if (frame.type === "queued_message_state") {
      const scope = this.scope;
      if (!scope || !isMatchingScope(scope, frame)) return this.change();
      if (this.queuedSnapshotId !== frame.snapshot_id || frame.chunk_index === 0) {
        this.queuedSnapshotId = frame.snapshot_id;
        this.queuedSnapshotItems.clear();
      }
      for (const item of frame.items) this.queuedSnapshotItems.set(item.id, item);
      if (!frame.final) return this.change();
      const nextItems = [...this.queuedSnapshotItems.values()];
      const nextIds = new Set(nextItems.map((item) => item.id));
      for (const clientRequestId of this.queuedIds) {
        if (!nextIds.has(clientRequestId) && this.pending.get(clientRequestId)?.messageId === undefined) this.pending.delete(clientRequestId);
      }
      for (const item of nextItems) {
        const existing = this.pending.get(item.id);
        if (existing) {
          existing.text = item.text;
          existing.images = item.images;
          existing.cancelable = item.sender_ref === scope.selfSenderRef;
          existing.delivery = "accepted";
          continue;
        }
        this.unknown = this.unknown.filter((pending) => pending.clientRequestId !== item.id);
        this.pending.set(item.id, { kind: "pending", id: `pending:${item.id}`, clientRequestId: item.id, text: item.text, ...(item.images ? { images: item.images } : {}), cancelable: item.sender_ref === scope.selfSenderRef, createdAt: item.created_at, delivery: "accepted", requestId: item.id });
      }
      this.queuedIds.clear();
      for (const clientRequestId of nextIds) this.queuedIds.add(clientRequestId);
      this.queuedSnapshotItems.clear();
      this.queuedSnapshotId = null;
      return this.change();
    }
    if (frame.type === "protocol_error" && frame.in_reply_to) {
      const pending = [...this.pending.values()].find((candidate) => candidate.requestId === frame.in_reply_to);
      if (pending) {
        this.pending.delete(pending.clientRequestId);
        this.unknown.push({ ...pending, delivery: "unknown_delivery" });
      }
      return this.change();
    }
    if (frame.type === "user_message_status") {
      if (!isMatchingScope(this.scope, frame)) return this.change();
      const pending = this.pending.get(frame.client_request_id);
      if (!pending) return this.change();
      pending.delivery = frame.status;
      if ("message_id" in frame && frame.message_id) {
        pending.messageId = frame.message_id;
        this.reconcileUserMessage(frame.message_id);
      }
      if (frame.status === "unknown_delivery" && this.pending.has(frame.client_request_id)) {
        this.pending.delete(frame.client_request_id);
        this.unknown.push(pending);
        if (pending.messageId) this.reconcileUserMessage(pending.messageId);
      }
      return this.change();
    }
    if (frame.type === "user_message_started") {
      if (!isMatchingScope(this.scope, frame)) return this.change();
      const pending = [...this.pending.values()].find((candidate) => candidate.requestId === frame.in_reply_to);
      if (pending) {
        pending.delivery = "accepted";
        pending.messageId = frame.message.id;
        this.reconcileUserMessage(frame.message.id);
      }
      return this.change();
    }
    if (frame.type === "timeline_partial") {
      if (!isMatchingScope(this.scope, frame)) return this.change();
      try {
        const partial = parseTimelinePartialV2(frame);
        const previous = this.partials.get(partial.partial_id);
        this.partials.set(partial.partial_id, { kind: "partial", partial: mergePartial(previous?.partial, partial), createdAt: previous?.createdAt ?? Date.now() });
      } catch { /* strict decoder rejects invalid data */ }
      return this.change();
    }
    if (frame.type === "timeline_event") {
      if (isMatchingScope(this.scope, frame)) this.commit(frame.event);
      return this.change();
    }
    return this.change();
  }
  commit(event: TimelineEvent): TimelineRuntimeChange {
    try {
      const parsed = parseTimelineEventV2(event);
      if (this.scope && isMatchingScope(this.scope, parsed)) this.commitParsed(parsed);
    } catch { /* strict decoder rejects invalid data */ }
    return this.change();
  }
  replaceHistory(events: readonly TimelineEvent[]): TimelineRuntimeChange {
    this.historyEvents = [];
    this.events.clear();
    for (const event of events) {
      try {
        const parsed = parseTimelineEventV2(event);
        if (!this.scope || isMatchingScope(this.scope, parsed)) this.historyEvents.push(parsed);
      } catch { /* transfer assembler has already rejected malformed windows */ }
    }
    for (const event of this.historyEvents) this.commitParsed(event);
    return this.change();
  }
  prependHistory(events: readonly TimelineEvent[]): TimelineRuntimeChange {
    for (const event of events) {
      try {
        const parsed = parseTimelineEventV2(event);
        if (!this.scope || isMatchingScope(this.scope, parsed)) this.commitParsed(parsed);
      } catch { /* transfer assembler has already rejected malformed windows */ }
    }
    return this.change();
  }
  get currentScope(): TimelineScope | null { return this.scope; }
  get pendingItems(): TimelinePending[] { return [...this.pending.values(), ...this.unknown]; }
  private userMessageFrame(scope: TimelineScope, requestId: string, clientRequestId: string, text: string, images?: UserMessageImages): UserMessageFrame {
    return { protocol_version: 2, type: "user_message", id: requestId, channel_id: scope.channelId, history_generation: scope.historyGeneration, client_request_id: clientRequestId, text, ...(images?.length ? { images } : {}) };
  }
  private commitParsed(event: TimelineEvent): void {
    const previous = this.events.get(event.event_id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) return;
    this.events.set(event.event_id, event);
    if (event.kind === "user") this.reconcileUserMessage(event.message_id);
    if (event.kind === "assistant" || event.kind === "tool") {
      for (const [partialId, partial] of this.partials) {
        if (partial.partial.group_id !== event.group_id) continue;
        const matches = event.kind === "assistant" ? partial.partial.kind === "assistant" || partial.partial.kind === "thinking" : partial.partial.kind === "tool";
        if (matches) this.partials.delete(partialId);
      }
    }
  }
  private reconcileUserMessage(messageId: string): void {
    const formal = [...this.events.values()].find((event): event is Extract<TimelineEvent, { kind: "user" }> => event.kind === "user" && event.message_id === messageId);
    if (!formal) return;
    const matches = [...this.pending.entries(), ...this.unknown.map((pending) => [pending.clientRequestId, pending] as const)].filter(([, pending]) => pending.messageId === messageId);
    for (const [clientRequestId] of matches) {
      this.pending.delete(clientRequestId);
      this.unknown = this.unknown.filter((pending) => pending.clientRequestId !== clientRequestId);
      if (this.scope) this.observedQueue.push({ protocol_version: 2, type: "user_message_observed", id: randomId(), channel_id: this.scope.channelId, history_generation: this.scope.historyGeneration, client_request_id: clientRequestId, message_id: formal.message_id, status: "committed" });
    }
  }
  private clearTransient(movePendingToUnknown: boolean): void {
    this.partials.clear();
    this.queuedIds.clear();
    this.queuedSnapshotItems.clear();
    this.queuedSnapshotId = null;
    if (movePendingToUnknown) for (const pending of this.pending.values()) this.unknown.push({ ...pending, delivery: "unknown_delivery" });
    this.pending.clear();
  }
  private change(): TimelineRuntimeChange {
    const items: TimelineViewItem[] = [...this.events.values().map((event) => ({ kind: "event" as const, event })), ...this.pending.values(), ...this.unknown, ...this.partials.values()];
    items.sort(compareItems);
    return { items, committed: [], observed: this.observedQueue.splice(0), unknown: [...this.unknown] };
  }
}
