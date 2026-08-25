import { z } from "zod";

export const PROTOCOL_VERSION_V2 = 2 as const;
export const TIMELINE_MARKER_NAME = "remote-pi:timeline-v2" as const;
export const MAX_FRAME_BYTES = 512 * 1024;
export const MAX_HISTORY_CHUNK_BYTES = 512 * 1024;
export const MAX_WINDOW_DECODE_BYTES = 32 * 1024 * 1024;
export const MAX_FRAGMENT_DECODE_BYTES = 50 * 1024;
export const MAX_ID_CHARS = 256;
export const MAX_TEXT_CHARS = 1024 * 1024;
export const MAX_ARRAY_ITEMS = 4096;

const id = z.string().min(1).max(MAX_ID_CHARS);
const boundedText = z.string().max(MAX_TEXT_CHARS);
const nonEmptyText = boundedText.min(1);
const nonNegativeInt = z.number().int().nonnegative().finite();
const finiteNumber = z.number().finite();
const timestamp = finiteNumber.nonnegative();
const base64 = z.string()
  .min(4)
  .max(Math.ceil((MAX_FRAGMENT_DECODE_BYTES * 4) / 3) + 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    finiteNumber,
    z.string().max(MAX_TEXT_CHARS),
    z.array(JsonValueSchema).max(MAX_ARRAY_ITEMS),
    z.record(z.string().max(MAX_ID_CHARS), JsonValueSchema),
  ]),
) as z.ZodType<JsonValue>;

const textBlock = z.strictObject({
  type: z.literal("text"),
  text: boundedText,
  truncated: z.literal(true).optional(),
});
const thinkingBlock = z.strictObject({
  type: z.literal("thinking"),
  text: boundedText,
  truncated: z.literal(true).optional(),
});
const imageMime = z.string().min(1).max(128).regex(/^[\w.+-]+\/[\w.+-]+$/);
const imageByteLength = nonNegativeInt.max(MAX_WINDOW_DECODE_BYTES);
const imageBlock = z.union([
  z.strictObject({
    type: z.literal("image"),
    mime_type: imageMime,
    data: z.string().min(1).max(MAX_WINDOW_DECODE_BYTES),
    byte_length: imageByteLength,
  }),
  z.strictObject({
    type: z.literal("image"),
    mime_type: imageMime,
    byte_length: imageByteLength,
    omitted: z.literal(true),
  }),
]);
const userBlock = z.union([textBlock, imageBlock]);
const assistantBlock = z.union([textBlock, thinkingBlock]);

export const TimelineUserBlockSchema = userBlock;
export const TimelineAssistantBlockSchema = assistantBlock;
export const TimelineTextBlockSchema = textBlock;
export const TimelineThinkingBlockSchema = thinkingBlock;
export const TimelineImageBlockSchema = imageBlock;

const eventBase = {
  event_id: id,
  session_id: id,
  history_generation: id,
  timestamp,
};
const groupedEventBase = { ...eventBase, group_id: id };

const timelineUserEvent = z.strictObject({
  ...groupedEventBase,
  kind: z.literal("user"),
  message_id: id,
  blocks: z.array(userBlock).max(MAX_ARRAY_ITEMS),
  origin: z.enum(["pwa", "extension", "unknown"]),
  sender_ref: id.optional(),
  delivery: z.enum(["normal", "queued", "unknown"]),
  status: z.literal("committed"),
}).superRefine((value, ctx) => {
  if (value.event_id !== value.message_id) {
    ctx.addIssue({ code: "custom", path: ["message_id"], message: "event_id must equal message_id" });
  }
  if (value.origin === "pwa" && value.sender_ref === undefined) {
    ctx.addIssue({ code: "custom", path: ["sender_ref"], message: "pwa user events require sender_ref" });
  }
  if (value.origin !== "pwa" && value.sender_ref !== undefined) {
    ctx.addIssue({ code: "custom", path: ["sender_ref"], message: "non-pwa user events must not include sender_ref" });
  }
});

const timelineAssistantEvent = z.strictObject({
  ...groupedEventBase,
  kind: z.literal("assistant"),
  blocks: z.array(assistantBlock).max(MAX_ARRAY_ITEMS),
  status: z.enum(["complete", "interrupted"]),
});

const timelineToolEvent = z.union([
  z.strictObject({
    ...groupedEventBase,
    kind: z.literal("tool"),
    tool_call_id: id,
    tool: nonEmptyText,
    args: JsonValueSchema,
    truncated: z.boolean(),
    status: z.literal("complete"),
    result: JsonValueSchema,
    error: z.never().optional(),
  }),
  z.strictObject({
    ...groupedEventBase,
    kind: z.literal("tool"),
    tool_call_id: id,
    tool: nonEmptyText,
    args: JsonValueSchema,
    truncated: z.boolean(),
    status: z.literal("error"),
    result: JsonValueSchema.optional(),
    error: nonEmptyText,
  }),
  z.strictObject({
    ...groupedEventBase,
    kind: z.literal("tool"),
    tool_call_id: id,
    tool: nonEmptyText,
    args: JsonValueSchema,
    truncated: z.boolean(),
    status: z.literal("interrupted"),
    result: z.never().optional(),
    error: z.never().optional(),
  }),
]);

const systemEvent = z.strictObject({
  ...eventBase,
  kind: z.enum(["compaction", "branch_summary", "custom"]),
  group_id: id.optional(),
  payload: JsonValueSchema,
  truncated: z.boolean(),
});
const providerErrorEvent = z.strictObject({
  ...groupedEventBase,
  kind: z.literal("provider_error"),
  message: nonEmptyText,
});

export const TimelineEventSchema = z.union([
  timelineUserEvent,
  timelineAssistantEvent,
  timelineToolEvent,
  systemEvent,
  providerErrorEvent,
]);
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

const partialBase = {
  protocol_version: z.literal(PROTOCOL_VERSION_V2),
  session_id: id,
  history_generation: id,
  group_id: id,
  partial_id: id,
  status: z.enum(["running", "delta"]),
};
const partialTextFields = {
  delta: boundedText.optional(),
};
const assistantPartial = z.strictObject({
  type: z.literal("timeline_partial"),
  ...partialBase,
  kind: z.literal("assistant"),
  blocks: z.array(assistantBlock).max(MAX_ARRAY_ITEMS).optional(),
  ...partialTextFields,
});
const thinkingPartial = z.strictObject({
  type: z.literal("timeline_partial"),
  ...partialBase,
  kind: z.literal("thinking"),
  blocks: z.array(thinkingBlock).max(MAX_ARRAY_ITEMS).optional(),
  ...partialTextFields,
});
const toolPartial = z.strictObject({
  type: z.literal("timeline_partial"),
  ...partialBase,
  kind: z.literal("tool"),
  tool_call_id: id,
  tool: nonEmptyText,
  args: JsonValueSchema.optional(),
  blocks: z.array(assistantBlock).max(MAX_ARRAY_ITEMS).optional(),
  ...partialTextFields,
});

export const TimelinePartialSchema = z.union([assistantPartial, thinkingPartial, toolPartial]);
export type TimelinePartial = z.infer<typeof TimelinePartialSchema>;

const frameBase = { protocol_version: z.literal(PROTOCOL_VERSION_V2) };
const clientDirect = { channel_id: id, history_generation: id };
const responseDirect = { target_channel_id: id };
const broadcastBase = { session_id: id, history_generation: id };

const wireImage = z.strictObject({
  data: z.string().min(1).max(MAX_WINDOW_DECODE_BYTES),
  mime: imageMime,
});
const harness = z.strictObject({ name: id, version: id });
const wireModel = z.strictObject({
  id,
  name: boundedText,
  provider: id,
  reasoning: z.boolean(),
  context_window: nonNegativeInt,
  vision: z.boolean(),
});
const actionName = z.enum(["session_new", "session_compact", "model_set", "thinking_set"]);
const thinkingLevel = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);

const askOption = z.strictObject({
  value: boundedText,
  label: boundedText,
  description: boundedText.optional(),
  preview: boundedText.optional(),
  freeform: z.boolean().optional(),
});
const askQuestion = z.strictObject({
  id,
  label: boundedText,
  prompt: boundedText,
  type: z.enum(["single", "multi", "preview"]),
  required: z.boolean(),
  presentedType: z.enum(["single", "multi", "preview"]).optional(),
  requestedType: z.enum(["single", "multi", "preview"]).optional(),
  options: z.array(askOption).max(MAX_ARRAY_ITEMS),
});
const askEnrichment = z.strictObject({
  flow_id: id,
  tool_call_id: id.nullable(),
  source: id,
  title: boundedText.nullable(),
  questions: z.array(askQuestion).max(MAX_ARRAY_ITEMS),
});
const askAnswer = z.strictObject({
  values: z.array(boundedText).max(MAX_ARRAY_ITEMS).optional(),
  customText: boundedText.optional(),
  note: boundedText.optional(),
  optionNotes: z.record(id, boundedText).optional(),
});
const askResponse = z.union([
  z.strictObject({
    flow_id: id,
    kind: z.literal("answer"),
    mode: z.enum(["submit", "elaborate"]).optional(),
    answers: z.record(id, askAnswer),
  }),
  z.strictObject({ flow_id: id, kind: z.literal("cancel") }),
]);

const extensionUiResponse = z.union([
  z.strictObject({ ...frameBase, type: z.literal("extension_ui_response"), id, ...clientDirect, value: boundedText, ask: askResponse.optional() }),
  z.strictObject({ ...frameBase, type: z.literal("extension_ui_response"), id, ...clientDirect, confirmed: z.boolean(), ask: askResponse.optional() }),
  z.strictObject({ ...frameBase, type: z.literal("extension_ui_response"), id, ...clientDirect, cancelled: z.literal(true), ask: askResponse.optional() }),
  z.strictObject({ ...frameBase, type: z.literal("extension_ui_response"), id, ...clientDirect, ask: askResponse }),
]);

const pairRequest = z.strictObject({ ...frameBase, type: z.literal("pair_request"), id, token: id, device_name: boundedText });
const sessionHello = z.strictObject({ ...frameBase, type: z.literal("session_hello"), id, channel_id: id });
const userMessage = z.strictObject({
  ...frameBase, type: z.literal("user_message"), id, ...clientDirect,
  client_request_id: id, text: boundedText, images: z.array(wireImage).max(MAX_ARRAY_ITEMS).optional(),
  streaming_behavior: z.literal("steer").optional(),
});
const userMessageObserved = z.strictObject({
  ...frameBase, type: z.literal("user_message_observed"), id, ...clientDirect,
  client_request_id: id, message_id: id, status: z.literal("committed"),
});
const sessionSync = z.strictObject({
  ...frameBase, type: z.literal("session_sync"), id, ...clientDirect,
  before: id.nullable(), limit: nonNegativeInt.max(100).optional(),
});
const ping = z.strictObject({ ...frameBase, type: z.literal("ping"), id, ...clientDirect });
const cancel = z.strictObject({ ...frameBase, type: z.literal("cancel"), id, ...clientDirect, target_id: id });
const actionCommon = { ...frameBase, id, ...clientDirect };
const sessionNew = z.strictObject({ ...actionCommon, type: z.literal("session_new") });
const sessionCompact = z.strictObject({ ...actionCommon, type: z.literal("session_compact") });
const modelSet = z.strictObject({ ...actionCommon, type: z.literal("model_set"), provider: id, model_id: id });
const thinkingSet = z.strictObject({ ...actionCommon, type: z.literal("thinking_set"), level: thinkingLevel });
const listModels = z.strictObject({ ...actionCommon, type: z.literal("list_models") });
const queuedSet = z.strictObject({ ...frameBase, type: z.literal("queued_message_set"), id, ...clientDirect, text: boundedText });
const queuedClear = z.strictObject({ ...frameBase, type: z.literal("queued_message_clear"), id, ...clientDirect, target_id: id.optional() });
const approveTool = z.strictObject({ ...frameBase, type: z.literal("approve_tool"), id, ...clientDirect, tool_call_id: id, decision: z.enum(["allow", "deny"]) });

export const ClientFrameSchema = z.union([
  pairRequest, sessionHello, userMessage, userMessageObserved, sessionSync, ping, cancel,
  sessionNew, sessionCompact, modelSet, thinkingSet, listModels, queuedSet, queuedClear,
  approveTool, extensionUiResponse,
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

const pairOk = z.strictObject({
  ...frameBase, type: z.literal("pair_ok"), in_reply_to: id,
  session_name: boundedText, session_started_at: timestamp, room_id: id,
  harness: harness.optional(), hostname: boundedText.optional(),
});
const pairError = z.strictObject({
  ...frameBase, type: z.literal("pair_error"), in_reply_to: id,
  code: z.enum(["token_expired", "token_consumed", "token_unknown", "internal_error"]), message: nonEmptyText,
});
const sessionReady = z.strictObject({
  ...frameBase, type: z.literal("session_ready"), in_reply_to: id, ...responseDirect,
  session_id: id, history_generation: id, self_sender_ref: id,
});
const startedMessage = z.strictObject({
  id, group_id: id, blocks: z.array(userBlock).max(MAX_ARRAY_ITEMS),
  origin: z.enum(["pwa", "extension", "unknown"]), sender_ref: id.optional(), delivery: z.enum(["normal", "queued", "unknown"]),
}).superRefine((value, ctx) => {
  if (value.origin === "pwa" && value.sender_ref === undefined) {
    ctx.addIssue({ code: "custom", path: ["sender_ref"], message: "pwa user messages require sender_ref" });
  }
  if (value.origin !== "pwa" && value.sender_ref !== undefined) {
    ctx.addIssue({ code: "custom", path: ["sender_ref"], message: "non-pwa user messages must not include sender_ref" });
  }
});
const userMessageStarted = z.strictObject({
  ...frameBase, type: z.literal("user_message_started"), ...responseDirect, in_reply_to: id,
  session_id: id, history_generation: id, message: startedMessage,
});
const userMessageStatus = z.union([
  z.strictObject({ ...frameBase, type: z.literal("user_message_status"), ...responseDirect, in_reply_to: id, session_id: id, history_generation: id, client_request_id: id, status: z.literal("received") }),
  z.strictObject({ ...frameBase, type: z.literal("user_message_status"), ...responseDirect, in_reply_to: id, session_id: id, history_generation: id, client_request_id: id, status: z.literal("accepted"), message_id: id.optional(), group_id: id.optional() }),
  z.strictObject({ ...frameBase, type: z.literal("user_message_status"), ...responseDirect, in_reply_to: id, session_id: id, history_generation: id, client_request_id: id, status: z.literal("committed"), message_id: id, group_id: id.optional() }),
  z.strictObject({ ...frameBase, type: z.literal("user_message_status"), ...responseDirect, in_reply_to: id, session_id: id, history_generation: id, client_request_id: id, status: z.literal("unknown_delivery") }),
]);
const timelineEventFrame = z.strictObject({ ...frameBase, type: z.literal("timeline_event"), ...broadcastBase, event: TimelineEventSchema });
export const TimelineEventFragmentSchema = z.strictObject({
  ...frameBase, type: z.literal("timeline_event_fragment"), ...broadcastBase,
  event_id: id, index: nonNegativeInt, data_base64: base64, final: z.boolean(),
});
export const HistoryFragmentSchema = z.strictObject({ event_id: id, index: nonNegativeInt, data_base64: base64, final: z.boolean() });
const historyFragment = HistoryFragmentSchema;
const historyChunkBase = {
  ...frameBase, type: z.literal("session_history_chunk"), ...responseDirect,
  in_reply_to: id, session_id: id, history_generation: id, snapshot_head: id,
  chunk_index: nonNegativeInt, events: z.array(TimelineEventSchema).max(MAX_ARRAY_ITEMS),
  fragments: z.array(historyFragment).max(MAX_ARRAY_ITEMS),
};
const historyChunkTail = {
  final_chunk: z.literal(false), next_before: z.never().optional(), eos: z.never().optional(),
};
const historyChunkEos = {
  final_chunk: z.literal(true), eos: z.literal(true), next_before: z.never().optional(),
};
const historyChunkNext = {
  final_chunk: z.literal(true), eos: z.literal(false), next_before: id,
};
function validateHistoryChunk(
  value: { events: Array<{ event_id: string }>; fragments: Array<{ event_id: string }> },
  ctx: z.RefinementCtx,
): void {
  const eventIds = new Set(value.events.map((event) => event.event_id));
  const fragmentIds = new Set(value.fragments.map((fragment) => fragment.event_id));
  for (const eventId of eventIds) {
    if (fragmentIds.has(eventId)) ctx.addIssue({ code: "custom", path: ["fragments"], message: "an event cannot be both complete and fragmented" });
  }
  if (fragmentIds.size !== value.fragments.length) ctx.addIssue({ code: "custom", path: ["fragments"], message: "fragment event ids must be unique per chunk" });
}
export const SessionHistoryChunkSchema = z.union([
  z.strictObject({ ...historyChunkBase, ...historyChunkTail }),
  z.strictObject({ ...historyChunkBase, ...historyChunkEos }),
  z.strictObject({ ...historyChunkBase, ...historyChunkNext }),
]).superRefine(validateHistoryChunk);
const protocolErrorFields = {
  type: z.literal("protocol_error"),
  in_reply_to: id.optional(),
  code: z.enum(["protocol_upgrade_required", "invalid_message", "unsupported_type", "invalid_channel", "invalid_generation", "invalid_cursor", "reset_required", "too_large", "internal_error"]),
  message: nonEmptyText,
};
const protocolError = z.union([
  z.strictObject({ ...frameBase, ...protocolErrorFields, ...responseDirect }),
  z.strictObject({ ...frameBase, ...protocolErrorFields }),
]);
const reset = z.strictObject({
  ...frameBase, type: z.literal("reset"), ...responseDirect,
  session_id: id, history_generation: id, reason: z.enum(["generation_changed", "branch_changed", "session_replaced", "conflict", "invalid_cursor"]),
});
const pong = z.strictObject({ ...frameBase, type: z.literal("pong"), ...responseDirect, in_reply_to: id });
const cancelled = z.strictObject({ ...frameBase, type: z.literal("cancelled"), ...responseDirect, in_reply_to: id, target_id: id });
const actionOk = z.strictObject({ ...frameBase, type: z.literal("action_ok"), ...responseDirect, in_reply_to: id, action: actionName });
const actionError = z.strictObject({ ...frameBase, type: z.literal("action_error"), ...responseDirect, in_reply_to: id, action: actionName, error: nonEmptyText });
const modelsList = z.strictObject({ ...frameBase, type: z.literal("models_list"), ...responseDirect, in_reply_to: id, models: z.array(wireModel).max(MAX_ARRAY_ITEMS), current: wireModel.optional() });

const extensionUiRequest = z.union([
  z.strictObject({ ...frameBase, type: z.literal("extension_ui_request"), ...responseDirect, id, method: z.literal("select"), title: boundedText, options: z.array(boundedText).max(MAX_ARRAY_ITEMS), ask: askEnrichment.optional() }),
  z.strictObject({ ...frameBase, type: z.literal("extension_ui_request"), ...responseDirect, id, method: z.literal("confirm"), title: boundedText, message: boundedText, ask: askEnrichment.optional() }),
  z.strictObject({ ...frameBase, type: z.literal("extension_ui_request"), ...responseDirect, id, method: z.literal("input"), title: boundedText, placeholder: boundedText.optional(), ask: askEnrichment.optional() }),
  z.strictObject({ ...frameBase, type: z.literal("extension_ui_request"), ...responseDirect, id, method: z.literal("editor"), title: boundedText, prefill: boundedText.optional(), ask: askEnrichment.optional() }),
  z.strictObject({ ...frameBase, type: z.literal("extension_ui_request"), ...responseDirect, id, method: z.literal("notify"), message: boundedText, notify_type: z.enum(["info", "warning", "error"]).optional() }),
]);
const bye = z.strictObject({ ...frameBase, type: z.literal("bye"), ...broadcastBase, reason: z.enum(["peer_stop", "session_replaced", "shutdown"]) });

export const ServerFrameSchema = z.union([
  pairOk, pairError, sessionReady, userMessageStarted, userMessageStatus,
  timelineEventFrame, TimelinePartialSchema, TimelineEventFragmentSchema, SessionHistoryChunkSchema,
  protocolError, reset, pong, cancelled, actionOk, actionError, modelsList, extensionUiRequest, bye,
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

export const ClientFrameTypes = new Set<ClientFrame["type"]>([
  "pair_request", "session_hello", "user_message", "user_message_observed", "session_sync", "ping", "cancel",
  "session_new", "session_compact", "model_set", "thinking_set", "list_models", "queued_message_set", "queued_message_clear", "approve_tool", "extension_ui_response",
]);
export const ServerFrameTypes = new Set<ServerFrame["type"]>([
  "pair_ok", "pair_error", "session_ready", "user_message_started", "user_message_status", "timeline_event", "timeline_partial", "timeline_event_fragment", "session_history_chunk", "protocol_error", "reset", "pong", "cancelled", "action_ok", "action_error", "models_list", "extension_ui_request", "bye",
]);

const markerSystemKind = z.enum(["compaction", "branch_summary", "custom"]);
const markerGroupedBase = { version: z.literal(2), event_id: id, group_id: id };
const markerUser = z.strictObject({
  ...markerGroupedBase, kind: z.literal("user"), message_id: id.optional(),
  origin: z.enum(["pwa", "extension", "unknown"]), delivery: z.enum(["normal", "queued", "unknown"]), sender_ref: id.optional(),
}).superRefine((value, ctx) => {
  if (value.message_id !== undefined && value.message_id !== value.event_id) {
    ctx.addIssue({ code: "custom", path: ["message_id"], message: "message_id must equal event_id" });
  }
  if (value.origin === "pwa" && value.sender_ref === undefined) {
    ctx.addIssue({ code: "custom", path: ["sender_ref"], message: "pwa marker users require sender_ref" });
  }
  if (value.origin !== "pwa" && value.sender_ref !== undefined) {
    ctx.addIssue({ code: "custom", path: ["sender_ref"], message: "non-pwa marker users must not include sender_ref" });
  }
});
const markerGrouped = z.strictObject({ ...markerGroupedBase, kind: z.enum(["assistant", "tool", "provider_error"]) });
const markerSystem = z.strictObject({ version: z.literal(2), event_id: id, kind: markerSystemKind, group_id: id.optional() });
export const MarkerSchemaV2 = z.union([markerUser, markerGrouped, markerSystem]);
export type MarkerV2 = z.infer<typeof MarkerSchemaV2>;
