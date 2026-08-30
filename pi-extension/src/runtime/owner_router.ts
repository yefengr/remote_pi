import { decodeClientFrameV2, type ClientFrame } from "../protocol/v2/index.js";
import type { RelayClient } from "../transport/relay_client.js";
import { parseIncomingRoute, type HostRouteIdentity } from "../transport/peer_channel.js";

export interface OwnerRouterDependencies {
  isCurrent(relay: RelayClient): boolean;
  routeIdentity(): HostRouteIdentity;
  hasOwner(ownerId: string): boolean;
  findKnownOwner(ownerId: string): Promise<boolean>;
  attachOwner(relay: RelayClient, ownerId: string): void;
  routeClientFrame(ownerId: string, frame: ClientFrame): void;
  handlePairRequest(relay: RelayClient, ownerId: string, frame: Extract<ClientFrame, { type: "pair_request" }>): Promise<void>;
}

/** Routes unbound Owner frames without duplicating bound peer-channel traffic. */
export function installOwnerRouter(relay: RelayClient, deps: OwnerRouterDependencies): () => void {
  const listener = (line: string): void => {
    if (!deps.isCurrent(relay)) return;
    const route = parseIncomingRoute(line, deps.routeIdentity());
    if (!route?.source_owner_id) return;
    let frame: ClientFrame;
    try { frame = decodeClientFrameV2(Buffer.from(route.ct, "base64").toString("utf8")); }
    catch { return; }
    if ((frame.type === "pair_request") !== (route.purpose === "pairing")) return;
    const ownerId = route.source_owner_id;
    if (frame.type === "pair_request") {
      void deps.handlePairRequest(relay, ownerId, frame);
      return;
    }
    if (deps.hasOwner(ownerId)) return;
    void deps.findKnownOwner(ownerId).then((known) => {
      if (!known || !deps.isCurrent(relay)) return;
      deps.attachOwner(relay, ownerId);
      deps.routeClientFrame(ownerId, frame);
    });
  };
  relay.on("message", listener);
  return () => relay.off("message", listener);
}
