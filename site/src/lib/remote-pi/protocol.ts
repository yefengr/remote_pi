import { decodeBase64, decodeEnvelope, decodeUtf8, encodeEnvelope, encodeUtf8 } from "./encoding";
import type {
  ClientMessage,
  ControlFrame,
  ControlOutbound,
  PeerEnvelope,
  RelayFrame,
  ServerMessage,
} from "./types";

const SERVER_TYPES = new Set([
  "pair_ok", "pair_error", "user_input", "user_message", "queued_message_state", "steer_consumed",
  "agent_chunk", "agent_done", "agent_message", "compaction", "tool_request", "tool_result", "error",
  "cancelled", "pong", "bye", "session_history", "action_ok", "action_error", "models_list", "extension_ui_request",
]);

const CONTROL_TYPES = new Set([
  "peer_online", "peer_offline", "presence", "room_announced", "room_ended", "rooms", "room_meta_updated",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function encodeClientMessage(message: ClientMessage): Uint8Array {
  return encodeUtf8(JSON.stringify(message));
}

export function decodeClientMessage(value: unknown): ClientMessage | undefined {
  const parsed = parseJson(value);
  return isKnownMessage(parsed, false) ? parsed as ClientMessage : undefined;
}

export function decodeServerMessage(value: unknown): ServerMessage | undefined {
  const parsed = parseJson(value);
  return isKnownMessage(parsed, true) ? parsed as ServerMessage : undefined;
}

export function decodeInnerMessage(value: Uint8Array | string, direction: "client" | "server" = "server"): ClientMessage | ServerMessage | undefined {
  const parsed = parseJson(value);
  if (!isRecord(parsed)) return undefined;
  return direction === "server" ? decodeServerMessage(parsed) : decodeClientMessage(parsed);
}

export function encodeOuterEnvelope(peer: string, message: ClientMessage | ServerMessage, room?: string): PeerEnvelope {
  return encodeEnvelope(peer, encodeUtf8(JSON.stringify(message)), room);
}

export function decodeOuterEnvelope(value: unknown): { envelope: PeerEnvelope; message: ServerMessage | undefined } | undefined {
  const decoded = decodeEnvelope(value);
  if (!decoded) return undefined;
  return { envelope: decoded.envelope, message: decodeServerMessage(decoded.payload) };
}

export function decodeControlFrame(value: unknown): ControlFrame | undefined {
  if (!isRecord(value) || typeof value.type !== "string" || !CONTROL_TYPES.has(value.type)) return undefined;
  if (value.type === "peer_online" && typeof value.peer === "string") return value as unknown as ControlFrame;
  if (value.type === "peer_offline" && typeof value.peer === "string" && typeof value.since_ts === "number") return value as unknown as ControlFrame;
  if (value.type === "presence" && Array.isArray(value.states)) return value as unknown as ControlFrame;
  if (value.type === "room_announced" && typeof value.peer === "string" && typeof value.room_id === "string" && typeof value.started_at === "number") return value as unknown as ControlFrame;
  if (value.type === "room_ended" && typeof value.peer === "string" && typeof value.room_id === "string" && typeof value.since_ts === "number") return value as unknown as ControlFrame;
  if (value.type === "rooms" && typeof value.peer === "string" && Array.isArray(value.rooms)) return value as unknown as ControlFrame;
  if (value.type === "room_meta_updated" && typeof value.peer === "string" && typeof value.room_id === "string") return value as unknown as ControlFrame;
  return undefined;
}

export function decodeRelayFrame(value: unknown): RelayFrame | undefined {
  const decoded = decodeEnvelope(value);
  if (decoded) return { kind: "envelope", envelope: decoded.envelope };
  const control = decodeControlFrame(value);
  return control ? { kind: "control", frame: control } : undefined;
}

export function encodeControlFrame(frame: ControlOutbound): string {
  return JSON.stringify(frame);
}

export function parseJson(value: unknown): unknown {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) return value;
  try {
    return JSON.parse(typeof value === "string" ? value : decodeUtf8(value));
  } catch {
    return undefined;
  }
}

export function decodeChallenge(value: unknown): { type: "challenge"; nonce: string } | undefined {
  const parsed = parseJson(value);
  if (!isRecord(parsed) || parsed.type !== "challenge" || typeof parsed.nonce !== "string") return undefined;
  try {
    decodeBase64(parsed.nonce);
  } catch {
    return undefined;
  }
  return { type: "challenge", nonce: parsed.nonce };
}

function isKnownMessage(value: unknown, server: boolean): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  return (server ? SERVER_TYPES : new Set(["pair_request", "user_message", "queued_message_set", "queued_message_clear", "approve_tool", "cancel", "ping", "session_sync", "session_new", "session_compact", "model_set", "thinking_set", "list_models", "extension_ui_response"])).has(value.type);
}
