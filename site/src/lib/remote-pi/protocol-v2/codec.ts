import { z } from "zod";
import {
  clientFrameSchema,
  clientFrameTypes,
  serverFrameSchema,
  serverFrameTypes,
  sessionHistoryChunkFrameSchema,
  timelineEventFragmentFrameSchema,
} from "./frames.js";
import {
  historyFragmentSchema,
  timelineEventFragmentSchema,
  timelineEventSchema,
  timelinePartialSchema,
} from "./schema.js";
import {
  MAX_FRAGMENT_BYTES,
  MAX_FRAME_BYTES,
  MAX_HISTORY_CHUNK_BYTES,
  MAX_WINDOW_BYTES,
} from "./schema.js";
import type { ClientFrame, ServerFrame } from "./frames.js";
import type { TimelineEvent, TimelinePartial } from "./schema.js";

export const DECODE_ERROR_CODES = {
  invalid: "invalid",
  unsupported: "unsupported",
  version: "version",
  schema: "schema",
  size: "size",
  direction: "direction",
} as const;
export type DecodeErrorCode = (typeof DECODE_ERROR_CODES)[keyof typeof DECODE_ERROR_CODES];

export class DecodeError extends Error {
  public readonly name = "DecodeError";

  constructor(
    public readonly code: DecodeErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeJson(value: unknown): Uint8Array {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("value is not JSON serializable");
    return textEncoder.encode(encoded);
  } catch (error) {
    if (error instanceof DecodeError) throw error;
    throw new DecodeError("invalid", "value is not JSON serializable", { cause: error });
  }
}

export function getUtf8ByteLengthV2(value: unknown): number {
  return encodeJson(value).byteLength;
}

function parseRaw(raw: unknown, maxBytes = MAX_WINDOW_BYTES): { value: unknown; bytes: number } {
  if (typeof raw === "string") {
    const bytes = textEncoder.encode(raw).byteLength;
    if (bytes > maxBytes) throw new DecodeError("size", `raw value exceeds ${maxBytes} bytes`);
    try {
      return { value: JSON.parse(raw), bytes };
    } catch (error) {
      throw new DecodeError("invalid", "raw string is not valid JSON", { cause: error });
    }
  }

  if (raw instanceof Uint8Array) {
    if (raw.byteLength > maxBytes) throw new DecodeError("size", `raw value exceeds ${maxBytes} bytes`);
    try {
      return { value: JSON.parse(textDecoder.decode(raw)), bytes: raw.byteLength };
    } catch (error) {
      throw new DecodeError("invalid", "raw bytes are not valid UTF-8 JSON", { cause: error });
    }
  }

  if (isRecord(raw)) {
    const bytes = getUtf8ByteLengthV2(raw);
    if (bytes > maxBytes) throw new DecodeError("size", `raw value exceeds ${maxBytes} bytes`);
    return { value: raw, bytes };
  }

  throw new DecodeError("invalid", "raw frame must be an object, JSON string, or Uint8Array");
}

function schemaMessage(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
}

function assertByteLimit(value: Record<string, unknown>, bytes: number, limit = MAX_FRAME_BYTES): void {
  if (bytes > limit) {
    throw new DecodeError("size", `${String(value.type)} exceeds ${limit} encoded UTF-8 bytes`);
  }
}

function assertVersion(value: Record<string, unknown>): void {
  if (value.protocol_version !== 2) {
    throw new DecodeError("version", "protocol_version must be 2");
  }
}

function assertDirection(type: string, direction: "client" | "server"): void {
  const knownClient = clientFrameTypes.has(type);
  const knownServer = serverFrameTypes.has(type);
  if (!knownClient && !knownServer) {
    throw new DecodeError("unsupported", `unsupported frame type: ${type}`);
  }
  if ((direction === "client" && !knownClient) || (direction === "server" && !knownServer)) {
    throw new DecodeError("direction", `${type} is not a ${direction} frame`);
  }
}

function frameType(value: unknown): string {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new DecodeError("invalid", "frame must contain a string type");
  }
  return value.type;
}

function parseFrame<T>(raw: unknown, direction: "client" | "server", schema: z.ZodType<T>): T {
  const parsed = parseRaw(raw, MAX_FRAME_BYTES);
  const type = frameType(parsed.value);
  assertDirection(type, direction);
  assertVersion(parsed.value as Record<string, unknown>);
  const result = schema.safeParse(parsed.value);
  if (!result.success) {
    throw new DecodeError("schema", schemaMessage(result.error), { cause: result.error });
  }
  assertByteLimit(parsed.value as Record<string, unknown>, parsed.bytes);
  if (type === "timeline_event_fragment") validateFragmentSizeV2(parsed.value);
  if (type === "session_history_chunk") validateHistoryChunkSizeV2(parsed.value);
  return result.data;
}

export function decodeClientFrameV2(raw: unknown): ClientFrame {
  return parseFrame(raw, "client", clientFrameSchema);
}

export function decodeServerFrameV2(raw: unknown): ServerFrame {
  return parseFrame(raw, "server", serverFrameSchema);
}

function encodeFrame(frame: ClientFrame | ServerFrame, direction: "client" | "server"): Uint8Array {
  const parsed = direction === "client"
    ? parseFrame(frame, direction, clientFrameSchema)
    : parseFrame(frame, direction, serverFrameSchema);
  const encoded = encodeJson(parsed);
  assertByteLimit(isRecord(parsed) ? parsed : { type: "frame" }, encoded.byteLength);
  return encoded;
}

export function encodeClientFrameV2(frame: ClientFrame): Uint8Array {
  return encodeFrame(frame, "client");
}

export function encodeServerFrameV2(frame: ServerFrame): Uint8Array {
  return encodeFrame(frame, "server");
}

function decodeBase64Bytes(value: string): Uint8Array {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch (error) {
    throw new DecodeError("schema", "data_base64 is not valid base64", { cause: error });
  }
}

export function validateFragmentSizeV2(fragment: unknown): number {
  const realtimeFrameResult = timelineEventFragmentFrameSchema.safeParse(fragment);
  const realtimeResult = timelineEventFragmentSchema.safeParse(fragment);
  const historyResult = historyFragmentSchema.safeParse(fragment);
  if (!realtimeFrameResult.success && !realtimeResult.success && !historyResult.success) {
    throw new DecodeError("schema", schemaMessage(realtimeFrameResult.error), { cause: realtimeFrameResult.error });
  }
  const dataBase64 = realtimeFrameResult.success
    ? realtimeFrameResult.data.data_base64
    : realtimeResult.success
      ? realtimeResult.data.data_base64
      : historyResult.success
        ? historyResult.data.data_base64
        : undefined;
  if (dataBase64 === undefined) throw new DecodeError("schema", "fragment data is missing");
  const bytes = decodeBase64Bytes(dataBase64).byteLength;
  if (bytes > MAX_FRAGMENT_BYTES) {
    throw new DecodeError("size", `fragment exceeds ${MAX_FRAGMENT_BYTES} decoded bytes`);
  }
  return bytes;
}

export function validateHistoryChunkSizeV2(chunk: unknown): number {
  const result = sessionHistoryChunkFrameSchema.safeParse(chunk);
  if (!result.success) throw new DecodeError("schema", schemaMessage(result.error), { cause: result.error });
  const bytes = getUtf8ByteLengthV2(result.data);
  if (bytes > MAX_HISTORY_CHUNK_BYTES) {
    throw new DecodeError("size", `history chunk exceeds ${MAX_HISTORY_CHUNK_BYTES} encoded UTF-8 bytes`);
  }
  for (const fragment of result.data.fragments) validateFragmentSizeV2(fragment);
  return bytes;
}

export function validateWindowSizeV2(events: readonly unknown[]): number {
  let total = 0;
  for (const event of events) {
    const result = timelineEventSchema.safeParse(event);
    if (!result.success) throw new DecodeError("schema", schemaMessage(result.error), { cause: result.error });
    total += getUtf8ByteLengthV2(result.data);
    if (total > MAX_WINDOW_BYTES) {
      throw new DecodeError("size", `decoded window exceeds ${MAX_WINDOW_BYTES} bytes`);
    }
  }
  return total;
}

export function validateEncodedSizeV2(value: unknown, maxBytes = MAX_WINDOW_BYTES): number {
  const bytes = getUtf8ByteLengthV2(value);
  if (bytes > maxBytes) throw new DecodeError("size", `encoded value exceeds ${maxBytes} bytes`);
  return bytes;
}

export function parseTimelineEventV2(raw: unknown): TimelineEvent {
  const { value } = parseRaw(raw);
  const result = timelineEventSchema.safeParse(value);
  if (!result.success) throw new DecodeError("schema", schemaMessage(result.error), { cause: result.error });
  validateEncodedSizeV2(result.data, MAX_WINDOW_BYTES);
  return result.data;
}

export function parseTimelinePartialV2(raw: unknown): TimelinePartial {
  const { value } = parseRaw(raw);
  const result = timelinePartialSchema.safeParse(value);
  if (!result.success) throw new DecodeError("schema", schemaMessage(result.error), { cause: result.error });
  validateEncodedSizeV2(result.data, MAX_HISTORY_CHUNK_BYTES);
  return result.data;
}

export function validateFrameSizeV2(raw: unknown, maxBytes = MAX_FRAME_BYTES): number {
  return parseRaw(raw, maxBytes).bytes;
}

export const validateTimelineEventFragmentV2 = validateFragmentSizeV2;
export const validateSessionHistoryChunkV2 = validateHistoryChunkSizeV2;
export const validateTimelineWindowV2 = validateWindowSizeV2;
export const validateFrameSize = validateFrameSizeV2;
export const validateFragmentSize = validateFragmentSizeV2;
export const validateSessionHistoryChunkSize = validateHistoryChunkSizeV2;
export const validateWindowSize = validateWindowSizeV2;
