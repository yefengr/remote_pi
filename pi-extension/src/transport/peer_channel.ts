import type { ClientMessage, ServerMessage } from "../protocol/types.js";
import {
  decodeClientFrameV2,
  encodeServerFrameV2,
  type ClientFrame,
  type ServerFrame,
} from "../protocol/v2/index.js";
import type { RelayClient } from "./relay_client.js";

/** Sink for ServerMessage outbound to the remote app. */
export interface PeerChannel {
  send(msg: ServerMessage): void;
}

export interface V2Channel {
  getPeerId(): string;
  sendV2(msg: ServerFrame): void;
  detach(): void;
}

/**
 * Outer envelope shape forwarded by the relay.
 * { "peer": "<sender_peer_id>", "room"?: "<room_id>", "ct": "<base64 JSON inner>" }
 *
 * Post rollback (plano 06): `ct` is base64(JSON.stringify(inner)) — no cipher,
 * no MAC. Relay continues opaque (never JSON.parses ct).
 *
 * `room` (plano 17): identifies which Pi room sent the envelope. Lets the
 * relay multiplex N peers with the same Ed25519 pubkey but distinct cwds.
 * Optional for backward-compat with single-room relays.
 */
interface OuterEnvelope {
  peer: string;
  room?: string;
  ct: string;
}

/**
 * Plaintext PeerChannel backed by a RelayClient WebSocket.
 *
 * Usage (after pair_request handshake completes):
 *   const channel = new PlainPeerChannel(relay, appPeerId, myRoomId, onMsg)
 *   channel.send(serverMessage)          // base64-encodes JSON, routes via relay
 *   // incoming relay messages destined for appPeerId are auto-decoded
 *   // and delivered via onMessage callback
 *
 * `myRoomId` is the *local* Pi's room id — sent on every outbound envelope
 * so the app can correlate which Pi sent it (multi-pi support, plano 17).
 */
export class V2PeerChannel implements V2Channel {
  private readonly unsubscribe: () => void;

  constructor(
    private readonly relay: RelayClient,
    private readonly remotePeerId: string,
    private readonly onMessage: (msg: ClientFrame) => void,
  ) {
    const listener = (line: string) => this.onLine(line);
    relay.on("message", listener);
    this.unsubscribe = () => relay.off("message", listener);
  }

  getPeerId(): string {
    return this.remotePeerId;
  }

  sendV2(msg: ServerFrame): void {
    let ct: string;
    try {
      ct = Buffer.from(encodeServerFrameV2(msg)).toString("base64");
      this.relay.send(JSON.stringify({ peer: this.remotePeerId, ct } satisfies OuterEnvelope));
    } catch {
      // Reconnect plus authoritative history recovers dropped formal events.
    }
  }

  detach(): void {
    this.unsubscribe();
  }

  private onLine(line: string): void {
    let outer: OuterEnvelope;
    try {
      outer = JSON.parse(line) as OuterEnvelope;
    } catch {
      return;
    }
    if (outer.peer !== this.remotePeerId || !outer.ct) return;
    try {
      const plaintext = Buffer.from(outer.ct, "base64").toString("utf8");
      this.onMessage(decodeClientFrameV2(plaintext));
    } catch {
      // Strict v2 boundary. A parseable legacy/invalid request receives an upgrade
      // error; malformed bytes without an id cannot be safely targeted.
      try {
        const raw = JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8")) as Record<string, unknown>;
        const id = typeof raw.id === "string" ? raw.id : undefined;
        const channelId = typeof raw.channel_id === "string" ? raw.channel_id : undefined;
        if (id) {
          this.sendV2({
            protocol_version: 2,
            type: "protocol_error",
            ...(channelId ? { target_channel_id: channelId } : {}),
            in_reply_to: id,
            code: "protocol_upgrade_required",
            message: "Protocol v2 is required",
          });
        }
      } catch {
        // Ignore malformed outer payloads.
      }
    }
  }
}

/** @deprecated Protocol v1 test helper. Production uses V2PeerChannel. */
export class PlainPeerChannel implements PeerChannel {
  private readonly _unsubscribe: () => void;

  constructor(
    private readonly relay: RelayClient,
    private readonly remotePeerId: string,
    /**
     * This Pi's room id. Currently NOT injected in the outer envelope
     * (defensive — relay/app not yet ready). Kept in the constructor for
     * forward-compat so callers don't need to change again when we re-enable.
     */
    myRoomId: string | undefined,
    private readonly onMessage: (msg: ClientMessage) => void,
    /** Called when this specific peer connection is considered lost. */
    _onDisconnect?: () => void,
  ) {
    const listener = (line: string) => this._onLine(line);
    relay.on("message", listener);
    this._unsubscribe = () => relay.off("message", listener);
    void _onDisconnect;
    void myRoomId;  // intentionally unused — see send() comment
  }

  // ── PeerChannel interface ──────────────────────────────────────────────────

  /** Authenticated Owner peer id used as a server-derived sender reference. */
  getPeerId(): string {
    return this.remotePeerId;
  }

  send(msg: ServerMessage): void {
    const ct = Buffer.from(JSON.stringify(msg)).toString("base64");
    // NOTE: `room` removed from the outer envelope until relay (W1.A) + app
    // (W1.C) accept the field. Multi-Pi multiplexing already works via
    // `room_id`/`room_meta` in the WS-level `hello` — outer routing stays by
    // `peer` alone. Re-add the field once downstream is ready.
    const outer: OuterEnvelope = { peer: this.remotePeerId, ct };
    // Best-effort delivery. The relay WS can be mid-reconnect (idle/NAT drop, or
    // a session_new/session-replacement teardown) when we push a server→app frame
    // — notably the action_ok/action_error ack a handler emits right after
    // newSession. `relay.send` throws "relay: not connected" in that window; since
    // this runs inside an async SDK event callback, letting it propagate becomes an
    // uncaughtException that kills the whole pi process. The relay auto-reconnects
    // and the app re-syncs via session_sync, so a dropped frame is recoverable — a
    // crash is not. Mirrors RelayClient.sendControl's no-op-when-closed policy.
    try {
      this.relay.send(JSON.stringify(outer));
    } catch {
      /* relay down — drop this frame; reconnect + session_sync will recover */
    }
  }

  /** Detaches from relay (does not close the relay itself). */
  detach(): void {
    this._unsubscribe();
  }

  // ── Incoming line from relay ────────────────────────────────────────────────

  private _onLine(line: string): void {
    let outer: OuterEnvelope;
    try {
      outer = JSON.parse(line) as OuterEnvelope;
    } catch {
      return; // malformed line
    }

    if (outer.peer !== this.remotePeerId) return;
    if (!outer.ct) return;

    let plaintext: string;
    try {
      plaintext = Buffer.from(outer.ct, "base64").toString("utf8");
    } catch {
      return;
    }

    let msg: unknown;
    try {
      msg = JSON.parse(plaintext);
    } catch {
      return;
    }

    if (
      !msg ||
      typeof msg !== "object" ||
      typeof (msg as Record<string, unknown>).type !== "string"
    ) {
      return;
    }

    this.onMessage(msg as ClientMessage);
  }
}
