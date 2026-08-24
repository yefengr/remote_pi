import { decodeBase64, encodeBase64 } from "../remote-pi/encoding";
import type { PeerChannel } from "../remote-pi/peer-channel";
import type { RelayClient } from "../remote-pi/relay-client";
import type { PwaMessageRecord, PwaRoomRecord } from "./db";

export type ConnectionContext = {
  generation: number;
  peerId: string;
  peerEpk: string;
  roomId: string;
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

export function mergeMessages(base: PwaMessageRecord[], preferred: PwaMessageRecord[]): PwaMessageRecord[] {
  return Array.from(new Map([...base, ...preferred].map((message) => [message.id, message])).values())
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function mergeRooms(base: PwaRoomRecord[], preferred: PwaRoomRecord[]): PwaRoomRecord[] {
  return Array.from(new Map([...base, ...preferred].map((room) => [room.id, room])).values())
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

export function markStreamingMessagesInterrupted(messages: PwaMessageRecord[], peerEpk: string, roomId: string): PwaMessageRecord[] {
  return messages.map((message) => message.peerEpk === peerEpk && message.roomId === roomId && message.status === "streaming"
    ? { ...message, status: "interrupted" as const }
    : message);
}
