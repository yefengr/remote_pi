import type { ClientFrame, ServerFrame } from "../remote-pi/protocol-v2/frames";
import type { TimelineEvent, TimelinePartial } from "../remote-pi/protocol-v2/schema";
import { parseTimelineEventV2, parseTimelinePartialV2 } from "../remote-pi/protocol-v2/codec";

export type TimelineScope = {
  peerEpk: string;
  roomId: string;
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
  createdAt: number;
  delivery: PendingDelivery;
  requestId: string;
  messageId?: string;
};
export type TimelinePartialView = {
  kind: "partial";
  partial: TimelinePartial;
  createdAt: number;
};
export type TimelineViewItem =
  | { kind: "event"; event: TimelineEvent }
  | TimelinePending
  | TimelinePartialView;

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
  if (item.kind === "event") return item.event.event_id;
  if (item.kind === "partial") return item.partial.partial_id;
  return item.clientRequestId;
}

function isMatchingScope(scope: TimelineScope | null, frame: { session_id: string; history_generation: string }): boolean {
  return scope !== null && scope.sessionId === frame.session_id && scope.historyGeneration === frame.history_generation;
}

/** In-memory v2 timeline state. It never persists pending or partial output. */
export class TimelineRuntime {
  private scope: TimelineScope | null = null;
  private readonly events = new Map<string, TimelineEvent>();
  private readonly partials = new Map<string, TimelinePartialView>();
  private readonly pending = new Map<string, Pending>();
  private historyEvents: TimelineEvent[] = [];
  private unknown: Pending[] = [];
  private readonly observedQueue: ClientFrame[] = [];

  setScope(scope: TimelineScope): TimelineRuntimeChange {
    const changed = this.scope?.sessionId !== scope.sessionId || this.scope.historyGeneration !== scope.historyGeneration;
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

  sendUser(text: string, images?: Extract<ClientFrame, { type: "user_message" }>['images']): { frame: Extract<ClientFrame, { type: "user_message" }>; change: TimelineRuntimeChange } | null {
    const scope = this.scope;
    if (!scope || !text.trim()) return null;
    const clientRequestId = randomId();
    const now = Date.now();
    const requestId = randomId();
    this.pending.set(clientRequestId, { kind: "pending", id: `pending:${clientRequestId}`, clientRequestId, requestId, text, createdAt: now, delivery: "pending" });
    return {
      frame: {
        protocol_version: 2,
        type: "user_message",
        id: requestId,
        channel_id: scope.channelId,
        history_generation: scope.historyGeneration,
        client_request_id: clientRequestId,
        text,
        ...(images ? { images } : {}),
      },
      change: this.change(),
    };
  }

  receive(frame: ServerFrame): TimelineRuntimeChange {
    if (frame.type === "session_ready") return this.change();
    if (frame.type === "reset") return { ...this.invalidateScope(), reset: frame };
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
        this.partials.set(partial.partial_id, { kind: "partial", partial, createdAt: Date.now() });
      } catch {
        return this.change();
      }
      return this.change();
    }
    if (frame.type === "timeline_event") {
      if (!isMatchingScope(this.scope, frame)) return this.change();
      this.commit(frame.event);
      return this.change();
    }
    return this.change();
  }

  commit(event: TimelineEvent): TimelineRuntimeChange {
    try {
      const parsed = parseTimelineEventV2(event);
      if (this.scope && (parsed.session_id !== this.scope.sessionId || parsed.history_generation !== this.scope.historyGeneration)) return this.change();
      this.commitParsed(parsed);
    } catch {
      return this.change();
    }
    return this.change();
  }

  replaceHistory(events: readonly TimelineEvent[]): TimelineRuntimeChange {
    this.historyEvents = [];
    this.events.clear();
    for (const event of events) {
      try {
        const parsed = parseTimelineEventV2(event);
        if (!this.scope || isMatchingScope(this.scope, parsed)) this.historyEvents.push(parsed);
      } catch {
        // Invalid windows are rejected by the transfer assembler; ignore defensive failures here.
      }
    }
    for (const event of this.historyEvents) this.commitParsed(event);
    return this.change();
  }

  prependHistory(events: readonly TimelineEvent[]): TimelineRuntimeChange {
    for (const event of events) {
      try {
        const parsed = parseTimelineEventV2(event);
        if (!this.scope || isMatchingScope(this.scope, parsed)) this.commitParsed(parsed);
      } catch {
        // The transfer assembler already rejects an invalid page atomically.
      }
    }
    return this.change();
  }

  get currentScope(): TimelineScope | null {
    return this.scope;
  }

  get pendingItems(): TimelinePending[] {
    return [...this.pending.values(), ...this.unknown];
  }

  private commitParsed(event: TimelineEvent): void {
    const previous = this.events.get(event.event_id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) return;
    this.events.set(event.event_id, event);
    if (event.kind === "user") this.reconcileUserMessage(event.message_id);
    if (event.kind === "assistant" || event.kind === "tool") {
      for (const [partialId, partial] of this.partials) {
        if (partial.partial.group_id !== event.group_id) continue;
        const matchesFormalEvent = event.kind === "assistant"
          ? partial.partial.kind === "assistant" || partial.partial.kind === "thinking"
          : partial.partial.kind === "tool";
        if (matchesFormalEvent) this.partials.delete(partialId);
      }
    }
  }

  private reconcileUserMessage(messageId: string): void {
    const formal = [...this.events.values()].find((event): event is Extract<TimelineEvent, { kind: "user" }> => event.kind === "user" && event.message_id === messageId);
    if (!formal) return;
    const matches = [...this.pending.entries(), ...this.unknown.map((pending) => [pending.clientRequestId, pending] as const)]
      .filter(([, pending]) => pending.messageId === messageId);
    for (const [clientRequestId] of matches) {
      this.pending.delete(clientRequestId);
      this.unknown = this.unknown.filter((pending) => pending.clientRequestId !== clientRequestId);
      if (this.scope) this.observedQueue.push({ protocol_version: 2, type: "user_message_observed", id: randomId(), channel_id: this.scope.channelId, history_generation: this.scope.historyGeneration, client_request_id: clientRequestId, message_id: formal.message_id, status: "committed" });
    }
  }

  private clearTransient(movePendingToUnknown: boolean): void {
    this.partials.clear();
    if (movePendingToUnknown) {
      for (const pending of this.pending.values()) this.unknown.push({ ...pending, delivery: "unknown_delivery" });
    }
    this.pending.clear();
  }

  private change(): TimelineRuntimeChange {
    const items: TimelineViewItem[] = [
      ...this.events.values().map((event) => ({ kind: "event" as const, event })),
      ...this.pending.values(),
      ...this.unknown,
      ...this.partials.values(),
    ];
    items.sort(compareItems);
    return { items, committed: [], observed: this.observedQueue.splice(0), unknown: [...this.unknown] };
  }
}
