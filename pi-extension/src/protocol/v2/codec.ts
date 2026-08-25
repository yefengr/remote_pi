import { z } from "zod";
import {
  ClientFrameSchema,
  ClientFrameTypes,
  MAX_FRAME_BYTES,
  MAX_FRAGMENT_DECODE_BYTES,
  MAX_HISTORY_CHUNK_BYTES,
  MAX_WINDOW_DECODE_BYTES,
  MarkerSchemaV2,
  ServerFrameSchema,
  ServerFrameTypes,
  HistoryFragmentSchema,
  SessionHistoryChunkSchema,
  TimelineEventFragmentSchema,
  TimelineEventSchema,
  TimelinePartialSchema,
} from "./schemas.js";
import type {
  ClientFrame,
  JsonValue,
  MarkerV2,
  ServerFrame,
  TimelineEvent,
  TimelinePartial,
} from "./schemas.js";

export type DecodeErrorCode = "invalid" | "unsupported" | "version" | "schema" | "size" | "direction";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export function getUtf8ByteLengthV2(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("value is not JSON serializable");
    return byteLength(encoded);
  } catch (error) {
    throw new DecodeError("invalid", "value is not JSON serializable", { cause: error });
  }
}

function parseRaw(raw: unknown, maxBytes = MAX_WINDOW_DECODE_BYTES): { value: unknown; bytes: number } {
  if (typeof raw === "string") {
    const bytes = byteLength(raw);
    if (bytes > maxBytes) {
      throw new DecodeError("size", `raw value exceeds ${maxBytes} bytes`);
    }
    try {
      return { value: JSON.parse(raw), bytes };
    } catch (error) {
      throw new DecodeError("invalid", "raw string is not valid JSON", { cause: error });
    }
  }
  if (raw instanceof Uint8Array) {
    if (raw.byteLength > maxBytes) {
      throw new DecodeError("size", `raw value exceeds ${maxBytes} bytes`);
    }
    try {
      return { value: JSON.parse(textDecoder.decode(raw)), bytes: raw.byteLength };
    } catch (error) {
      throw new DecodeError("invalid", "raw bytes are not valid UTF-8 JSON", { cause: error });
    }
  }
  if (isRecord(raw)) {
    const bytes = getUtf8ByteLengthV2(raw);
    if (bytes > maxBytes) {
      throw new DecodeError("size", `raw value exceeds ${maxBytes} bytes`);
    }
    return { value: raw, bytes };
  }
  throw new DecodeError("invalid", "raw frame must be an object, JSON string, or Uint8Array");
}

function schemaMessage(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
}

function checkProtocolVersion(value: Record<string, unknown>): void {
  if (value.protocol_version !== 2) {
    throw new DecodeError("version", "protocol_version must be 2");
  }
}

function checkFrameBytes(value: Record<string, unknown>, bytes: number): void {
  if (bytes > MAX_FRAME_BYTES) {
    throw new DecodeError("size", `${String(value.type)} exceeds ${MAX_FRAME_BYTES} encoded UTF-8 bytes`);
  }
}

function parseFrame(raw: unknown, direction: "client" | "server"): ClientFrame | ServerFrame {
  const { value, bytes } = parseRaw(raw, MAX_FRAME_BYTES);
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new DecodeError("invalid", "frame must contain a string type");
  }

  const clientKnown = ClientFrameTypes.has(value.type as ClientFrame["type"]);
  const serverKnown = ServerFrameTypes.has(value.type as ServerFrame["type"]);
  if (!clientKnown && !serverKnown) throw new DecodeError("unsupported", `unknown frame type: ${value.type}`);
  if (direction === "client" && !clientKnown) throw new DecodeError("direction", `${value.type} is a server frame`);
  if (direction === "server" && !serverKnown) throw new DecodeError("direction", `${value.type} is a client frame`);

  checkProtocolVersion(value);
  const result = direction === "client" ? ClientFrameSchema.safeParse(value) : ServerFrameSchema.safeParse(value);
  if (!result.success) throw new DecodeError("schema", schemaMessage(result.error), { cause: result.error });
  checkFrameBytes(value, bytes);
  if (value.type === "timeline_event_fragment") validateFragmentSizeV2(value);
  if (value.type === "session_history_chunk") validateHistoryChunkSizeV2(value);
  return result.data;
}

export function decodeClientFrameV2(raw: unknown): ClientFrame {
  return parseFrame(raw, "client") as ClientFrame;
}

export function decodeServerFrameV2(raw: unknown): ServerFrame {
  return parseFrame(raw, "server") as ServerFrame;
}

function encodeFrame(frame: ClientFrame | ServerFrame, direction: "client" | "server"): string {
  const parsed = parseFrame(frame, direction);
  const encoded = JSON.stringify(parsed);
  if (encoded === undefined) throw new DecodeError("invalid", "frame is not JSON serializable");
  return encoded;
}

export function encodeClientFrameV2(frame: ClientFrame): string {
  return encodeFrame(frame, "client");
}

export function encodeServerFrameV2(frame: ServerFrame): string {
  return encodeFrame(frame, "server");
}

function decodeBase64Bytes(value: string): Uint8Array {
  try {
    return Uint8Array.from(Buffer.from(value, "base64"));
  } catch (error) {
    throw new DecodeError("schema", "data_base64 is not valid base64", { cause: error });
  }
}

export function validateFragmentSizeV2(fragment: unknown): number {
  const realtimeResult = TimelineEventFragmentSchema.safeParse(fragment);
  const historyResult = HistoryFragmentSchema.safeParse(fragment);
  if (!realtimeResult.success && !historyResult.success) {
    throw new DecodeError("schema", schemaMessage(realtimeResult.error), { cause: realtimeResult.error });
  }
  const dataBase64 = realtimeResult.success
    ? realtimeResult.data.data_base64
    : historyResult.success
      ? historyResult.data.data_base64
      : undefined;
  if (dataBase64 === undefined) throw new DecodeError("schema", "fragment data is missing");
  const bytes = decodeBase64Bytes(dataBase64).byteLength;
  if (bytes > MAX_FRAGMENT_DECODE_BYTES) {
    throw new DecodeError("size", `fragment exceeds ${MAX_FRAGMENT_DECODE_BYTES} decoded bytes`);
  }
  return bytes;
}

export function validateHistoryChunkSizeV2(chunk: unknown): number {
  const result = SessionHistoryChunkSchema.safeParse(chunk);
  if (!result.success) throw new DecodeError("schema", schemaMessage(result.error), { cause: result.error });
  const parsed = result.data;
  const bytes = getUtf8ByteLengthV2(parsed);
  if (bytes > MAX_HISTORY_CHUNK_BYTES) {
    throw new DecodeError("size", `history chunk exceeds ${MAX_HISTORY_CHUNK_BYTES} encoded UTF-8 bytes`);
  }
  for (const fragment of parsed.fragments) validateFragmentSizeV2(fragment);
  return bytes;
}

export function validateWindowSizeV2(events: readonly unknown[]): number {
  let total = 0;
  for (const event of events) {
    const result = TimelineEventSchema.safeParse(event);
    if (!result.success) throw new DecodeError("schema", schemaMessage(result.error), { cause: result.error });
    total += getUtf8ByteLengthV2(result.data);
    if (total > MAX_WINDOW_DECODE_BYTES) {
      throw new DecodeError("size", `decoded window exceeds ${MAX_WINDOW_DECODE_BYTES} bytes`);
    }
  }
  return total;
}

export function validateEncodedSizeV2(value: unknown, maxBytes = MAX_WINDOW_DECODE_BYTES): number {
  const bytes = getUtf8ByteLengthV2(value);
  if (bytes > maxBytes) throw new DecodeError("size", `encoded value exceeds ${maxBytes} bytes`);
  return bytes;
}

export function parseTimelineEventV2(raw: unknown): TimelineEvent {
  const { value } = parseRaw(raw);
  const result = TimelineEventSchema.safeParse(value);
  if (!result.success) throw new DecodeError("schema", schemaMessage(result.error), { cause: result.error });
  const event = result.data;
  validateEncodedSizeV2(event, MAX_WINDOW_DECODE_BYTES);
  return event;
}

export function parseTimelinePartialV2(raw: unknown): TimelinePartial {
  const { value } = parseRaw(raw);
  const result = TimelinePartialSchema.safeParse(value);
  if (!result.success) throw new DecodeError("schema", schemaMessage(result.error), { cause: result.error });
  validateEncodedSizeV2(result.data, MAX_HISTORY_CHUNK_BYTES);
  return result.data;
}

export function parseMarkerV2(raw: unknown): MarkerV2 {
  const { value } = parseRaw(raw);
  const result = MarkerSchemaV2.safeParse(value);
  if (!result.success) throw new DecodeError("schema", schemaMessage(result.error), { cause: result.error });
  validateEncodedSizeV2(result.data, MAX_FRAGMENT_DECODE_BYTES);
  return result.data;
}

// These aliases keep validation available without exposing scanner or production wiring.
export { HistoryFragmentSchema, TimelineEventFragmentSchema, SessionHistoryChunkSchema } from "./schemas.js";
export const validateTimelineEventFragmentV2 = validateFragmentSizeV2;
export const validateSessionHistoryChunkV2 = validateHistoryChunkSizeV2;
export const validateTimelineWindowV2 = validateWindowSizeV2;
export type JsonValueV2 = JsonValue;
