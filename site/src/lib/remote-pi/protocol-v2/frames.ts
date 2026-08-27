import { z } from "zod";
import {
  actionNameSchema,
  byeReasonSchema,
  channelIdSchema,
  extensionUiRequestPayloadSchema,
  extensionUiResponsePayloadSchema,
  harnessSchema,
  historyFragmentSchema,
  historyGenerationSchema,
  idSchema,
  MAX_ARRAY_ITEMS,
  protocolVersionSchema,
  timelineEventFragmentSchema,
  timelineEventSchema,
  timelinePartialSchema,
  thinkingLevelSchema,
  queuedMessageItemSchema,
  timestampSchema,
  userBlockSchema,
  wireImageSchema,
  wireModelSchema,
  CLIENT_FRAME_TYPES,
  SERVER_FRAME_TYPES,
  strictObject,
  textSchema,
} from "./schema";
import type { TimelineEvent, TimelinePartial } from "./schema";

const protocol = { protocol_version: protocolVersionSchema };
const channelRequest = {
  ...protocol,
  channel_id: channelIdSchema,
  history_generation: historyGenerationSchema,
};
const directResponse = {
  ...protocol,
  target_channel_id: channelIdSchema,
};
const ownerBroadcast = {
  ...protocol,
  session_id: idSchema,
  history_generation: historyGenerationSchema,
};

export const pairRequestFrameSchema = strictObject({
  ...protocol,
  type: z.literal("pair_request"),
  id: idSchema,
  token: idSchema,
  device_name: textSchema,
});
export const sessionHelloFrameSchema = strictObject({
  ...protocol,
  type: z.literal("session_hello"),
  id: idSchema,
  channel_id: channelIdSchema,
});
export const userMessageFrameSchema = strictObject({
  ...protocol,
  type: z.literal("user_message"),
  id: idSchema,
  ...channelRequest,
  client_request_id: idSchema,
  text: textSchema,
  images: z.array(wireImageSchema).max(1).optional(),
  streaming_behavior: z.literal("steer").optional(),
});
export const userMessageObservedFrameSchema = strictObject({
  ...protocol,
  type: z.literal("user_message_observed"),
  id: idSchema,
  ...channelRequest,
  client_request_id: idSchema,
  message_id: idSchema,
  status: z.literal("committed"),
});
export const sessionSyncFrameSchema = strictObject({
  ...protocol,
  type: z.literal("session_sync"),
  id: idSchema,
  ...channelRequest,
  before: idSchema.nullable(),
  limit: z.number().int().nonnegative().finite().max(100).optional(),
});
export const pingFrameSchema = strictObject({
  ...protocol,
  type: z.literal("ping"),
  id: idSchema,
  channel_id: channelIdSchema,
  history_generation: historyGenerationSchema,
});
export const cancelFrameSchema = strictObject({
  ...protocol,
  type: z.literal("cancel"),
  id: idSchema,
  ...channelRequest,
  target_id: idSchema,
});
export const sessionNewFrameSchema = strictObject({
  ...protocol,
  type: z.literal("session_new"),
  id: idSchema,
  ...channelRequest,
});
export const sessionCompactFrameSchema = strictObject({
  ...protocol,
  type: z.literal("session_compact"),
  id: idSchema,
  ...channelRequest,
});
export const modelSetFrameSchema = strictObject({
  ...protocol,
  type: z.literal("model_set"),
  id: idSchema,
  ...channelRequest,
  provider: idSchema,
  model_id: idSchema,
});
export const thinkingSetFrameSchema = strictObject({
  ...protocol,
  type: z.literal("thinking_set"),
  id: idSchema,
  ...channelRequest,
  level: thinkingLevelSchema,
});
export const listModelsFrameSchema = strictObject({
  ...protocol,
  type: z.literal("list_models"),
  id: idSchema,
  ...channelRequest,
});
export const queuedMessageSetFrameSchema = strictObject({
  ...protocol,
  type: z.literal("queued_message_set"),
  id: idSchema,
  ...channelRequest,
  text: textSchema,
  images: z.array(wireImageSchema).max(1).optional(),
});
export const queuedMessageClearFrameSchema = strictObject({
  ...protocol,
  type: z.literal("queued_message_clear"),
  id: idSchema,
  ...channelRequest,
  target_id: idSchema.optional(),
});
export const approveToolFrameSchema = strictObject({
  ...protocol,
  type: z.literal("approve_tool"),
  id: idSchema,
  ...channelRequest,
  tool_call_id: idSchema,
  decision: z.enum(["allow", "deny"]),
});

export const extensionUiResponseFrameSchema = z.union([
  strictObject({ ...protocol, type: z.literal("extension_ui_response"), id: idSchema, ...channelRequest, value: textSchema, ask: extensionUiResponsePayloadSchema.options[0].shape.ask.optional() }),
  strictObject({ ...protocol, type: z.literal("extension_ui_response"), id: idSchema, ...channelRequest, confirmed: z.boolean(), ask: extensionUiResponsePayloadSchema.options[1].shape.ask.optional() }),
  strictObject({ ...protocol, type: z.literal("extension_ui_response"), id: idSchema, ...channelRequest, cancelled: z.literal(true), ask: extensionUiResponsePayloadSchema.options[2].shape.ask.optional() }),
  strictObject({ ...protocol, type: z.literal("extension_ui_response"), id: idSchema, ...channelRequest, ask: extensionUiResponsePayloadSchema.options[3].shape.ask }),
]);

export const pairOkFrameSchema = strictObject({
  ...protocol,
  type: z.literal("pair_ok"),
  in_reply_to: idSchema,
  session_name: textSchema,
  session_started_at: timestampSchema,
  room_id: idSchema,
  harness: harnessSchema.optional(),
  hostname: textSchema.optional(),
});
export const pairErrorFrameSchema = strictObject({
  ...protocol,
  type: z.literal("pair_error"),
  in_reply_to: idSchema,
  code: z.enum(["token_expired", "token_consumed", "token_unknown", "internal_error"]),
  message: textSchema.min(1),
});
export const sessionReadyFrameSchema = strictObject({
  ...directResponse,
  type: z.literal("session_ready"),
  in_reply_to: idSchema,
  session_id: idSchema,
  history_generation: historyGenerationSchema,
  self_sender_ref: idSchema,
});

const startedMessageSchema = strictObject({
  id: idSchema,
  group_id: idSchema,
  blocks: z.array(userBlockSchema).max(MAX_ARRAY_ITEMS),
  origin: z.enum(["pwa", "extension", "unknown"]),
  sender_ref: idSchema.optional(),
  delivery: z.enum(["normal", "queued", "unknown"]),
}).superRefine((message, ctx) => {
  if (message.origin === "pwa" && message.sender_ref === undefined) {
    ctx.addIssue({ code: "custom", path: ["sender_ref"], message: "pwa user messages require sender_ref" });
  }
  if (message.origin !== "pwa" && message.sender_ref !== undefined) {
    ctx.addIssue({ code: "custom", path: ["sender_ref"], message: "non-pwa user messages must not include sender_ref" });
  }
});
export const userMessageStartedFrameSchema = strictObject({
  ...directResponse,
  type: z.literal("user_message_started"),
  in_reply_to: idSchema,
  session_id: idSchema,
  history_generation: historyGenerationSchema,
  message: startedMessageSchema,
});

export const userMessageStatusFrameSchema = z.union([
  strictObject({
    ...directResponse,
    type: z.literal("user_message_status"),
    in_reply_to: idSchema,
    session_id: idSchema,
    history_generation: historyGenerationSchema,
    client_request_id: idSchema,
    status: z.literal("received"),
  }),
  strictObject({
    ...directResponse,
    type: z.literal("user_message_status"),
    in_reply_to: idSchema,
    session_id: idSchema,
    history_generation: historyGenerationSchema,
    client_request_id: idSchema,
    status: z.literal("accepted"),
    message_id: idSchema.optional(),
    group_id: idSchema.optional(),
  }),
  strictObject({
    ...directResponse,
    type: z.literal("user_message_status"),
    in_reply_to: idSchema,
    session_id: idSchema,
    history_generation: historyGenerationSchema,
    client_request_id: idSchema,
    status: z.literal("committed"),
    message_id: idSchema,
    group_id: idSchema.optional(),
  }),
  strictObject({
    ...directResponse,
    type: z.literal("user_message_status"),
    in_reply_to: idSchema,
    session_id: idSchema,
    history_generation: historyGenerationSchema,
    client_request_id: idSchema,
    status: z.literal("unknown_delivery"),
  }),
]);

export const timelineEventFrameSchema = strictObject({
  ...ownerBroadcast,
  type: z.literal("timeline_event"),
  event: timelineEventSchema,
});
export const timelinePartialFrameSchema = timelinePartialSchema;
export const timelineEventFragmentFrameSchema = strictObject({
  ...ownerBroadcast,
  type: z.literal("timeline_event_fragment"),
  event_id: idSchema,
  index: z.number().int().nonnegative().finite(),
  data_base64: timelineEventFragmentSchema.shape.data_base64,
  final: z.boolean(),
});

const historyChunkBase = {
  ...directResponse,
  type: z.literal("session_history_chunk"),
  in_reply_to: idSchema,
  session_id: idSchema,
  history_generation: historyGenerationSchema,
  snapshot_head: idSchema,
  chunk_index: z.number().int().nonnegative().finite(),
  events: z.array(timelineEventSchema).max(MAX_ARRAY_ITEMS),
  fragments: z.array(historyFragmentSchema).max(MAX_ARRAY_ITEMS),
};
const historyChunkTail = {
  final_chunk: z.literal(false),
  next_before: z.never().optional(),
  eos: z.never().optional(),
};
const historyChunkEos = {
  final_chunk: z.literal(true),
  eos: z.literal(true),
  next_before: z.never().optional(),
};
const historyChunkNext = {
  final_chunk: z.literal(true),
  eos: z.literal(false),
  next_before: idSchema,
};
function validateHistoryChunk(
  value: { events: Array<{ event_id: string }>; fragments: Array<{ event_id: string }> },
  ctx: z.RefinementCtx,
): void {
  const eventIds = new Set(value.events.map((event) => event.event_id));
  const fragmentIds = new Set(value.fragments.map((fragment) => fragment.event_id));
  for (const eventId of eventIds) {
    if (fragmentIds.has(eventId)) {
      ctx.addIssue({ code: "custom", path: ["fragments"], message: "an event cannot be both complete and fragmented" });
    }
  }
  if (fragmentIds.size !== value.fragments.length) {
    ctx.addIssue({ code: "custom", path: ["fragments"], message: "fragment event ids must be unique per chunk" });
  }
}
export const sessionHistoryChunkFrameSchema = z.union([
  strictObject({ ...historyChunkBase, ...historyChunkTail }),
  strictObject({ ...historyChunkBase, ...historyChunkEos }),
  strictObject({ ...historyChunkBase, ...historyChunkNext }),
]).superRefine(validateHistoryChunk);

const protocolErrorFields = {
  type: z.literal("protocol_error"),
  in_reply_to: idSchema.optional(),
  code: z.enum([
    "protocol_upgrade_required", "invalid_message", "unsupported_type", "invalid_channel", "invalid_generation",
    "invalid_cursor", "reset_required", "too_large", "internal_error",
  ]),
  message: textSchema.min(1),
};
export const protocolErrorFrameSchema = z.union([
  strictObject({ ...protocol, ...protocolErrorFields, target_channel_id: channelIdSchema }),
  strictObject({ ...protocol, ...protocolErrorFields }),
]);
export const resetFrameSchema = strictObject({
  ...directResponse,
  type: z.literal("reset"),
  session_id: idSchema,
  history_generation: historyGenerationSchema,
  reason: z.enum(["generation_changed", "branch_changed", "session_replaced", "conflict", "invalid_cursor"]),
});
export const pongFrameSchema = strictObject({
  ...directResponse,
  type: z.literal("pong"),
  in_reply_to: idSchema,
});
export const cancelledFrameSchema = strictObject({
  ...directResponse,
  type: z.literal("cancelled"),
  in_reply_to: idSchema,
  target_id: idSchema,
});
export const actionOkFrameSchema = strictObject({
  ...directResponse,
  type: z.literal("action_ok"),
  in_reply_to: idSchema,
  action: actionNameSchema,
});
export const actionErrorFrameSchema = strictObject({
  ...directResponse,
  type: z.literal("action_error"),
  in_reply_to: idSchema,
  action: actionNameSchema,
  error: textSchema.min(1),
});
export const modelsListFrameSchema = strictObject({
  ...directResponse,
  type: z.literal("models_list"),
  in_reply_to: idSchema,
  models: z.array(wireModelSchema).max(MAX_ARRAY_ITEMS),
  current: wireModelSchema.optional(),
});
export const queuedMessageStateFrameSchema = strictObject({
  ...ownerBroadcast,
  type: z.literal("queued_message_state"),
  snapshot_id: idSchema,
  chunk_index: z.number().int().nonnegative().finite(),
  final: z.boolean(),
  items: z.array(queuedMessageItemSchema).max(MAX_ARRAY_ITEMS),
});
export const extensionUiRequestFrameSchema = z.union([
  strictObject({ ...protocol, type: z.literal("extension_ui_request"), ...directResponse, id: idSchema, method: z.literal("select"), title: textSchema, options: z.array(textSchema).max(MAX_ARRAY_ITEMS), ask: extensionUiRequestPayloadSchema.options[0].shape.ask.optional() }),
  strictObject({ ...protocol, type: z.literal("extension_ui_request"), ...directResponse, id: idSchema, method: z.literal("confirm"), title: textSchema, message: textSchema, ask: extensionUiRequestPayloadSchema.options[1].shape.ask.optional() }),
  strictObject({ ...protocol, type: z.literal("extension_ui_request"), ...directResponse, id: idSchema, method: z.literal("input"), title: textSchema, placeholder: textSchema.optional(), ask: extensionUiRequestPayloadSchema.options[2].shape.ask.optional() }),
  strictObject({ ...protocol, type: z.literal("extension_ui_request"), ...directResponse, id: idSchema, method: z.literal("editor"), title: textSchema, prefill: textSchema.optional(), ask: extensionUiRequestPayloadSchema.options[3].shape.ask.optional() }),
  strictObject({ ...protocol, type: z.literal("extension_ui_request"), ...directResponse, id: idSchema, method: z.literal("notify"), message: textSchema, notify_type: z.enum(["info", "warning", "error"]).optional() }),
]);
export const byeFrameSchema = strictObject({
  ...ownerBroadcast,
  type: z.literal("bye"),
  reason: byeReasonSchema,
});

export const clientFrameSchema = z.union([
  pairRequestFrameSchema,
  sessionHelloFrameSchema,
  userMessageFrameSchema,
  userMessageObservedFrameSchema,
  sessionSyncFrameSchema,
  pingFrameSchema,
  cancelFrameSchema,
  sessionNewFrameSchema,
  sessionCompactFrameSchema,
  modelSetFrameSchema,
  thinkingSetFrameSchema,
  listModelsFrameSchema,
  queuedMessageSetFrameSchema,
  queuedMessageClearFrameSchema,
  approveToolFrameSchema,
  extensionUiResponseFrameSchema,
]);
export const serverFrameSchema = z.union([
  pairOkFrameSchema,
  pairErrorFrameSchema,
  sessionReadyFrameSchema,
  userMessageStartedFrameSchema,
  userMessageStatusFrameSchema,
  timelineEventFrameSchema,
  timelinePartialFrameSchema,
  timelineEventFragmentFrameSchema,
  sessionHistoryChunkFrameSchema,
  protocolErrorFrameSchema,
  resetFrameSchema,
  pongFrameSchema,
  cancelledFrameSchema,
  actionOkFrameSchema,
  actionErrorFrameSchema,
  modelsListFrameSchema,
  queuedMessageStateFrameSchema,
  extensionUiRequestFrameSchema,
  byeFrameSchema,
]);

export type ClientFrame = z.infer<typeof clientFrameSchema>;
export type ServerFrame = z.infer<typeof serverFrameSchema>;
export type DirectClientFrame = Exclude<ClientFrame, { type: "pair_request" | "ping" }>;
export type OwnerBroadcastServerFrame = Extract<ServerFrame, { type: "timeline_event" | "timeline_partial" | "timeline_event_fragment" | "queued_message_state" | "bye" }>;

export const clientFrameTypes = new Set<string>(CLIENT_FRAME_TYPES);
export const serverFrameTypes = new Set<string>(SERVER_FRAME_TYPES);
export const ClientFrameTypes = clientFrameTypes;
export const ServerFrameTypes = serverFrameTypes;
export type { TimelineEvent, TimelinePartial };
