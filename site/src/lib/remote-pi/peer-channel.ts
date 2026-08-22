import { decodeBase64, decodeUtf8, normalizePeerId } from "./encoding";
import { decodeServerMessage, encodeOuterEnvelope } from "./protocol";
import type { RelayClient } from "./relay-client";
import type { ClientMessage, PairErrorMessage, PairOkMessage, ServerMessage } from "./types";

export interface PeerChannelOptions {
  relay: RelayClient;
  remotePeer: string;
  roomId?: string;
  onMessage?: (message: ServerMessage) => void;
  onPairOk?: (message: PairOkMessage) => void;
  onPairError?: (message: PairErrorMessage) => void;
  onMalformed?: (reason: string) => void;
}

/** Routes plaintext inner protocol messages for one remote peer and room. */
export class PeerChannel {
  private room: string;
  private readonly unsubscribe: () => void;
  private readonly onMessage?: (message: ServerMessage) => void;
  private readonly onPairOk?: (message: PairOkMessage) => void;
  private readonly onPairError?: (message: PairErrorMessage) => void;
  private readonly onMalformed?: (reason: string) => void;

  constructor(private readonly options: PeerChannelOptions) {
    this.room = options.roomId ?? "main";
    this.onMessage = options.onMessage;
    this.onPairOk = options.onPairOk;
    this.onPairError = options.onPairError;
    this.onMalformed = options.onMalformed;
    this.unsubscribe = options.relay.on("envelope", (envelope) => this.handleEnvelope(envelope));
  }

  get roomId(): string {
    return this.room;
  }

  setRoom(roomId: string): void {
    if (!roomId) throw new Error("Room id cannot be empty");
    this.room = roomId;
  }

  send(message: ClientMessage): boolean {
    return this.options.relay.sendEnvelope(encodeOuterEnvelope(this.options.remotePeer, message, this.room));
  }

  sendPairRequest(message: Extract<ClientMessage, { type: "pair_request" }>): boolean {
    return this.send(message);
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
    let message: ServerMessage | undefined;
    try {
      message = decodeServerMessage(JSON.parse(decodeUtf8(decodeBase64(envelope.ct))));
    } catch {
      this.onMalformed?.("Malformed peer envelope");
      return;
    }
    if (!message) {
      this.onMalformed?.("Unknown or invalid peer message");
      return;
    }
    if (message.type === "pair_ok") this.onPairOk?.(message);
    if (message.type === "pair_error") this.onPairError?.(message);
    this.onMessage?.(message);
  }
}
