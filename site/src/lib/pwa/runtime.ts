import { decodeBase64, encodeBase64 } from "../remote-pi/encoding";
import type { PeerChannel } from "../remote-pi/peer-channel";
import type { RelayClient } from "../remote-pi/relay-client";
import type { PwaEndpointRecord } from "./db";

export type ConnectionContext = {
  generation: number;
  deviceId: string;
  endpointId: string;
  runtimeInstanceId: string;
  channel: PeerChannel;
  relay: RelayClient;
};

export function browserName(): string {
  if (typeof navigator === "undefined") return "Browser";
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return "iPhone browser";
  if (/Android/i.test(navigator.userAgent)) return "Android browser";
  return "Browser";
}

export function toStoredKey(key: Uint8Array): string {
  return encodeBase64(key, "url");
}

export function fromStoredKey(value: string): Uint8Array {
  return decodeBase64(value, "url");
}

export function assertBrowserCapabilities(): void {
  if (typeof window !== "undefined" && !window.isSecureContext) throw new Error("secure_context_required");
  if (typeof globalThis.crypto?.getRandomValues !== "function" || !globalThis.crypto.subtle) throw new Error("web_crypto_unavailable");
  if (typeof indexedDB === "undefined") throw new Error("indexeddb_unavailable");
}

export function migrateLegacyDefaultRelay(
  value: string | undefined,
  legacyDefault: string,
  currentDefault: string,
): string {
  return !value || value === legacyDefault ? currentDefault : value;
}

export function mergeEndpoints(base: PwaEndpointRecord[], preferred: PwaEndpointRecord[]): PwaEndpointRecord[] {
  return Array.from(new Map([...base, ...preferred].map((endpoint) => [endpoint.id, endpoint])).values())
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

/** Reject a previously observed runtime after a newer runtime took its slot. */
export function acceptEndpointRuntime(
  history: Map<string, Set<string>>,
  current: PwaEndpointRecord | undefined,
  next: PwaEndpointRecord,
): boolean {
  const known = history.get(next.id) ?? new Set<string>();
  if (current && !known.has(current.runtimeInstanceId)) known.add(current.runtimeInstanceId);
  const latest = [...known].at(-1);
  history.set(next.id, known);
  if (known.has(next.runtimeInstanceId)) return latest === next.runtimeInstanceId;
  known.add(next.runtimeInstanceId);
  return true;
}
