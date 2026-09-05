import { describe, expect, test, vi } from "vitest";
import type { RelayClient } from "./relay_client.js";
import { V2PeerChannel, parseIncomingRoute } from "./peer_channel.js";
import { decodeServerFrameV2 } from "../protocol/v2/index.js";

const host = {
  deviceId: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  endpointId: "11111111-1111-4111-8111-111111111111",
  runtimeInstanceId: "22222222-2222-4222-8222-222222222222",
};

class RelayMock {
  listeners = new Set<(line: string) => void>();
  sent: string[] = [];
  failSend = false;
  on(_event: string, listener: (line: string) => void): void { this.listeners.add(listener); }
  off(_event: string, listener: (line: string) => void): void { this.listeners.delete(listener); }
  send(line: string): void { if (this.failSend) throw new Error("send failed"); this.sent.push(line); }
  emit(line: string): void { for (const listener of this.listeners) listener(line); }
}

function line(ownerId: string, inner: unknown, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "route",
    purpose: "session",
    device_id: host.deviceId,
    endpoint_id: host.endpointId,
    runtime_instance_id: host.runtimeInstanceId,
    source_owner_id: ownerId,
    ct: Buffer.from(JSON.stringify(inner)).toString("base64"),
    ...overrides,
  });
}

describe("V2PeerChannel", () => {
  test("strictly accepts relay-injected source_owner_id on the matching endpoint", () => {
    const relay = new RelayMock();
    const received = vi.fn();
    const channel = new V2PeerChannel(relay as unknown as RelayClient, "owner", host, received);
    relay.emit(line("other", { protocol_version: 2, type: "session_hello", id: "h", channel_id: "c" }));
    relay.emit(line("owner", { protocol_version: 2, type: "session_hello", id: "h", channel_id: "c" }, { target_owner_id: "owner" }));
    relay.emit(line("owner", { protocol_version: 2, type: "session_hello", id: "h", channel_id: "c" }, { endpoint_id: "33333333-3333-4333-8333-333333333333" }));
    relay.emit(line("owner", { type: "session_hello", id: "h", channel_id: "c" }));
    relay.emit(line("owner", { protocol_version: 2, type: "session_hello", id: "pairing-bypass", channel_id: "c" }, { purpose: "pairing" }));
    relay.emit(line("owner", { protocol_version: 2, type: "pair_request", id: "pair-retry", token: "token", device_name: "browser" }, { purpose: "pairing" }));
    relay.emit(line("owner", { protocol_version: 2, type: "session_hello", id: "h", channel_id: "c" }));
    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ id: "h" }));
    channel.detach();
    expect(relay.listeners).toHaveLength(0);
  });

  test("sends only target_owner_id for Host-to-Owner routes", () => {
    const relay = new RelayMock();
    const channel = new V2PeerChannel(relay as unknown as RelayClient, "owner", host, () => undefined);
    channel.sendV2({
      protocol_version: 2,
      type: "session_ready",
      in_reply_to: "h",
      target_channel_id: "c",
      session_id: "s",
      history_generation: "g",
      self_sender_ref: "owner",
    });
    const outer = JSON.parse(relay.sent[0]!) as Record<string, unknown>;
    expect(outer).toMatchObject({
      type: "route",
      purpose: "session",
      device_id: host.deviceId,
      endpoint_id: host.endpointId,
      runtime_instance_id: host.runtimeInstanceId,
      target_owner_id: "owner",
    });
    expect(outer).not.toHaveProperty("source_owner_id");
    expect(decodeServerFrameV2(Buffer.from(outer.ct as string, "base64").toString("utf8"))).toMatchObject({ type: "session_ready" });
  });

  test("reports whether a route was handed to the Relay", () => {
    const relay = new RelayMock();
    const channel = new V2PeerChannel(relay as unknown as RelayClient, "owner", host, () => undefined);
    const frame = { protocol_version: 2 as const, type: "pair_error" as const, in_reply_to: "pair", code: "internal_error" as const, message: "failed" };
    expect(channel.sendV2(frame)).toBe(true);
    relay.failSend = true;
    expect(channel.sendV2(frame)).toBe(false);
  });

  test("rejects routes that lack Relay-provided source identity", () => {
    expect(parseIncomingRoute(JSON.stringify({
      type: "route",
      purpose: "pairing",
      device_id: host.deviceId,
      endpoint_id: host.endpointId,
      runtime_instance_id: host.runtimeInstanceId,
      ct: "e30=",
    }), host)).toBeNull();
  });
});
