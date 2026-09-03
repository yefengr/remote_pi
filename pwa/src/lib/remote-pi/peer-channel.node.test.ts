import { expect, test } from "vitest";
import { encodeBase64, encodeUtf8 } from "./encoding";
import { PeerChannel } from "./peer-channel";
import type { RelayClient } from "./relay-client";
import type { RouteFrame } from "./types";

const endpoint = {
  deviceId: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  endpointId: "11111111-1111-4111-8111-111111111111",
  runtimeInstanceId: "22222222-2222-4222-8222-222222222222",
};

class RelayMock {
  readonly ownerId = "owner";
  private listener: ((route: RouteFrame) => void) | null = null;

  on(_event: "route", listener: (route: RouteFrame) => void): () => void {
    this.listener = listener;
    return () => { this.listener = null; };
  }

  sendRoute(): boolean { return true; }
  emit(route: RouteFrame): void { this.listener?.(route); }
}

function route(purpose: "pairing" | "session", frame: unknown): RouteFrame {
  return {
    type: "route",
    purpose,
    device_id: endpoint.deviceId,
    endpoint_id: endpoint.endpointId,
    runtime_instance_id: endpoint.runtimeInstanceId,
    target_owner_id: "owner",
    ct: encodeBase64(encodeUtf8(JSON.stringify(frame)), "standard"),
  };
}

test("rejects pairing-purpose routes carrying session frames", () => {
  const relay = new RelayMock();
  const received: string[] = [];
  const channel = new PeerChannel({
    relay: relay as unknown as RelayClient,
    endpoint,
    channelId: "channel-1",
    onFrame: (frame) => received.push(frame.type),
  });
  const pong = {
    protocol_version: 2,
    type: "pong",
    target_channel_id: "channel-1",
    in_reply_to: "ping-1",
  };

  relay.emit(route("pairing", pong));
  expect(received).toEqual([]);
  relay.emit(route("session", pong));
  expect(received).toEqual(["pong"]);
  channel.close();
});
