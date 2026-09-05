import type { PeerRecord, PeerWriteReceipt } from "../pairing/storage.js";
import type { QRSession, TokenReservation } from "../pairing/qr.js";
import type { ClientFrame, ServerFrame } from "../protocol/v2/index.js";
import type { RelayClient } from "../transport/relay_client.js";
import { V2PeerChannel, type HostRouteIdentity } from "../transport/peer_channel.js";

type PairRequest = Extract<ClientFrame, { type: "pair_request" }>;
type PairOk = Extract<ServerFrame, { type: "pair_ok" }>;

export interface PairingBinding {
  readonly channel: V2PeerChannel;
}

export interface PairingCoordinatorDependencies {
  readonly qrSession: QRSession;
  readonly routeIdentity: () => HostRouteIdentity;
  readonly isRelayCurrent: (relay: RelayClient) => boolean;
  readonly attachOwner: (relay: RelayClient, ownerId: string) => PairingBinding | null;
  readonly activeBinding: (ownerId: string) => PairingBinding | undefined;
  readonly addPeer: (record: PeerRecord) => Promise<PeerWriteReceipt>;
  readonly rollbackPeer: (receipt: PeerWriteReceipt) => Promise<unknown>;
  readonly updateEndpoint: (relay: RelayClient) => Promise<boolean>;
  readonly refreshCurrentEndpoint: () => Promise<boolean>;
  readonly buildPairOk: (frame: PairRequest) => PairOk;
}

type PairingAttempt = {
  readonly key: string;
  readonly ownerId: string;
  readonly relay: RelayClient;
  readonly binding: PairingBinding;
  readonly reservation: TokenReservation;
  readonly completion: Promise<ServerFrame | null>;
  readonly resolveCompletion: (frame: ServerFrame | null) => void;
};

/** Coordinates one-process pairing retries across storage and Relay lifecycles. */
export class PairingCoordinator {
  private readonly attempts = new Map<string, PairingAttempt>();

  constructor(private readonly deps: PairingCoordinatorDependencies) {}

  async handle(relay: RelayClient, ownerId: string, frame: PairRequest): Promise<void> {
    if (!this.deps.isRelayCurrent(relay)) return;
    const key = this.attemptKey(ownerId, frame.id);
    const pending = this.attempts.get(key);
    if (pending) {
      await pending.completion;
      return this.handle(relay, ownerId, frame);
    }

    const reservation = this.deps.qrSession.reserveToken<ServerFrame>(frame.token, ownerId, frame.id);
    if (reservation.status === "expired" || reservation.status === "consumed" || reservation.status === "unknown") {
      const code = reservation.status === "expired" ? "token_expired" : reservation.status === "consumed" ? "token_consumed" : "token_unknown";
      this.reject(relay, ownerId, frame, code, reservation.status === "consumed" ? "Pairing token is already in use" : "Pairing token is invalid or expired");
      return;
    }

    if (reservation.status === "committed") {
      const activeBinding = this.deps.activeBinding(ownerId);
      if (activeBinding) {
        activeBinding.channel.sendV2(reservation.completion);
        return;
      }
      const replayBinding = this.deps.attachOwner(relay, ownerId);
      replayBinding?.channel.sendV2(reservation.completion);
      return;
    }
    if (reservation.status !== "reserved") return;

    const binding = this.deps.attachOwner(relay, ownerId);
    if (!binding) {
      this.deps.qrSession.releaseToken(reservation.reservation);
      return;
    }

    let resolveCompletion!: (result: ServerFrame | null) => void;
    const completion = new Promise<ServerFrame | null>((resolve) => { resolveCompletion = resolve; });
    const attempt: PairingAttempt = {
      key,
      ownerId,
      relay,
      binding,
      reservation: reservation.reservation,
      completion,
      resolveCompletion,
    };
    this.attempts.set(key, attempt);
    void this.run(attempt, frame);
  }

  abandonInactive(): void {
    for (const attempt of [...this.attempts.values()]) {
      if (this.lifecycleIsCurrent(attempt)) continue;
      this.attempts.delete(attempt.key);
      this.deps.qrSession.releaseToken(attempt.reservation);
      attempt.resolveCompletion(null);
    }
  }

  private async run(attempt: PairingAttempt, frame: PairRequest): Promise<void> {
    let completion: ServerFrame | null = null;
    let receipt: PeerWriteReceipt | undefined;
    try {
      receipt = await this.deps.addPeer({ name: frame.device_name, remote_epk: attempt.ownerId, paired_at: new Date().toISOString() });
      if (!this.canCommit(attempt)) {
        await this.rollback(receipt);
        return;
      }

      // peers.json is durable authority, but do not confirm pairing while the
      // current Relay has explicitly rejected the ACL frame. A later retry of
      // the same request can safely repeat the idempotent write.
      const aclSent = await this.deps.updateEndpoint(attempt.relay);
      if (!aclSent || !this.canCommit(attempt)) {
        await this.rollback(receipt);
        return;
      }

      const pairOk = this.deps.buildPairOk(frame);
      if (!this.deps.qrSession.commitToken(attempt.reservation, pairOk)) {
        await this.rollback(receipt);
        return;
      }
      completion = pairOk;
      attempt.binding.channel.sendV2(pairOk);
    } catch {
      if (receipt) await this.rollback(receipt);
      if (this.lifecycleIsCurrent(attempt)) {
        this.sendError(attempt.binding.channel, frame, "internal_error", "Failed to persist pairing");
      }
    } finally {
      if (!completion) this.deps.qrSession.releaseToken(attempt.reservation);
      if (this.attempts.get(attempt.key) === attempt) this.attempts.delete(attempt.key);
      attempt.resolveCompletion(completion);
    }
  }

  private async rollback(receipt: PeerWriteReceipt): Promise<void> {
    try {
      await this.deps.rollbackPeer(receipt);
    } catch {
      // A failed compensation leaves peers.json authoritative.
    }
    // A new Relay may have announced the transient write while this old
    // attempt was pending. Always refresh whichever Relay is current now.
    try { await this.deps.refreshCurrentEndpoint(); } catch { /* reconnect owns recovery */ }
  }

  private lifecycleIsCurrent(attempt: PairingAttempt): boolean {
    return this.deps.isRelayCurrent(attempt.relay) && this.deps.activeBinding(attempt.ownerId) === attempt.binding;
  }

  private canCommit(attempt: PairingAttempt): boolean {
    return this.lifecycleIsCurrent(attempt) && this.deps.qrSession.isReservationCurrent(attempt.reservation);
  }

  private reject(relay: RelayClient, ownerId: string, frame: PairRequest, code: "token_expired" | "token_consumed" | "token_unknown", message: string): void {
    const channel = new V2PeerChannel(relay, ownerId, this.deps.routeIdentity(), () => undefined);
    this.sendError(channel, frame, code, message);
    channel.detach();
  }

  private sendError(channel: V2PeerChannel, frame: PairRequest, code: "token_expired" | "token_consumed" | "token_unknown" | "internal_error", message: string): void {
    channel.sendV2({ protocol_version: 2, type: "pair_error", in_reply_to: frame.id, code, message });
  }

  private attemptKey(ownerId: string, requestId: string): string {
    return `${ownerId}\u0000${requestId}`;
  }
}
