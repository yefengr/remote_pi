import { expect, test } from "vitest";
import { decodeClientFrameV2, decodeServerFrameV2, encodeClientFrameV2, encodeServerFrameV2 } from "../remote-pi/protocol-v2/codec";
import type { ClientFrame, ServerFrame } from "../remote-pi/protocol-v2/frames";
import type { TimelineEvent, TimelinePartial } from "../remote-pi/protocol-v2/schema";
import { TimelineRuntime, type TimelineScope } from "./timeline-runtime";
import { HistoryWindowAssembler, TimelineEventFragmentAssembler, type HistoryChunkFrame, type TimelineEventFragmentFrame } from "./timeline-transfer";

type Payload = Uint8Array;
type RelayEnvelope = {
  sourceChannelId?: string;
  targetChannelId?: string;
  broadcast: boolean;
  payload: Payload;
};
type PwaReceiver = (payload: Payload) => void;
type OwnerReceiver = (envelope: RelayEnvelope) => void;

/** Relay 只看 outer routing metadata，payload 始终是 opaque bytes。 */
export class InMemoryRelay {
  private readonly clients = new Map<string, PwaReceiver>();
  private owner?: OwnerReceiver;

  attachOwner(receiver: OwnerReceiver): void {
    this.owner = receiver;
  }

  connect(channelId: string, receiver: PwaReceiver): void {
    this.clients.set(channelId, receiver);
  }

  channels(): string[] {
    return [...this.clients.keys()];
  }

  fromPwa(channelId: string, payload: Payload): void {
    this.owner?.({ sourceChannelId: channelId, broadcast: false, payload });
  }

  fromOwner(payload: Payload, route: { broadcast: true } | { broadcast: false; targetChannelId: string }): void {
    if (route.broadcast) {
      for (const receiver of this.clients.values()) receiver(payload);
      return;
    }
    this.clients.get(route.targetChannelId)?.(payload);
  }
}

type SimulatorOptions = {
  history?: TimelineEvent[];
  deferHistory?: boolean;
  deferUserLifecycle?: boolean;
  commitUsers?: boolean;
};

type PendingHistory = { channelId: string; chunks: HistoryChunkFrame[] };
type PendingUserLifecycle = {
  channelId: string;
  request: Extract<ClientFrame, { type: "user_message" }>;
  messageId: string;
  groupId: string;
};

/** 只模拟冻结的 v2 TimelineV2Service 时序，不模拟真实 SDK。 */
export class ExtensionPeerSimulator {
  readonly userFrames: Extract<ClientFrame, { type: "user_message" }>[] = [];
  readonly statusHistory: Extract<ServerFrame, { type: "user_message_status" }>[] = [];
  readonly startedHistory: Extract<ServerFrame, { type: "user_message_started" }>[] = [];
  readonly releasedRequests = new Map<string, number>();
  private readonly observed = new Set<string>();
  private readonly history: TimelineEvent[];
  private readonly pendingHistory = new Map<string, PendingHistory>();
  private readonly deferHistory: boolean;
  private readonly deferUserLifecycle: boolean;
  private readonly commitUsers: boolean;
  private readonly pendingUserLifecycles = new Map<string, PendingUserLifecycle>();
  private sequence = 0;
  private generationValue = "G1";
  private readonly sessionId = "SESSION";

  constructor(private readonly relay: InMemoryRelay, options: SimulatorOptions = {}) {
    this.history = options.history ?? [];
    this.deferHistory = options.deferHistory ?? false;
    this.deferUserLifecycle = options.deferUserLifecycle ?? false;
    this.commitUsers = options.commitUsers ?? true;
    relay.attachOwner((envelope) => this.receive(envelope));
  }

  get generation(): string {
    return this.generationValue;
  }

  receive(envelope: RelayEnvelope): void {
    if (!envelope.sourceChannelId) return;
    let frame: ClientFrame;
    try {
      frame = decodeClientFrameV2(envelope.payload);
    } catch {
      return;
    }
    const channelId = envelope.sourceChannelId;
    if (frame.type === "session_hello") {
      this.send(channelId, {
        protocol_version: 2,
        type: "session_ready",
        target_channel_id: channelId,
        in_reply_to: frame.id,
        session_id: this.sessionId,
        history_generation: this.generationValue,
        self_sender_ref: `sender-${channelId}`,
      });
      return;
    }
    if (frame.type === "user_message") {
      this.userFrames.push(frame);
      if (frame.streaming_behavior === "steer") {
        this.sendStatus(channelId, frame, "unknown_delivery");
        return;
      }
      if (!this.commitUsers) return;
      const messageId = `M-${frame.client_request_id}`;
      const groupId = `GR-${frame.client_request_id}`;
      this.sendStatus(channelId, frame, "received");
      if (this.deferUserLifecycle) {
        this.pendingUserLifecycles.set(frame.client_request_id, { channelId, request: frame, messageId, groupId });
        return;
      }
      this.completeUserLifecycle({ channelId, request: frame, messageId, groupId });
      return;
    }
    if (frame.type === "user_message_observed") {
      if (this.observed.has(frame.client_request_id)) return;
      this.observed.add(frame.client_request_id);
      this.releasedRequests.set(frame.client_request_id, (this.releasedRequests.get(frame.client_request_id) ?? 0) + 1);
      return;
    }
    if (frame.type === "session_sync") {
      const chunks = this.makeHistoryChunks(frame.id, channelId);
      this.pendingHistory.set(frame.id, { channelId, chunks });
      if (!this.deferHistory) for (const chunk of chunks) this.sendHistoryChunk(chunk);
    }
  }

  flushHistoryChunk(requestId: string, index: number): void {
    const pending = this.pendingHistory.get(requestId);
    expect(pending, `unknown history request ${requestId}`).toBeTruthy();
    const chunk = pending!.chunks[index];
    expect(chunk, `unknown history chunk ${index}`).toBeTruthy();
    this.sendHistoryChunk(chunk!);
    if (chunk!.final_chunk) this.pendingHistory.delete(requestId);
  }

  flushUserLifecycle(clientRequestId: string): void {
    const pending = this.pendingUserLifecycles.get(clientRequestId);
    expect(pending, `unknown user request ${clientRequestId}`).toBeTruthy();
    this.pendingUserLifecycles.delete(clientRequestId);
    this.completeUserLifecycle(pending!);
  }

  emitEvent(event: TimelineEvent): void {
    this.broadcast({ protocol_version: 2, type: "timeline_event", session_id: event.session_id, history_generation: event.history_generation, event });
  }

  emitPartial(partial: TimelinePartial): void {
    this.broadcast(partial);
  }

  emitFragmentedEvent(event: TimelineEvent, chunkSize = 32, fragmentCount?: number, fragmentStart = 0): void {
    const bytes = new TextEncoder().encode(JSON.stringify(event));
    const chunks: TimelineEventFragmentFrame[] = [];
    for (let offset = 0, index = 0; offset < bytes.length; offset += chunkSize, index += 1) {
      const end = Math.min(offset + chunkSize, bytes.length);
      chunks.push({
        protocol_version: 2,
        type: "timeline_event_fragment",
        session_id: event.session_id,
        history_generation: event.history_generation,
        event_id: event.event_id,
        index,
        data_base64: toBase64(bytes.slice(offset, end)),
        final: end === bytes.length,
      });
    }
    const end = fragmentCount === undefined ? chunks.length : fragmentStart + fragmentCount;
    for (const fragment of chunks.slice(fragmentStart, end)) this.broadcast(fragment);
  }

  resetGeneration(nextGeneration: string): void {
    this.generationValue = nextGeneration;
    for (const channelId of this.relay.channels()) {
      this.send(channelId, {
        protocol_version: 2,
        type: "reset",
        target_channel_id: channelId,
        session_id: this.sessionId,
        history_generation: nextGeneration,
        reason: "generation_changed",
      });
    }
  }

  private completeUserLifecycle(pending: PendingUserLifecycle): void {
    const { channelId, request, messageId, groupId } = pending;
    this.sendStatus(channelId, request, "accepted", messageId, groupId);
    const started: Extract<ServerFrame, { type: "user_message_started" }> = {
      protocol_version: 2,
      type: "user_message_started",
      target_channel_id: channelId,
      in_reply_to: request.id,
      session_id: this.sessionId,
      history_generation: this.generationValue,
      message: {
        id: messageId,
        group_id: groupId,
        blocks: [{ type: "text", text: request.text }],
        origin: "pwa",
        sender_ref: `sender-${channelId}`,
        delivery: "normal",
      },
    };
    this.startedHistory.push(started);
    this.send(channelId, started);
    this.emitEvent({
      event_id: messageId,
      message_id: messageId,
      session_id: this.sessionId,
      history_generation: this.generationValue,
      timestamp: ++this.sequence,
      group_id: groupId,
      kind: "user",
      blocks: [{ type: "text", text: request.text }],
      origin: "pwa",
      sender_ref: `sender-${channelId}`,
      delivery: "normal",
      status: "committed",
    });
    this.sendStatus(channelId, request, "committed", messageId, groupId);
  }

  private sendStatus(channelId: string, request: Extract<ClientFrame, { type: "user_message" }>, status: "received" | "accepted" | "committed" | "unknown_delivery", messageId?: string, groupId?: string): void {
    const frame = {
      protocol_version: 2 as const,
      type: "user_message_status" as const,
      target_channel_id: channelId,
      in_reply_to: request.id,
      session_id: this.sessionId,
      history_generation: this.generationValue,
      client_request_id: request.client_request_id,
      status,
      ...(messageId ? { message_id: messageId } : {}),
      ...(groupId ? { group_id: groupId } : {}),
    } as Extract<ServerFrame, { type: "user_message_status" }>;
    this.statusHistory.push(frame);
    this.send(channelId, frame);
  }

  private makeHistoryChunks(requestId: string, channelId: string): HistoryChunkFrame[] {
    const first = this.history.slice(0, Math.max(1, Math.ceil(this.history.length / 2)));
    const second = this.history.slice(first.length);
    const base = (index: number, events: TimelineEvent[]) => ({
      protocol_version: 2 as const,
      type: "session_history_chunk" as const,
      target_channel_id: channelId,
      in_reply_to: requestId,
      session_id: this.sessionId,
      history_generation: this.generationValue,
      snapshot_head: "HEAD",
      chunk_index: index,
      events,
      fragments: [],
    });
    if (second.length === 0) return [{ ...base(0, first), final_chunk: true, eos: true }];
    return [
      { ...base(0, first), final_chunk: false },
      { ...base(1, second), final_chunk: true, eos: true },
    ];
  }

  private sendHistoryChunk(frame: HistoryChunkFrame): void {
    this.send(frame.target_channel_id, frame);
  }

  private send(channelId: string, frame: ServerFrame): void {
    this.relay.fromOwner(encodeServerFrameV2(frame), { broadcast: false, targetChannelId: channelId });
  }

  private broadcast(frame: ServerFrame): void {
    this.relay.fromOwner(encodeServerFrameV2(frame), { broadcast: true });
  }
}

export class PwaHarnessClient {
  readonly runtime = new TimelineRuntime();
  readonly receivedFrames: ServerFrame[] = [];
  readonly observedFrames: Extract<ClientFrame, { type: "user_message_observed" }>[] = [];
  private historyAssembler?: HistoryWindowAssembler;
  private fragmentAssembler?: TimelineEventFragmentAssembler;
  private readonly journal = new Map<string, TimelineEvent>();
  private lastChange = this.runtime.clear();

  constructor(readonly relay: InMemoryRelay, readonly channelId: string) {
    relay.connect(channelId, (payload) => this.receivePayload(payload));
  }

  hello(): void {
    this.sendFrame({ protocol_version: 2, type: "session_hello", id: `HELLO-${this.channelId}`, channel_id: this.channelId });
  }

  sendUser(text: string, deliver = true): ReturnType<TimelineRuntime["sendUser"]> {
    const result = this.runtime.sendUser(text);
    if (result) this.lastChange = result.change;
    if (result && deliver) this.sendFrame(result.frame);
    return result;
  }

  sendSteer(text: string): ReturnType<TimelineRuntime["sendUser"]> {
    const result = this.runtime.sendUser(text);
    if (result) this.lastChange = result.change;
    if (result) this.sendFrame({ ...result.frame, streaming_behavior: "steer" });
    return result;
  }

  requestHistory(): string {
    const scope = this.requireScope();
    const requestId = `SYNC-${this.channelId}`;
    this.historyAssembler = new HistoryWindowAssembler(requestId, { session_id: scope.sessionId, history_generation: scope.historyGeneration });
    this.sendFrame({ protocol_version: 2, type: "session_sync", id: requestId, channel_id: this.channelId, history_generation: scope.historyGeneration, before: null, limit: 50 });
    return requestId;
  }

  resendObserved(index = 0): void {
    const frame = this.observedFrames[index];
    expect(frame).toBeTruthy();
    this.sendFrame(frame!);
  }

  receiveRaw(raw: string): boolean {
    try {
      this.receivePayload(new TextEncoder().encode(raw));
      return true;
    } catch {
      return false;
    }
  }

  eventIds(): string[] {
    return this.lastChange.items.filter((item) => item.kind === "event").map((item) => item.event.event_id);
  }

  currentItems(): ReturnType<TimelineRuntime["receive"]>["items"] {
    return this.lastChange.items;
  }

  private sendFrame(frame: ClientFrame): void {
    this.relay.fromPwa(this.channelId, encodeClientFrameV2(frame));
  }

  private receivePayload(payload: Payload): void {
    const frame = decodeServerFrameV2(payload);
    if ("target_channel_id" in frame && frame.target_channel_id !== this.channelId) return;
    this.receivedFrames.push(frame);
    if (frame.type === "session_ready") {
      this.lastChange = this.runtime.setScope(this.scope(frame.history_generation, frame.self_sender_ref));
      this.fragmentAssembler = new TimelineEventFragmentAssembler({ session_id: frame.session_id, history_generation: frame.history_generation });
      this.drainObserved(this.lastChange);
      return;
    }
    if (frame.type === "reset") {
      this.lastChange = this.runtime.receive(frame);
      this.historyAssembler = undefined;
      this.fragmentAssembler?.reset();
      this.fragmentAssembler = undefined;
      this.journal.clear();
      this.drainObserved(this.lastChange);
      return;
    }
    if (frame.type === "timeline_event_fragment") {
      const scope = this.runtime.currentScope;
      if (!scope || !sameScope(scope, frame)) return;
      const result = this.fragmentAssembler?.accept(frame);
      if (result?.status === "complete") {
        this.journal.set(result.event.event_id, result.event);
        this.lastChange = this.runtime.commit(result.event);
        this.drainObserved(this.lastChange);
      }
      return;
    }
    if (frame.type === "session_history_chunk") {
      const result = this.historyAssembler?.accept(frame);
      if (result?.status === "complete") {
        const journal = [...this.journal.values()];
        this.lastChange = this.runtime.replaceHistory([...result.events, ...journal]);
        this.journal.clear();
        this.historyAssembler = undefined;
        this.drainObserved(this.lastChange);
      }
      return;
    }
    if (frame.type === "timeline_event") {
      const scope = this.runtime.currentScope;
      if (!scope || !sameScope(scope, frame.event)) return;
      this.journal.set(frame.event.event_id, frame.event);
      this.lastChange = this.runtime.commit(frame.event);
    } else {
      this.lastChange = this.runtime.receive(frame);
    }
    this.drainObserved(this.lastChange);
  }

  private scope(historyGeneration: string, selfSenderRef: string): TimelineScope {
    return { deviceId: "DEVICE", endpointId: "ENDPOINT", runtimeInstanceId: "RUNTIME", sessionId: "SESSION", historyGeneration, selfSenderRef, channelId: this.channelId };
  }

  private requireScope(): TimelineScope {
    const scope = this.runtime.currentScope;
    if (!scope) throw new Error("PWA client is not ready");
    return scope;
  }

  private drainObserved(change: ReturnType<TimelineRuntime["receive"]>): void {
    for (const frame of change.observed) {
      if (frame.type !== "user_message_observed") continue;
      this.observedFrames.push(frame);
      this.sendFrame(frame);
    }
  }
}

function sameScope(scope: TimelineScope, value: { session_id: string; history_generation: string }): boolean {
  return scope.sessionId === value.session_id && scope.historyGeneration === value.history_generation;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function userEvent(eventId: string, generation = "G1", timestamp = 1): Extract<TimelineEvent, { kind: "user" }> {
  return {
    event_id: eventId,
    message_id: eventId,
    session_id: "SESSION",
    history_generation: generation,
    timestamp,
    group_id: `GROUP-${eventId}`,
    kind: "user",
    blocks: [{ type: "text", text: eventId }],
    origin: "extension",
    delivery: "normal",
    status: "committed",
  };
}

function assistantEvent(eventId: string, generation = "G1", timestamp = 2): Extract<TimelineEvent, { kind: "assistant" }> {
  return {
    event_id: eventId,
    session_id: "SESSION",
    history_generation: generation,
    timestamp,
    group_id: `GROUP-${eventId}`,
    kind: "assistant",
    blocks: [{ type: "text", text: eventId }],
    status: "complete",
  };
}

function setup(options: SimulatorOptions = {}): { relay: InMemoryRelay; simulator: ExtensionPeerSimulator; first: PwaHarnessClient; second: PwaHarnessClient } {
  const relay = new InMemoryRelay();
  const simulator = new ExtensionPeerSimulator(relay, options);
  const first = new PwaHarnessClient(relay, "C1");
  const second = new PwaHarnessClient(relay, "C2");
  return { relay, simulator, first, second };
}

test("routes two channel hello/direct responses separately and broadcasts owner events", () => {
  const { simulator, first, second } = setup();
  first.hello();
  second.hello();
  expect(first.runtime.currentScope?.channelId).toBe("C1");
  expect(second.runtime.currentScope?.channelId).toBe("C2");

  const scopeBefore = second.runtime.currentScope;
  const itemsBefore = second.currentItems();
  const directFrames: ServerFrame[] = [
    { protocol_version: 2, type: "user_message_status", target_channel_id: "C1", in_reply_to: "REQ", session_id: "SESSION", history_generation: "G1", client_request_id: "OTHER", status: "received" },
    { protocol_version: 2, type: "session_ready", target_channel_id: "C1", in_reply_to: "HELLO-C1", session_id: "SESSION", history_generation: "G99", self_sender_ref: "sender-C1" },
    { protocol_version: 2, type: "session_history_chunk", target_channel_id: "C1", in_reply_to: "SYNC-C1", session_id: "SESSION", history_generation: "G1", snapshot_head: "HEAD", chunk_index: 0, events: [userEvent("WRONG")], fragments: [], final_chunk: true, eos: true },
    { protocol_version: 2, type: "reset", target_channel_id: "C1", session_id: "SESSION", history_generation: "G2", reason: "generation_changed" },
  ];
  for (const frame of directFrames) expect(second.receiveRaw(JSON.stringify(frame))).toBe(true);
  expect(second.runtime.currentScope).toStrictEqual(scopeBefore);
  expect(second.currentItems()).toStrictEqual(itemsBefore);

  const sent = first.sendUser("hello");
  expect(sent).toBeTruthy();
  expect(first.receivedFrames.filter((frame) => frame.type === "user_message_status").length).toBe(3);
  expect(second.receivedFrames.filter((frame) => frame.type === "user_message_status").length).toBe(0);
  expect(first.eventIds()).toStrictEqual(second.eventIds());
  expect(simulator.releasedRequests.get(sent!.frame.client_request_id)).toBe(1);
});

test("reconciles pending received/accepted/committed and records observed idempotently", () => {
  const { simulator, first } = setup({ deferUserLifecycle: true });
  first.hello();
  const sent = first.sendUser("precise");
  expect(sent).toBeTruthy();
  expect(first.currentItems().find((item) => item.kind === "pending")?.delivery).toBe("received");
  simulator.flushUserLifecycle(sent!.frame.client_request_id);
  const statuses = simulator.statusHistory.filter((frame) => frame.client_request_id === sent!.frame.client_request_id);
  expect(statuses.map((frame) => frame.status)).toStrictEqual(["received", "accepted", "committed"]);
  expect(simulator.startedHistory.some((frame) => frame.in_reply_to === sent!.frame.id)).toBe(true);
  expect(first.currentItems().some((item) => item.kind === "pending")).toBe(false);
  expect(first.eventIds()).toStrictEqual([`M-${sent!.frame.client_request_id}`]);
  expect(simulator.releasedRequests.get(sent!.frame.client_request_id)).toBe(1);
  first.resendObserved();
  expect(simulator.releasedRequests.get(sent!.frame.client_request_id)).toBe(1);
});

test("merges realtime journal into an in-flight history snapshot without duplicate window events", () => {
  const history = [userEvent("H1", "G1", 1), assistantEvent("H2", "G1", 2)];
  const { simulator, first } = setup({ history, deferHistory: true });
  first.hello();
  const requestId = first.requestHistory();
  simulator.flushHistoryChunk(requestId, 0);
  simulator.emitEvent(assistantEvent("REALTIME", "G1", 3));
  simulator.flushHistoryChunk(requestId, 1);
  const ids = first.eventIds();
  expect(ids).toStrictEqual(["H1", "H2", "REALTIME"]);
  expect(new Set(ids).size).toBe(ids.length);
});

test("reassembles an oversized formal event from v2 fragments before committing it", () => {
  const { simulator, first } = setup();
  first.hello();
  const event = assistantEvent("FRAGMENTED", "G1", 4);
  simulator.emitFragmentedEvent(event, 9, 2);
  expect(first.eventIds()).toStrictEqual([]);
  simulator.emitFragmentedEvent(event, 9, undefined, 2);
  expect(first.eventIds()).toStrictEqual([event.event_id]);
  expect(first.receivedFrames.filter((frame) => frame.type === "timeline_event_fragment").length > 2).toBe(true);
});

test("reset clears transient scope and partial fragments, rejects old generation, then accepts new hello", () => {
  const { simulator, first } = setup();
  first.hello();
  const pending = first.sendUser("will reset", false);
  expect(pending).toBeTruthy();
  simulator.emitPartial({ protocol_version: 2, type: "timeline_partial", session_id: "SESSION", history_generation: "G1", group_id: "GROUP", partial_id: "PARTIAL", kind: "assistant", status: "running", delta: "old" });
  simulator.emitFragmentedEvent(assistantEvent("OLD-PARTIAL", "G1", 5), 8, 1);
  expect(first.currentItems().some((item) => item.kind === "partial")).toBe(true);
  simulator.resetGeneration("G2");
  expect(first.runtime.currentScope).toBe(null);
  expect(first.currentItems().some((item) => item.kind === "partial" || (item.kind === "pending" && item.delivery === "pending"))).toBe(false);

  simulator.emitEvent(assistantEvent("OLD-EVENT", "G1", 6));
  expect(first.eventIds()).toStrictEqual([]);
  first.hello();
  const newScope = first.runtime.currentScope as TimelineScope | null;
  expect(newScope?.historyGeneration).toBe("G2");
  simulator.emitEvent(assistantEvent("NEW-EVENT", "G2", 7));
  expect(first.eventIds()).toStrictEqual(["NEW-EVENT"]);
});

test("rejects unknown frames and preserves steer as an explicit v2 input", () => {
  const { simulator, first } = setup();
  first.hello();
  expect(first.receiveRaw(JSON.stringify({ protocol_version: 2, type: "unknown" }))).toBe(false);
  const sent = first.sendSteer("steer me");
  expect(sent).toBeTruthy();
  expect(simulator.userFrames.at(-1)?.streaming_behavior).toBe("steer");
  expect(simulator.userFrames.at(-1)?.text).toBe("steer me");
  expect(simulator.statusHistory.filter((frame) => frame.client_request_id === sent!.frame.client_request_id).map((frame) => frame.status)).toStrictEqual(["unknown_delivery"]);
  expect(first.currentItems().find((item) => item.kind === "pending")?.delivery).toBe("unknown_delivery");
  expect(first.observedFrames.length).toBe(0);
  expect(first.eventIds()).toStrictEqual([]);
});

test("converges broadcast thinking and tool partials to formal events on every PWA", () => {
  const { simulator, first, second } = setup();
  first.hello();
  second.hello();
  simulator.emitPartial({ protocol_version: 2, type: "timeline_partial", session_id: "SESSION", history_generation: "G1", group_id: "ASSISTANT-GROUP", partial_id: "THINKING", kind: "thinking", status: "delta", delta: "reasoning" });
  simulator.emitPartial({ protocol_version: 2, type: "timeline_partial", session_id: "SESSION", history_generation: "G1", group_id: "ASSISTANT-GROUP", partial_id: "ASSISTANT", kind: "assistant", status: "delta", delta: "answer" });
  simulator.emitPartial({ protocol_version: 2, type: "timeline_partial", session_id: "SESSION", history_generation: "G1", group_id: "TOOL-GROUP", partial_id: "TOOL", kind: "tool", status: "running", tool_call_id: "TOOL-CALL", tool: "Read", args: { path: "/tmp/example" } });
  expect(first.currentItems().filter((item) => item.kind === "partial").length).toBe(3);
  expect(second.currentItems().filter((item) => item.kind === "partial").length).toBe(3);

  simulator.emitEvent({ event_id: "ASSISTANT-EVENT", session_id: "SESSION", history_generation: "G1", timestamp: 8, group_id: "ASSISTANT-GROUP", kind: "assistant", blocks: [{ type: "thinking", text: "reasoning" }, { type: "text", text: "answer" }], status: "complete" });
  simulator.emitEvent({ event_id: "TOOL-EVENT", session_id: "SESSION", history_generation: "G1", timestamp: 9, group_id: "TOOL-GROUP", kind: "tool", tool_call_id: "TOOL-CALL", tool: "Read", args: { path: "/tmp/example" }, truncated: false, status: "complete", result: "tool complete" });

  for (const client of [first, second]) {
    expect(client.currentItems().some((item) => item.kind === "partial")).toBe(false);
    expect(client.eventIds()).toStrictEqual(["ASSISTANT-EVENT", "TOOL-EVENT"]);
  }
});
