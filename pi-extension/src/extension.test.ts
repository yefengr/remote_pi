import { describe, expect, test, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { decodeServerFrameV2 } from "./protocol/v2/index.js";

const relays: MockRelay[] = [];

class MockRelay extends EventEmitter {
  static OPEN = 1;
  readyState = MockRelay.OPEN;
  connect = vi.fn().mockResolvedValue(undefined);
  send = vi.fn();
  sendControl = vi.fn();
  close = vi.fn(() => { this.readyState = 3; });
  isOpen = vi.fn(() => this.readyState === MockRelay.OPEN);
  constructor() { super(); relays.push(this); }
}

vi.mock("./transport/relay_client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./transport/relay_client.js")>()),
  RelayClient: MockRelay,
}));

const owners: Array<{ name: string; remote_epk: string; paired_at: string }> = [];
vi.mock("./pairing/storage.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./pairing/storage.js")>();
  return {
    ...original,
    getOrCreateEd25519Keypair: vi.fn().mockResolvedValue({ publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(32).fill(2) }),
    listPeers: vi.fn().mockImplementation(async () => [...owners]),
    addPeer: vi.fn().mockImplementation(async (owner) => { owners.push(owner); }),
    removePeer: vi.fn().mockImplementation(async (ownerId) => {
      const index = owners.findIndex((owner) => owner.remote_epk === ownerId);
      if (index < 0) return false;
      owners.splice(index, 1);
      return true;
    }),
  };
});

let tokenStatus: "ok" | "expired" | "consumed" | "unknown" = "ok";
vi.mock("./pairing/qr.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./pairing/qr.js")>();
  return {
    ...original,
    qrSession: {
      issueToken: vi.fn(() => ({ token: "pair-token", expiresAt: Date.now() + 60_000 })),
      consumeToken: vi.fn(() => tokenStatus),
      clear: vi.fn(),
    },
  };
});

const { default: extension, _connectForTest, _stopForTest, _getState, processEndpointIdentity } = await import("./index.js");

function makePi(): ExtensionAPI & { handlers: Map<string, Function>; commands: Map<string, Function>; sent: unknown[] } {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, Function>();
  const sent: unknown[] = [];
  return {
    handlers,
    commands,
    sent,
    registerCommand: vi.fn((name, definition) => commands.set(name, definition.handler)),
    on: vi.fn((name, handler) => handlers.set(name, handler)),
    sendMessage: vi.fn((message) => sent.push(message)),
    getThinkingLevel: vi.fn(),
  } as unknown as ExtensionAPI & { handlers: Map<string, Function>; commands: Map<string, Function>; sent: unknown[] };
}

function ctx() {
  return {
    cwd: "/tmp/remote-pi-endpoint-test",
    ui: { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn() },
    abort: vi.fn(),
  };
}

function sourceOwner(): string {
  return Buffer.alloc(32, 7).toString("base64");
}

function inbound(identity: ReturnType<typeof processEndpointIdentity>, inner: unknown): string {
  return JSON.stringify({
    type: "route",
    purpose: "pairing",
    device_id: Buffer.alloc(32, 1).toString("base64"),
    endpoint_id: identity.endpointId,
    runtime_instance_id: identity.runtimeInstanceId,
    source_owner_id: sourceOwner(),
    ct: Buffer.from(JSON.stringify(inner)).toString("base64"),
  });
}

describe("Remote Pi endpoint extension", () => {
  beforeEach(async () => {
    owners.length = 0;
    relays.length = 0;
    tokenStatus = "ok";
    await _stopForTest(ctx());
  });

  test("keeps endpoint and runtime identity process-scoped", () => {
    expect(processEndpointIdentity()).toBe(processEndpointIdentity());
    expect(processEndpointIdentity().endpointId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(processEndpointIdentity().runtimeInstanceId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test("connects as a Relay host with endpoint identity and Owner ACL", async () => {
    owners.push({ name: "owner", remote_epk: sourceOwner(), paired_at: "now" });
    await _connectForTest(ctx());
    expect(_getState()).toBe("started");
    const relay = relays.at(-1)!;
    expect(relay.connect).toHaveBeenCalledWith(expect.objectContaining({
      role: "host",
      endpointId: processEndpointIdentity().endpointId,
      runtimeInstanceId: processEndpointIdentity().runtimeInstanceId,
      authorizedOwnerIds: [sourceOwner()],
      metadata: expect.objectContaining({ kind: "interactive", pid: process.pid }),
    }));
  });

  test("pairing trusts relay-injected source_owner_id and targets its response", async () => {
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    const manager = { getSessionId: () => "session-1", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-1" };
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: manager });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "pair_request", id: "P1", token: "pair-token", device_name: "phone" }));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalled());
    expect(owners).toEqual([expect.objectContaining({ remote_epk: sourceOwner(), name: "phone" })]);
    const outbound = JSON.parse(relay.send.mock.calls.at(-1)![0]) as Record<string, string>;
    expect(outbound.target_owner_id).toBe(sourceOwner());
    expect(outbound.source_owner_id).toBeUndefined();
    expect(decodeServerFrameV2(Buffer.from(outbound.ct, "base64").toString("utf8"))).toMatchObject({ type: "pair_ok", endpoint_id: processEndpointIdentity().endpointId });
  });

  test("rejects a route without Relay-provided source_owner_id", async () => {
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    relay.emit("message", JSON.stringify({
      type: "route", purpose: "pairing", device_id: Buffer.alloc(32, 1).toString("base64"),
      endpoint_id: processEndpointIdentity().endpointId, runtime_instance_id: processEndpointIdentity().runtimeInstanceId,
      ct: Buffer.from(JSON.stringify({ protocol_version: 2, type: "pair_request", id: "P1", token: "pair-token", device_name: "phone" })).toString("base64"),
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(relay.send).not.toHaveBeenCalled();
  });
});
