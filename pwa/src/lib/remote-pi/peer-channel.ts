import { decodeUtf8 } from "./encoding";
import { decodeRoutePayload } from "./protocol";
import { decodeServerFrameV2, encodeClientFrameV2 } from "./protocol-v2";
import type { ClientFrame, ServerFrame } from "./protocol-v2/frames";
import type { RelayClient } from "./relay-client";

export type EndpointRouteIdentity = { deviceId: string; endpointId: string; runtimeInstanceId: string };
export interface PeerChannelOptions {
  relay: RelayClient;
  endpoint: EndpointRouteIdentity;
  channelId?: string;
  onFrame?: (frame: ServerFrame) => void;
  onPairOk?: (frame: Extract<ServerFrame, { type: "pair_ok" }>) => void;
  onPairError?: (frame: Extract<ServerFrame, { type: "pair_error" }>) => void;
  onMalformed?: (reason: string) => void;
}
function makeId(): string { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

/** Strict Owner endpoint route adapter. Every inbound route must target this Owner and runtime. */
export class PeerChannel {
  private readonly channel: string;
  private readonly unsubscribe: () => void;
  constructor(private readonly options: PeerChannelOptions) {
    this.channel = options.channelId ?? makeId();
    this.unsubscribe = options.relay.on("route", (route) => this.handleRoute(route));
  }
  get channelId(): string { return this.channel; }
  get endpoint(): EndpointRouteIdentity { return this.options.endpoint; }
  send(frame: ClientFrame): boolean {
    try {
      const payload = encodeClientFrameV2(frame);
      return this.options.relay.sendRoute({
        type: "route",
        purpose: frame.type === "pair_request" ? "pairing" : "session",
        device_id: this.options.endpoint.deviceId,
        endpoint_id: this.options.endpoint.endpointId,
        runtime_instance_id: this.options.endpoint.runtimeInstanceId,
        ct: btoa(String.fromCharCode(...payload)),
      });
    } catch (error) {
      this.options.onMalformed?.(error instanceof Error ? error.message : "Invalid client frame");
      return false;
    }
  }
  sendPairRequest(frame: Extract<ClientFrame, { type: "pair_request" }>): boolean { return this.send(frame); }
  close(): void { this.unsubscribe(); }
  private handleRoute(route: { type: "route"; purpose: "pairing" | "session"; device_id: string; endpoint_id: string; runtime_instance_id: string; target_owner_id?: string; source_owner_id?: string; ct: string }): void {
    const endpoint = this.options.endpoint;
    if (route.device_id !== endpoint.deviceId || route.endpoint_id !== endpoint.endpointId || route.runtime_instance_id !== endpoint.runtimeInstanceId || route.target_owner_id !== this.options.relay.ownerId || route.source_owner_id !== undefined) return;
    const payload = decodeRoutePayload(route);
    if (!payload) return this.options.onMalformed?.("Malformed route payload");
    let frame: ServerFrame;
    try { frame = decodeServerFrameV2(JSON.parse(decodeUtf8(payload))); } catch (error) { this.options.onMalformed?.(error instanceof Error ? error.message : "Malformed Protocol v2 route"); return; }
    const expectedPurpose = frame.type === "pair_ok" || frame.type === "pair_error" ? "pairing" : "session";
    if (route.purpose !== expectedPurpose) return;
    if (frame.type === "pair_ok") this.options.onPairOk?.(frame);
    if (frame.type === "pair_error") this.options.onPairError?.(frame);
    if ("target_channel_id" in frame && frame.target_channel_id !== this.channel) return;
    this.options.onFrame?.(frame);
  }
}
