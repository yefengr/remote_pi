export type Base64Variant = "standard" | "url";

export interface OwnerKeyPair {
  /** Ed25519 seed. Keep this value in memory/IndexedDB only; never log it. */
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface PairPayload {
  token: string;
  epk: string;
  epkBytes: Uint8Array;
  sessionName: string;
  relayUrl?: string;
  roomId?: string;
}

export interface PairRequest {
  type: "pair_request";
  id: string;
  token: string;
  device_name: string;
}

export interface WireImage {
  data: string;
  mime: string;
}

export type StreamingBehavior = "steer";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ActionName = "session_new" | "session_compact" | "model_set" | "thinking_set";
export type ByeReason = "peer_stop" | "session_replaced" | "shutdown";
export type ErrorCode = string;
export type PairErrorCode = "token_expired" | "token_consumed" | "token_unknown" | "internal_error" | (string & {});

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface HarnessInfo {
  name: string;
  version: string;
}

export interface WireModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  context_window: number;
  vision: boolean;
}

export interface QueuedMessageItem {
  id: string;
  text: string;
  images?: WireImage[];
  sender_ref?: string;
  editable: boolean;
  created_at: number;
}

export type AskQuestionWireType = "single" | "multi" | "preview";
export type ExtensionUiMethod = "select" | "confirm" | "input" | "editor" | "notify";

export interface AskOptionWire {
  value: string;
  label: string;
  description?: string;
  preview?: string;
  freeform?: boolean;
}

export interface AskQuestionWire {
  id: string;
  label: string;
  prompt: string;
  type: AskQuestionWireType;
  required: boolean;
  presentedType?: AskQuestionWireType;
  requestedType?: AskQuestionWireType;
  options: AskOptionWire[];
}

export interface AskEnrichmentWire {
  flow_id: string;
  tool_call_id: string | null;
  source: string;
  title: string | null;
  questions: AskQuestionWire[];
}

export type AskResponseEnrichmentWire =
  | {
      flow_id: string;
      kind: "answer";
      mode?: "submit" | "elaborate";
      answers: Record<string, AskAnswerWire>;
    }
  | { flow_id: string; kind: "cancel" };

export interface AskAnswerWire {
  values?: string[];
  customText?: string;
  note?: string;
  optionNotes?: Record<string, string>;
}

export type ExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string; ask?: AskResponseEnrichmentWire }
  | { type: "extension_ui_response"; id: string; confirmed: boolean; ask?: AskResponseEnrichmentWire }
  | { type: "extension_ui_response"; id: string; cancelled: true; ask?: AskResponseEnrichmentWire }
  | { type: "extension_ui_response"; id: string; ask: AskResponseEnrichmentWire };

export type ClientMessage =
  | PairRequest
  | { type: "user_message"; id: string; text: string; images?: WireImage[]; streaming_behavior?: StreamingBehavior }
  | { type: "queued_message_set"; id: string; text: string; images?: WireImage[] }
  | { type: "queued_message_clear"; id: string; target_id?: string }
  | { type: "approve_tool"; id: string; tool_call_id: string; decision: "allow" | "deny" }
  | { type: "cancel"; id: string; target_id: string }
  | { type: "ping"; id: string }
  | { type: "session_sync"; id: string; limit?: number }
  | { type: "session_new"; id: string }
  | { type: "session_compact"; id: string }
  | { type: "model_set"; id: string; provider: string; model_id: string }
  | { type: "thinking_set"; id: string; level: ThinkingLevel }
  | { type: "list_models"; id: string }
  | ExtensionUiResponse;

export type SessionHistoryEvent =
  | { ts: number; type: "user_input"; id: string; text: string; images?: WireImage[] }
  | { ts: number; type: "tool_request"; tool_call_id: string; tool: string; args: Record<string, unknown> }
  | { ts: number; type: "tool_result"; tool_call_id: string; result?: unknown; error?: string }
  | { ts: number; type: "agent_message"; in_reply_to: string; text: string; usage?: Usage }
  | { ts: number; type: "compaction"; summary: string; tokens_before: number };

export type ServerMessage =
  | {
      type: "pair_ok";
      in_reply_to: string;
      session_name: string;
      session_started_at: number;
      room_id: string;
      harness?: HarnessInfo;
      hostname?: string;
    }
  | { type: "pair_error"; in_reply_to: string; code: PairErrorCode; message: string }
  | { type: "user_input" | "user_message"; id: string; text: string; images?: WireImage[]; streaming_behavior?: StreamingBehavior }
  | { type: "queued_message_state"; id?: string; text?: string; images?: WireImage[]; items?: QueuedMessageItem[] }
  | { type: "steer_consumed"; id: string }
  | { type: "agent_chunk"; in_reply_to: string; delta: string }
  | { type: "agent_done"; in_reply_to: string; usage?: Usage }
  | { type: "agent_message"; in_reply_to: string; text: string; usage?: Usage }
  | { type: "compaction"; summary: string; tokens_before: number; ts?: number }
  | { type: "tool_request"; tool_call_id: string; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool_call_id: string; result?: unknown; error?: string }
  | { type: "error"; in_reply_to?: string; code: ErrorCode; message: string }
  | { type: "cancelled"; in_reply_to: string; target_id: string }
  | { type: "pong"; in_reply_to: string }
  | { type: "bye"; reason: ByeReason }
  | {
      type: "session_history";
      in_reply_to: string;
      session_started_at: number;
      events: SessionHistoryEvent[];
      eos: boolean;
      truncated: boolean;
    }
  | { type: "action_ok"; in_reply_to: string; action: ActionName }
  | { type: "action_error"; in_reply_to: string; action: ActionName; error: string }
  | { type: "models_list"; in_reply_to: string; models: WireModel[]; current?: WireModel }
  | ExtensionUiRequest;

export type ExtensionUiRequest =
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; ask?: AskEnrichmentWire }
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; ask?: AskEnrichmentWire }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; ask?: AskEnrichmentWire }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string; ask?: AskEnrichmentWire }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notify_type?: string };

export type PairOkMessage = Extract<ServerMessage, { type: "pair_ok" }>;
export type PairErrorMessage = Extract<ServerMessage, { type: "pair_error" }>;

export interface PeerEnvelope {
  peer: string;
  room?: string;
  ct: string;
}

export interface ChallengeFrame {
  type: "challenge";
  nonce: string;
}

export interface HelloFrame {
  type: "hello";
  pubkey: string;
  room_id: string;
}

export interface AuthFrame {
  type: "auth";
  sig: string;
}

export interface PeerOnlineControl {
  type: "peer_online";
  peer: string;
}
export interface PeerOfflineControl {
  type: "peer_offline";
  peer: string;
  since_ts: number;
}
export interface PresenceControl {
  type: "presence";
  states: Array<{ peer: string; online: boolean; since_ts?: number | null }>;
}
export interface RoomAnnouncedControl {
  type: "room_announced";
  peer: string;
  room_id: string;
  name?: string | null;
  cwd?: string | null;
  started_at: number;
  model?: string | null;
  thinking?: ThinkingLevel | string | null;
  working?: boolean;
}
export interface RoomEndedControl {
  type: "room_ended";
  peer: string;
  room_id: string;
  since_ts: number;
}
export interface RoomsControl {
  type: "rooms";
  peer: string;
  rooms: Array<{
    room_id: string;
    name?: string | null;
    cwd?: string | null;
    started_at: number;
    model?: string | null;
    thinking?: ThinkingLevel | string | null;
    working?: boolean;
  }>;
}
export interface RoomMetaUpdatedControl {
  type: "room_meta_updated";
  peer: string;
  room_id: string;
  meta?: { model?: string | null; thinking?: string | null; working?: boolean };
}

export type ControlFrame =
  | PeerOnlineControl
  | PeerOfflineControl
  | PresenceControl
  | RoomAnnouncedControl
  | RoomEndedControl
  | RoomsControl
  | RoomMetaUpdatedControl;

export type ControlOutbound =
  | { type: "subscribe_presence" | "unsubscribe_presence" | "presence_check" | "subscribe_rooms" | "unsubscribe_rooms" | "rooms_check"; peers: string[] }
  | { type: "room_meta_update"; room_id?: string; meta: Record<string, unknown> };

export type RelayFrame =
  | { kind: "envelope"; envelope: PeerEnvelope }
  | { kind: "control"; frame: ControlFrame };

export type RelayClientState = "idle" | "connecting" | "authenticating" | "open" | "closing" | "closed";
