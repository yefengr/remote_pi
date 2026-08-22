import type { Base64Variant, PeerEnvelope } from "./types";

function assertString(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new TypeError("Expected a base64 string");
}

function normalizeBase64(value: string): string {
  const compact = value.replace(/\s+/g, "");
  if (!compact || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact)) {
    throw new Error("Invalid base64");
  }
  const unpadded = compact.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) throw new Error("Invalid base64 length");
  return unpadded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (unpadded.length % 4)) % 4);
}

export function encodeBase64(bytes: Uint8Array, variant: Base64Variant = "standard"): string {
  if (typeof btoa === "function") {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const encoded = btoa(binary);
    return variant === "url" ? encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : encoded;
  }
  throw new Error("Browser base64 encoder is unavailable");
}

export function decodeBase64(value: string, variant?: Base64Variant): Uint8Array {
  assertString(value);
  const normalized = normalizeBase64(value);
  if (variant === "standard" && /[-_]/.test(value)) throw new Error("Expected standard base64");
  if (variant === "url" && /[+/]/.test(value)) throw new Error("Expected URL-safe base64");
  if (typeof atob !== "function") throw new Error("Browser base64 decoder is unavailable");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function toWebSocketUrl(value: string | URL): string {
  const url = new URL(value.toString());
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("Relay URL must use http(s) or ws(s)");
  return url.toString();
}

export function normalizePeerId(value: string): string {
  return encodeBase64(decodeBase64(value), "standard");
}

export function encodeEnvelope(peer: string, payload: Uint8Array | string, room?: string): PeerEnvelope {
  const bytes = typeof payload === "string" ? encodeUtf8(payload) : payload;
  return { peer: normalizePeerId(peer), ...(room ? { room } : {}), ct: encodeBase64(bytes, "standard") };
}

export function decodeEnvelope(value: unknown): { envelope: PeerEnvelope; payload: Uint8Array } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const frame = value as Record<string, unknown>;
  if (typeof frame.peer !== "string" || typeof frame.ct !== "string") return undefined;
  try {
    return {
      envelope: { peer: frame.peer, ...(typeof frame.room === "string" ? { room: frame.room } : {}), ct: frame.ct },
      payload: decodeBase64(frame.ct),
    };
  } catch {
    return undefined;
  }
}
