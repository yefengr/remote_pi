export type Base64Variant = "standard" | "url";

export interface OwnerKeyPair {
  /** Ed25519 seed. Keep this value in memory/IndexedDB only; never log it. */
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface PairPayload {
  token: string;
  deviceId: string;
  deviceIdBytes: Uint8Array;
  endpointId: string;
  runtimeInstanceId: string;
  sessionName: string;
  relayUrl?: string;
}

export interface WireImage {
  data: string;
  mime: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface WireModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  context_window: number;
  vision: boolean;
}

export type EndpointMetadata = {
  kind: "daemon" | "interactive";
  name?: string | null;
  cwd?: string | null;
  pid?: number | null;
  started_at?: number | null;
  model?: string | null;
  thinking?: string | null;
  working?: boolean | null;
};

export type EndpointInfo = {
  endpoint_id: string;
  runtime_instance_id: string;
  metadata: EndpointMetadata;
};

export type RoutePurpose = "pairing" | "session";
export type RouteFrame = {
  type: "route";
  purpose: RoutePurpose;
  device_id: string;
  endpoint_id: string;
  runtime_instance_id: string;
  target_owner_id?: string;
  source_owner_id?: string;
  ct: string;
};

export type EndpointsControl = { type: "endpoints"; device_id: string; endpoints: EndpointInfo[] };
export type EndpointAnnouncedControl = { type: "endpoint_announced"; device_id: string; endpoint_id: string; runtime_instance_id: string; metadata: EndpointMetadata };
export type EndpointUpdatedControl = { type: "endpoint_updated"; device_id: string; endpoint_id: string; runtime_instance_id: string; metadata: EndpointMetadata };
export type EndpointEndedControl = { type: "endpoint_ended"; device_id: string; endpoint_id: string; runtime_instance_id: string };
export type ControlFrame = EndpointsControl | EndpointAnnouncedControl | EndpointUpdatedControl | EndpointEndedControl;
export type ControlOutbound = { type: "subscribe_endpoints"; device_ids: string[] };
export type RelayFrame = { kind: "route"; route: RouteFrame } | { kind: "control"; frame: ControlFrame };
export type RelayClientState = "idle" | "connecting" | "authenticating" | "open" | "closing" | "closed";
