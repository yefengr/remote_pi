import type { Base64Variant } from "./types";

function assertString(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new TypeError("Expected a base64 string");
}

function normalizeBase64(value: string): string {
  const compact = value.replace(/\s+/g, "");
  if (!compact || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact)) throw new Error("Invalid base64");
  const unpadded = compact.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) throw new Error("Invalid base64 length");
  return unpadded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (unpadded.length % 4)) % 4);
}

export function encodeBase64(bytes: Uint8Array, variant: Base64Variant = "standard"): string {
  if (typeof btoa !== "function") throw new Error("Browser base64 encoder is unavailable");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary);
  return variant === "url" ? encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : encoded;
}

export function decodeBase64(value: string, variant?: Base64Variant): Uint8Array {
  assertString(value);
  const normalized = normalizeBase64(value);
  if (variant === "standard" && /[-_]/.test(value)) throw new Error("Expected standard base64");
  if (variant === "url" && /[+/]/.test(value)) throw new Error("Expected URL-safe base64");
  if (typeof atob !== "function") throw new Error("Browser base64 decoder is unavailable");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = encodeUtf8(value);
  if (bytes.length <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return decodeUtf8(bytes.slice(0, end));
}

export function toWebSocketUrl(value: string | URL): string {
  const url = new URL(value.toString());
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("Relay URL must use http(s) or ws(s)");
  return url.toString();
}

/** Canonical device and owner identities are standard Ed25519 base64 values. */
export function normalizeDeviceId(value: string): string {
  return encodeBase64(decodeBase64(value), "standard");
}
