import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  TimelineEventSchema,
  V2SessionState,
  MAX_FRAME_BYTES,
  MAX_FRAGMENT_DECODE_BYTES,
  type ClientFrame,
  type ServerFrame,
  type TimelineEvent,
  type TimelinePartial,
} from "../protocol/v2/index.js";
import { TimelineHistoryPager } from "./history.js";
import type { Correlation, TimelineRuntime, TimelineStarted } from "./runtime.js";

export type V2ServiceOptions = {
  sessionManager: SessionManager;
  senderRef: string;
  generation?: string;
  runtime: TimelineRuntime;
  onUserMessage: (
    frame: Extract<ClientFrame, { type: "user_message" }>,
    correlation: Correlation,
  ) => boolean;
  onCancel?: (targetId: string) => boolean;
};

export type V2Broadcast = Extract<
  ServerFrame,
  { type: "timeline_event" | "timeline_partial" | "timeline_event_fragment" }
>;

type RecordWithChannel = ReturnType<V2SessionState["snapshot"]>["records"][number] & { channelId: string };

export class TimelineV2Service {
  private readonly state: V2SessionState;
  private readonly pager: TimelineHistoryPager;
  private readonly sessionManager: SessionManager;
  private readonly senderRef: string;
  private readonly runtime: TimelineRuntime;
  private readonly onUserMessage: V2ServiceOptions["onUserMessage"];
  private readonly onCancel?: V2ServiceOptions["onCancel"];
  private readonly requestChannels = new Map<string, string>();
  private generationValue: string;

  constructor(options: V2ServiceOptions) {
    this.sessionManager = options.sessionManager;
    this.senderRef = options.senderRef;
    this.generationValue = options.generation ?? options.sessionManager.getSessionId();
    this.state = new V2SessionState({ generation: this.generationValue });
    this.runtime = options.runtime;
    this.onUserMessage = options.onUserMessage;
    this.onCancel = options.onCancel;
    this.pager = new TimelineHistoryPager(
      this.sessionManager,
      (manager) => this.runtime.recover(manager),
      () => this.generationValue,
    );
  }

  get generation(): string {
    return this.generationValue;
  }

  reset(reason: "generation_changed" | "branch_changed" | "session_replaced"): ServerFrame[] {
    return this.state.snapshot().channels.map((channel) => ({
      protocol_version: 2,
      type: "reset" as const,
      target_channel_id: channel.channelId,
      session_id: this.sessionManager.getSessionId(),
      history_generation: this.generation,
      reason,
    }));
  }

  refreshGeneration(next: string): boolean {
    if (!next || next === this.generationValue) return false;
    this.generationValue = next;
    this.state.setGeneration(next);
    this.requestChannels.clear();
    return true;
  }

  handle(frame: ClientFrame): ServerFrame[] {
    switch (frame.type) {
      case "session_hello":
        return [this.ready(frame)];
      case "pair_request":
        return [this.error(frame.id, "protocol_upgrade_required", "pairing is handled before session_hello")];
      case "session_sync":
        return this.handleHistory(frame);
      case "ping":
        return this.handlePing(frame);
      case "cancel":
        return this.handleCancel(frame);
      case "user_message":
        return this.handleUserMessage(frame);
      case "user_message_observed":
        return this.handleObserved(frame);
      case "queued_message_set":
      case "queued_message_clear":
      case "approve_tool":
      case "session_new":
      case "session_compact":
      case "model_set":
      case "thinking_set":
      case "list_models":
      case "extension_ui_response":
        return this.requireReady(frame);
    }
  }

  started(started: TimelineStarted): ServerFrame[] {
    const clientRequestId = started.correlation.clientRequestId;
    if (!clientRequestId) return [];
    const request = this.findRecord(clientRequestId);
    if (!request) return [];
    this.state.update(request.key, "accepted", { messageId: started.eventId, groupId: started.groupId });
    const message = {
      id: started.eventId,
      group_id: started.groupId,
      blocks: started.blocks as never,
      origin: started.correlation.origin,
      ...(started.correlation.senderRef ? { sender_ref: started.correlation.senderRef } : {}),
      delivery: started.correlation.delivery,
    };
    return [
      ...this.direct(request.channelId, {
        type: "user_message_status",
        in_reply_to: started.correlation.requestId ?? clientRequestId,
        session_id: this.sessionManager.getSessionId(),
        history_generation: this.generation,
        client_request_id: clientRequestId,
        status: "accepted",
        message_id: started.eventId,
        group_id: started.groupId,
      }),
      ...this.direct(request.channelId, {
        type: "user_message_started",
        in_reply_to: started.correlation.requestId ?? clientRequestId,
        session_id: this.sessionManager.getSessionId(),
        history_generation: this.generation,
        message,
      }),
    ];
  }

  commit(clientRequestId: string, messageId: string, groupId?: string): ServerFrame[] {
    const request = this.findRecord(clientRequestId);
    if (!request) return [];
    const record = this.state.update(request.key, "committed", { messageId, groupId });
    if (!record) return [];
    return this.direct(request.channelId, {
      type: "user_message_status",
      in_reply_to: clientRequestId,
      session_id: this.sessionManager.getSessionId(),
      history_generation: this.generation,
      client_request_id: clientRequestId,
      status: "committed",
      message_id: messageId,
      ...(groupId ? { group_id: groupId } : {}),
    });
  }

  canDrain(clientRequestId: string): boolean {
    return this.findRecord(clientRequestId)?.status === "received";
  }

  unknownDelivery(clientRequestId: string): ServerFrame[] {
    const request = this.findRecord(clientRequestId);
    if (!request) return [];
    const updated = this.state.rememberUnknownDelivery(request.key);
    if (!updated) return [];
    return this.direct(request.channelId, {
      type: "user_message_status",
      in_reply_to: clientRequestId,
      session_id: this.sessionManager.getSessionId(),
      history_generation: this.generation,
      client_request_id: clientRequestId,
      status: "unknown_delivery",
    });
  }

  partial(partial: TimelinePartial): V2Broadcast | null {
    if (partial.session_id !== this.sessionManager.getSessionId() || partial.history_generation !== this.generation) return null;
    return partial as V2Broadcast;
  }

  publish(event: TimelineEvent): V2Broadcast | null {
    return this.publishFrames(event)[0] as V2Broadcast | undefined ?? null;
  }

  publishFrames(event: TimelineEvent): V2Broadcast[] {
    const parsed = TimelineEventSchema.safeParse(event);
    if (!parsed.success) return [];
    const complete: V2Broadcast = {
      protocol_version: 2,
      type: "timeline_event",
      session_id: this.sessionManager.getSessionId(),
      history_generation: this.generation,
      event: parsed.data,
    };
    if (new TextEncoder().encode(JSON.stringify(complete)).byteLength <= MAX_FRAME_BYTES) return [complete];
    const bytes = new TextEncoder().encode(JSON.stringify(parsed.data));
    const frames: V2Broadcast[] = [];
    for (let offset = 0, index = 0; offset < bytes.byteLength; offset += MAX_FRAGMENT_DECODE_BYTES, index += 1) {
      const slice = bytes.slice(offset, offset + MAX_FRAGMENT_DECODE_BYTES);
      frames.push({
        protocol_version: 2,
        type: "timeline_event_fragment",
        session_id: this.sessionManager.getSessionId(),
        history_generation: this.generation,
        event_id: parsed.data.event_id,
        index,
        data_base64: Buffer.from(slice).toString("base64"),
        final: offset + slice.byteLength >= bytes.byteLength,
      });
    }
    return frames;
  }

  private ready(frame: Extract<ClientFrame, { type: "session_hello" }>): ServerFrame {
    this.state.hello(this.senderRef, frame.channel_id);
    return {
      protocol_version: 2,
      type: "session_ready",
      in_reply_to: frame.id,
      target_channel_id: frame.channel_id,
      session_id: this.sessionManager.getSessionId(),
      history_generation: this.generation,
      self_sender_ref: this.senderRef,
    };
  }

  private handleHistory(frame: Extract<ClientFrame, { type: "session_sync" }>): ServerFrame[] {
    const error = this.ensureReady(frame);
    if (error) return [error];
    return this.pager.sync({
      requestId: frame.id,
      targetChannelId: frame.channel_id,
      before: frame.before,
      limit: frame.limit,
    });
  }

  private handlePing(frame: Extract<ClientFrame, { type: "ping" }>): ServerFrame[] {
    const error = this.ensureReady(frame);
    if (error) return [error];
    return this.direct(frame.channel_id, { type: "pong", in_reply_to: frame.id });
  }

  private handleCancel(frame: Extract<ClientFrame, { type: "cancel" }>): ServerFrame[] {
    const error = this.ensureReady(frame);
    if (error) return [error];
    try {
      if (!(this.onCancel?.(frame.target_id) ?? false)) {
        return [this.error(frame.id, "internal_error", "no active request to cancel", frame.channel_id)];
      }
      return this.direct(frame.channel_id, {
        type: "cancelled",
        in_reply_to: frame.id,
        target_id: frame.target_id,
      });
    } catch (cancelError) {
      const detail = cancelError instanceof Error ? cancelError.message : String(cancelError);
      return [this.error(frame.id, "internal_error", `cancel failed: ${detail}`, frame.channel_id)];
    }
  }

  private handleObserved(frame: Extract<ClientFrame, { type: "user_message_observed" }>): ServerFrame[] {
    const error = this.ensureReady(frame);
    if (error) return [error];
    const record = this.state.getRecord(this.recordKey(frame.client_request_id));
    if (!record || record.senderRef !== this.senderRef) {
      return [this.error(frame.id, "invalid_message", "unknown observed request", frame.channel_id)];
    }
    this.state.forget(record.key);
    this.requestChannels.delete(frame.client_request_id);
    return [];
  }

  private handleUserMessage(frame: Extract<ClientFrame, { type: "user_message" }>): ServerFrame[] {
    const error = this.ensureReady(frame);
    if (error) return [error];
    const result = this.state.begin({
      senderRef: this.senderRef,
      clientRequestId: frame.client_request_id,
      payload: this.idempotencyPayload(frame),
    });
    if (result.kind === "conflict") {
      return [this.error(frame.id, "invalid_message", "client_request_id payload conflict", frame.channel_id)];
    }
    if (result.kind === "replay") return this.replay(frame, result.record);
    this.requestChannels.set(frame.client_request_id, frame.channel_id);
    const correlation: Correlation = frame.streaming_behavior === "steer"
      ? { origin: "unknown", delivery: "unknown", channelId: frame.channel_id, requestId: frame.id }
      : {
        origin: "pwa",
        delivery: "normal",
        senderRef: this.senderRef,
        channelId: frame.channel_id,
        requestId: frame.id,
        clientRequestId: frame.client_request_id,
      };
    try {
      const acceptedForDelivery = this.onUserMessage(frame, correlation);
      if (!acceptedForDelivery) return this.unknownDelivery(frame.client_request_id);
      if (frame.streaming_behavior === "steer") return this.unknownDelivery(frame.client_request_id);
      return [this.status(frame, "received")];
    } catch {
      return this.unknownDelivery(frame.client_request_id);
    }
  }

  private replay(
    frame: Extract<ClientFrame, { type: "user_message" }>,
    record: ReturnType<V2SessionState["begin"]>["record"],
  ): ServerFrame[] {
    if (record.status === "unknown_delivery") return this.unknownDelivery(frame.client_request_id);
    if (record.status === "received") return [this.status(frame, "received")];
    return [this.status(frame, record.status === "committed" ? "committed" : "accepted", record.messageId, record.groupId)];
  }

  private status(
    frame: Extract<ClientFrame, { type: "user_message" }>,
    status: "received" | "accepted" | "committed",
    messageId?: string,
    groupId?: string,
  ): ServerFrame {
    return this.direct(frame.channel_id, {
      type: "user_message_status",
      in_reply_to: frame.id,
      session_id: this.sessionManager.getSessionId(),
      history_generation: this.generation,
      client_request_id: frame.client_request_id,
      status,
      ...(messageId ? { message_id: messageId } : {}),
      ...(groupId ? { group_id: groupId } : {}),
    })[0]!;
  }

  private requireReady(frame: ClientFrame): ServerFrame[] {
    const error = this.ensureReady(frame);
    return [error ?? this.error("id" in frame ? frame.id : "v2", "unsupported_type", "frame is not implemented", "channel_id" in frame ? frame.channel_id : undefined)];
  }

  private ensureReady(frame: ClientFrame): ServerFrame | null {
    if (!("channel_id" in frame) || !this.state.get(this.senderRef, frame.channel_id)) {
      return this.error("id" in frame ? frame.id : "v2", "invalid_channel", "session_hello required", "channel_id" in frame ? frame.channel_id : undefined);
    }
    if ("history_generation" in frame && frame.history_generation !== this.generation) {
      return {
        protocol_version: 2,
        type: "reset",
        target_channel_id: frame.channel_id,
        session_id: this.sessionManager.getSessionId(),
        history_generation: this.generation,
        reason: "generation_changed",
      };
    }
    this.state.touch(this.senderRef, frame.channel_id);
    return null;
  }

  private direct(channelId: string, frame: Record<string, unknown>): ServerFrame[] {
    return [{ ...frame, protocol_version: 2, target_channel_id: channelId } as ServerFrame];
  }

  private error(
    inReplyTo: string,
    code: "protocol_upgrade_required" | "invalid_channel" | "invalid_message" | "unsupported_type" | "internal_error",
    message: string,
    channelId?: string,
  ): ServerFrame {
    return {
      protocol_version: 2,
      type: "protocol_error",
      ...(channelId ? { target_channel_id: channelId } : {}),
      in_reply_to: inReplyTo,
      code,
      message,
    };
  }

  private idempotencyPayload(frame: Extract<ClientFrame, { type: "user_message" }>): unknown {
    return {
      text: frame.text,
      images: frame.images ?? [],
      streaming_behavior: frame.streaming_behavior ?? null,
    };
  }

  private recordKey(clientRequestId: string): string {
    return `${this.generation}\u0000${this.senderRef}\u0000${clientRequestId}`;
  }

  private findRecord(clientRequestId: string): RecordWithChannel | undefined {
    const record = this.state.getRecord(this.recordKey(clientRequestId));
    const channelId = this.requestChannels.get(clientRequestId);
    if (!record || !channelId) return undefined;
    return { ...record, channelId };
  }
}
