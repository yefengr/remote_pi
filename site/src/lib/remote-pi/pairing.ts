import { decodeBase64, encodeBase64, toWebSocketUrl } from "./encoding";
import type { PairPayload } from "./types";
import type { ClientFrame } from "./protocol-v2/frames";

const TOKEN_BYTES = 16;
const EPK_BYTES = 32;
const MAX_SESSION_NAME_LENGTH = 80;

export function parsePairUri(raw: string): PairPayload | undefined {
  try {
    const uri = new URL(raw);
    if (uri.protocol !== "remotepi:" || uri.hostname !== "pair" || uri.pathname !== "" || uri.hash || uri.username || uri.password || uri.port) return undefined;
    const allowed = new Set(["t", "epk", "n", "r", "rm"]);
    for (const key of uri.searchParams.keys()) if (!allowed.has(key)) return undefined;
    if (["t", "epk", "n", "r", "rm"].some((key) => uri.searchParams.getAll(key).length > 1)) return undefined;
    const token = requiredParam(uri, "t");
    const epk = requiredParam(uri, "epk");
    const sessionName = requiredParam(uri, "n");
    if (!token || !epk || !sessionName || sessionName.length > MAX_SESSION_NAME_LENGTH) return undefined;
    const epkBytes = decodeBase64(epk, "url");
    const tokenBytes = decodeBase64(token, "url");
    if (tokenBytes.length !== TOKEN_BYTES || epkBytes.length !== EPK_BYTES) return undefined;
    const relayUrl = optionalParam(uri, "r");
    const roomId = optionalParam(uri, "rm");
    return { token, epk, epkBytes, sessionName, ...(relayUrl ? { relayUrl } : {}), ...(roomId ? { roomId } : {}) };
  } catch {
    return undefined;
  }
}

export function createPairRequest(token: string, deviceName: string, id: string): Extract<ClientFrame, { type: "pair_request" }> {
  if (!token || !deviceName || !id) throw new Error("Pair request requires token, device name, and id");
  return { protocol_version: 2, type: "pair_request", id, token, device_name: deviceName };
}

export function relayMismatch(qrRelayUrl: string | undefined, configuredRelayUrl: string): boolean {
  if (!qrRelayUrl) return false;
  try {
    return toWebSocketUrl(qrRelayUrl).replace(/\/$/, "") !== toWebSocketUrl(configuredRelayUrl).replace(/\/$/, "");
  } catch {
    return true;
  }
}

export function normalizePairPeerId(epk: string): string {
  return encodeBase64(decodeBase64(epk, "url"), "standard");
}

function requiredParam(uri: URL, name: string): string | undefined {
  const value = uri.searchParams.get(name);
  return value && value.length > 0 ? value : undefined;
}

function optionalParam(uri: URL, name: string): string | undefined {
  const value = uri.searchParams.get(name);
  return value && value.length > 0 ? value : undefined;
}
