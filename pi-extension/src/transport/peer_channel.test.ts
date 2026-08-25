import { describe, expect, test, vi } from "vitest";
import type { RelayClient } from "./relay_client.js";
import { V2PeerChannel } from "./peer_channel.js";
import { decodeServerFrameV2 } from "../protocol/v2/index.js";

class RelayMock {
  listeners = new Set<(line: string) => void>();
  sent: string[] = [];
  on(_event: string, listener: (line: string) => void): void { this.listeners.add(listener); }
  off(_event: string, listener: (line: string) => void): void { this.listeners.delete(listener); }
  send(line: string): void { this.sent.push(line); }
  emit(line: string): void { for (const listener of this.listeners) listener(line); }
}

function line(peer: string, inner: unknown): string {
  return JSON.stringify({ peer, ct: Buffer.from(JSON.stringify(inner)).toString("base64") });
}

describe("V2PeerChannel", () => {
  test("strictly decodes client v2 frames and rejects v1", () => {
    const relay = new RelayMock();
    const received = vi.fn();
    const channel = new V2PeerChannel(relay as unknown as RelayClient, "owner", received);
    relay.emit(line("other", { protocol_version: 2, type: "session_hello", id: "h", channel_id: "c" }));
    relay.emit(line("owner", { type: "session_hello", id: "h", channel_id: "c" }));
    relay.emit(line("owner", { protocol_version: 2, type: "session_hello", id: "h", channel_id: "c" }));
    expect(received).toHaveBeenCalledTimes(1);
    channel.detach();
    expect(relay.listeners).toHaveLength(0);
  });

  test("encodes only strict server v2 frames inside the opaque relay envelope", () => {
    const relay = new RelayMock();
    const channel = new V2PeerChannel(relay as unknown as RelayClient, "owner", () => undefined);
    channel.sendV2({
      protocol_version: 2,
      type: "session_ready",
      in_reply_to: "h",
      target_channel_id: "c",
      session_id: "s",
      history_generation: "g",
      self_sender_ref: "owner",
    });
    const outer = JSON.parse(relay.sent[0]!) as { peer: string; ct: string };
    expect(outer.peer).toBe("owner");
    expect(decodeServerFrameV2(Buffer.from(outer.ct, "base64").toString("utf8"))).toMatchObject({ type: "session_ready" });
  });
});
