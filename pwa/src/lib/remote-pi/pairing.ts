import { decodeBase64, encodeBase64, toWebSocketUrl } from "./encoding";
import type { PairPayload } from "./types";
import type { ClientFrame } from "./protocol-v2/frames";

const TOKEN_BYTES = 16;
const DEVICE_ID_BYTES = 32;
const MAX_SESSION_NAME_LENGTH = 80;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Parses only the Plan 69 endpoint-aware pairing URI. */
export function parsePairUri(raw: string): PairPayload | undefined {
  try {
    const uri = new URL(raw);
    if (uri.protocol !== "remotepi:" || uri.hostname !== "pair" || uri.pathname !== "" || uri.hash || uri.username || uri.password || uri.port) return undefined;
    const allowed = new Set(["t", "epk", "n", "r", "ep", "rt"]);
    for (const key of uri.searchParams.keys()) if (!allowed.has(key) || uri.searchParams.getAll(key).length !== 1) return undefined;
    const token = requiredParam(uri, "t");
    const deviceId = requiredParam(uri, "epk");
    const sessionName = requiredParam(uri, "n");
    const endpointId = requiredParam(uri, "ep");
    const runtimeInstanceId = requiredParam(uri, "rt");
    if (!token || !deviceId || !sessionName || !endpointId || !runtimeInstanceId || sessionName.length > MAX_SESSION_NAME_LENGTH || !UUID_PATTERN.test(endpointId) || !UUID_PATTERN.test(runtimeInstanceId)) return undefined;
    const deviceIdBytes = decodeBase64(deviceId, "url");
    const tokenBytes = decodeBase64(token, "url");
    if (tokenBytes.length !== TOKEN_BYTES || deviceIdBytes.length !== DEVICE_ID_BYTES) return undefined;
    const relayUrl = optionalParam(uri, "r");
    return { token, deviceId, deviceIdBytes, endpointId, runtimeInstanceId, sessionName, ...(relayUrl ? { relayUrl } : {}) };
  } catch { return undefined; }
}

export function createPairRequest(token: string, deviceName: string, id: string): Extract<ClientFrame, { type: "pair_request" }> {
  if (!token || !deviceName || !id) throw new Error("Pair request requires token, device name, and id");
  return { protocol_version: 2, type: "pair_request", id, token, device_name: deviceName };
}
export function relayMismatch(qrRelayUrl: string | undefined, configuredRelayUrl: string): boolean {
  if (!qrRelayUrl) return false;
  try { return toWebSocketUrl(qrRelayUrl).replace(/\/$/, "") !== toWebSocketUrl(configuredRelayUrl).replace(/\/$/, ""); } catch { return true; }
}
export function normalizePairDeviceId(deviceId: string): string { return encodeBase64(decodeBase64(deviceId, "url"), "standard"); }
function requiredParam(uri: URL, name: string): string | undefined { const value = uri.searchParams.get(name); return value && value.length > 0 ? value : undefined; }
function optionalParam(uri: URL, name: string): string | undefined { const value = uri.searchParams.get(name); return value && value.length > 0 ? value : undefined; }
