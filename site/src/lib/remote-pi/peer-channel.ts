import { decodeBase64, decodeUtf8, encodeEnvelope, normalizePeerId } from "./encoding";
import { decodeServerFrameV2, encodeClientFrameV2 } from "./protocol-v2";
import type { ClientFrame, ServerFrame } from "./protocol-v2/frames";
import type { RelayClient } from "./relay-client";

export interface PeerChannelOptions {
  relay: RelayClient;
  remotePeer: string;
  roomId?: string;
  channelId?: string;
  onFrame?: (frame: ServerFrame) => void;
  onPairOk?: (frame: Extract<ServerFrame, { type: "pair_ok" }>) => void;
  onPairError?: (frame: Extract<ServerFrame, { type: "pair_error" }>) => void;
  onMalformed?: (reason: string) => void;
}

function makeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Routes strict Protocol v2 frames for one remote peer and room. */
export class PeerChannel {
  private room: string;
  private readonly channel: string;
  private readonly unsubscribe: () => void;
  private readonly onFrame?: (frame: ServerFrame) => void;
  private readonly onPairOk?: (frame: Extract<ServerFrame, { type: "pair_ok" }>) => void;
  private readonly onPairError?: (frame: Extract<ServerFrame, { type: "pair_error" }>) => void;
  private readonly onMalformed?: (reason: string) => void;

  constructor(private readonly options: PeerChannelOptions) {
    this.room = options.roomId ?? "main";
    this.channel = options.channelId ?? makeId();
    this.onFrame = options.onFrame;
    this.onPairOk = options.onPairOk;
    this.onPairError = options.onPairError;
    this.onMalformed = options.onMalformed;
    this.unsubscribe = options.relay.on("envelope", (envelope) => this.handleEnvelope(envelope));
  }

  get roomId(): string {
    return this.room;
  }

  get channelId(): string {
    return this.channel;
  }

  setRoom(roomId: string): void {
    if (!roomId) throw new Error("Room id cannot be empty");
    this.room = roomId;
  }

  send(frame: ClientFrame): boolean {
    let payload: Uint8Array;
    try {
      payload = encodeClientFrameV2(frame);
    } catch (error) {
      this.onMalformed?.(error instanceof Error ? error.message : "Invalid client frame");
      return false;
    }
    return this.options.relay.sendEnvelope(encodeEnvelope(this.options.remotePeer, payload, this.room));
  }

  sendPairRequest(frame: Extract<ClientFrame, { type: "pair_request" }>): boolean {
    return this.send(frame);
  }

  close(): void {
    this.unsubscribe();
  }

  private handleEnvelope(envelope: { peer: string; room?: string; ct: string }): void {
    try {
      if (normalizePeerId(envelope.peer) !== normalizePeerId(this.options.remotePeer)) return;
    } catch {
      return;
    }
    if (envelope.room && envelope.room !== this.room) return;
    let frame: ServerFrame;
    try {
      frame = decodeServerFrameV2(JSON.parse(decodeUtf8(decodeBase64(envelope.ct))));
    } catch (error) {
      this.onMalformed?.(error instanceof Error ? error.message : "Malformed Protocol v2 peer envelope");
      return;
    }
    if (frame.type === "pair_ok") this.onPairOk?.(frame);
    if (frame.type === "pair_error") this.onPairError?.(frame);
    if (this.isTargetedElsewhere(frame)) return;
    this.onFrame?.(frame);
  }

  private isTargetedElsewhere(frame: ServerFrame): boolean {
    if (!("target_channel_id" in frame)) return false;
    return frame.target_channel_id !== this.channel;
  }
}
