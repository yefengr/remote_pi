import { decodeBase64, decodeUtf8, encodeBase64, encodeUtf8 } from "./encoding";
import type { ControlFrame, ControlOutbound, EndpointInfo, EndpointMetadata, RelayFrame, RouteFrame } from "./types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson(value: unknown): unknown {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) return value;
  try { return JSON.parse(typeof value === "string" ? value : decodeUtf8(value)); } catch { return undefined; }
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function decodeMetadata(value: unknown): EndpointMetadata | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["kind", "name", "cwd", "pid", "started_at", "model", "thinking", "working"]) || (value.kind !== "daemon" && value.kind !== "interactive")) return undefined;
  const scalar = (key: string, type: "string" | "number" | "boolean") => value[key] === undefined || typeof value[key] === type;
  if (!scalar("name", "string") || !scalar("cwd", "string") || !scalar("pid", "number") || !scalar("started_at", "number") || !scalar("model", "string") || !scalar("thinking", "string") || !scalar("working", "boolean")) return undefined;
  return value as EndpointMetadata;
}

function decodeEndpoint(value: unknown): EndpointInfo | undefined {
  if (!isRecord(value) || !isUuid(value.endpoint_id) || !isUuid(value.runtime_instance_id)) return undefined;
  const metadata = decodeMetadata(value.metadata);
  return metadata ? { endpoint_id: value.endpoint_id, runtime_instance_id: value.runtime_instance_id, metadata } : undefined;
}

export function decodeRoute(value: unknown): RouteFrame | undefined {
  if (!isRecord(value) || value.type !== "route" || (value.purpose !== "pairing" && value.purpose !== "session") || !isId(value.device_id) || !isUuid(value.endpoint_id) || !isUuid(value.runtime_instance_id) || typeof value.ct !== "string") return undefined;
  const allowed = new Set(["type", "purpose", "device_id", "endpoint_id", "runtime_instance_id", "target_owner_id", "source_owner_id", "ct"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (value.target_owner_id !== undefined && !isId(value.target_owner_id)) return undefined;
  if (value.source_owner_id !== undefined && !isId(value.source_owner_id)) return undefined;
  return value as RouteFrame;
}

export function decodeControlFrame(value: unknown): ControlFrame | undefined {
  if (!isRecord(value) || typeof value.type !== "string" || !isId(value.device_id)) return undefined;
  if (value.type === "endpoints" && hasOnlyKeys(value, ["type", "device_id", "endpoints"]) && Array.isArray(value.endpoints)) {
    const endpoints = value.endpoints.map(decodeEndpoint);
    return endpoints.every((endpoint): endpoint is EndpointInfo => endpoint !== undefined) ? { type: "endpoints", device_id: value.device_id, endpoints } : undefined;
  }
  if ((value.type === "endpoint_announced" || value.type === "endpoint_updated") && hasOnlyKeys(value, ["type", "device_id", "endpoint_id", "runtime_instance_id", "metadata"]) && isUuid(value.endpoint_id) && isUuid(value.runtime_instance_id)) {
    const metadata = decodeMetadata(value.metadata);
    return metadata ? { type: value.type, device_id: value.device_id, endpoint_id: value.endpoint_id, runtime_instance_id: value.runtime_instance_id, metadata } : undefined;
  }
  if (value.type === "endpoint_ended" && hasOnlyKeys(value, ["type", "device_id", "endpoint_id", "runtime_instance_id"]) && isUuid(value.endpoint_id) && isUuid(value.runtime_instance_id)) return { type: "endpoint_ended", device_id: value.device_id, endpoint_id: value.endpoint_id, runtime_instance_id: value.runtime_instance_id };
  return undefined;
}

export function decodeRelayFrame(value: unknown): RelayFrame | undefined {
  const route = decodeRoute(value);
  if (route) return { kind: "route", route };
  const control = decodeControlFrame(value);
  return control ? { kind: "control", frame: control } : undefined;
}

export function encodeRoutePayload(payload: Uint8Array | string): string {
  return encodeBase64(typeof payload === "string" ? encodeUtf8(payload) : payload, "standard");
}

export function decodeRoutePayload(route: RouteFrame): Uint8Array | undefined {
  try { return decodeBase64(route.ct, "standard"); } catch { return undefined; }
}

export function encodeControlFrame(frame: ControlOutbound): string {
  return JSON.stringify(frame);
}

export function decodeChallenge(value: unknown): { type: "challenge"; nonce: string } | undefined {
  const parsed = parseJson(value);
  if (!isRecord(parsed) || !hasOnlyKeys(parsed, ["type", "nonce"]) || parsed.type !== "challenge" || typeof parsed.nonce !== "string") return undefined;
  try { decodeBase64(parsed.nonce, "standard"); } catch { return undefined; }
  return { type: "challenge", nonce: parsed.nonce };
}
