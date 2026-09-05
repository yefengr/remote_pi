import {
  decodeClientFrameV2,
  encodeServerFrameV2,
  type ClientFrame,
  type ServerFrame,
} from "../protocol/v2/index.js";
import type { RelayClient } from "./relay_client.js";

export type RoutePurpose = "pairing" | "session";

export type RouteFrame = {
  type: "route";
  purpose: RoutePurpose;
  device_id: string;
  endpoint_id: string;
  runtime_instance_id: string;
  target_owner_id?: string;
  source_owner_id?: string;
  ct: string;
};

export type HostRouteIdentity = {
  deviceId: string;
  endpointId: string;
  runtimeInstanceId: string;
};

export interface V2Channel {
  getPeerId(): string;
  sendV2(msg: ServerFrame): void;
  detach(): void;
}

/**
 * A Host-side protocol-v2 channel for one authorized Owner. The relay
 * authenticates and injects `source_owner_id` for Owner-to-Host routes; this
 * channel only accepts routes for its immutable endpoint identity and owner.
 */
export class V2PeerChannel implements V2Channel {
  private readonly unsubscribe: () => void;

  constructor(
    private readonly relay: RelayClient,
    private readonly ownerId: string,
    private readonly host: HostRouteIdentity,
    private readonly onMessage: (msg: ClientFrame) => void,
  ) {
    const listener = (line: string) => this.onLine(line);
    relay.on("message", listener);
    this.unsubscribe = () => relay.off("message", listener);
  }

  getPeerId(): string {
    return this.ownerId;
  }

  sendV2(msg: ServerFrame): boolean {
    try {
      const ct = Buffer.from(encodeServerFrameV2(msg)).toString("base64");
      this.relay.send(JSON.stringify({
        type: "route",
        purpose: msg.type === "pair_ok" || msg.type === "pair_error" ? "pairing" : "session",
        device_id: this.host.deviceId,
        endpoint_id: this.host.endpointId,
        runtime_instance_id: this.host.runtimeInstanceId,
        target_owner_id: this.ownerId,
        ct,
      } satisfies RouteFrame));
      return true;
    } catch {
      // Formal history recovers messages lost while the relay reconnects.
      return false;
    }
  }

  detach(): void {
    this.unsubscribe();
  }

  private onLine(line: string): void {
    const outer = parseIncomingRoute(line, this.host, this.ownerId);
    if (!outer) return;
    try {
      const frame = decodeClientFrameV2(Buffer.from(outer.ct, "base64").toString("utf8"));
      // Pair requests have one owner in installOwnerRouter. Letting an active
      // session binding process retries would duplicate or misroute replies.
      if (frame.type === "pair_request") return;
      const expectedPurpose: RoutePurpose = "session";
      if (outer.purpose !== expectedPurpose) return;
      this.onMessage(frame);
    } catch {
      this.sendUpgradeRequired(outer.ct);
    }
  }

  private sendUpgradeRequired(ct: string): void {
    try {
      const raw = JSON.parse(Buffer.from(ct, "base64").toString("utf8")) as Record<string, unknown>;
      const id = typeof raw.id === "string" ? raw.id : undefined;
      const channelId = typeof raw.channel_id === "string" ? raw.channel_id : undefined;
      if (!id) return;
      this.sendV2({
        protocol_version: 2,
        type: "protocol_error",
        ...(channelId ? { target_channel_id: channelId } : {}),
        in_reply_to: id,
        code: "protocol_upgrade_required",
        message: "Protocol v2 is required",
      });
    } catch {
      // Invalid bytes without a request id are not targetable.
    }
  }
}

export function parseIncomingRoute(
  line: string,
  host: HostRouteIdentity,
  ownerId?: string,
): RouteFrame | null {
  let route: RouteFrame;
  try {
    route = JSON.parse(line) as RouteFrame;
  } catch {
    return null;
  }
  if (
    route.type !== "route" ||
    (route.purpose !== "pairing" && route.purpose !== "session") ||
    typeof route.ct !== "string" ||
    route.device_id !== host.deviceId ||
    route.endpoint_id !== host.endpointId ||
    route.runtime_instance_id !== host.runtimeInstanceId ||
    typeof route.source_owner_id !== "string" ||
    route.target_owner_id !== undefined
  ) {
    return null;
  }
  if (ownerId !== undefined && route.source_owner_id !== ownerId) return null;
  return route;
}

export function sendRoute(
  relay: RelayClient,
  host: HostRouteIdentity,
  ownerId: string,
  purpose: RoutePurpose,
  ct: string,
): void {
  relay.send(JSON.stringify({
    type: "route",
    purpose,
    device_id: host.deviceId,
    endpoint_id: host.endpointId,
    runtime_instance_id: host.runtimeInstanceId,
    target_owner_id: ownerId,
    ct,
  } satisfies RouteFrame));
}
