/** Protocol v2 ping -> pong over the endpoint route envelope. */
import { describe, expect, test, vi, beforeEach } from "vitest";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  decodeClientFrameV2,
  decodeServerFrameV2,
  encodeClientFrameV2,
  type ClientFrame,
  type ServerFrame,
} from "../src/protocol/v2/index.js";
const { relayRef, MockRelay } = vi.hoisted(() => {
  class MockRelay {
    private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    connect = vi.fn().mockResolvedValue(undefined);
    send = vi.fn();
    sendControl = vi.fn();
    close = vi.fn();
    isOpen = vi.fn().mockReturnValue(true);
    constructor() { relayRef.current = this; }
    on(name: string, listener: (...args: unknown[]) => void): this { (this.listeners.get(name) ?? this.listeners.set(name, new Set()).get(name)!).add(listener); return this; }
    off(name: string, listener: (...args: unknown[]) => void): this { this.listeners.get(name)?.delete(listener); return this; }
    emit(name: string, ...args: unknown[]): boolean { for (const listener of this.listeners.get(name) ?? []) listener(...args); return true; }
  }
  const relayRef: { current: MockRelay | null } = { current: null };
  return { relayRef, MockRelay };
});

vi.mock("../src/pairing/storage.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/pairing/storage.js")>();
  return {
    ...orig,
    getOrCreateEd25519Keypair: vi.fn().mockResolvedValue({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) }),
    listPeers: vi.fn().mockResolvedValue([]),
    addPeer: vi.fn(),
    removePeer: vi.fn(),
  };
});

vi.mock("../src/config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/config.js")>();
  return { ...orig, resolveRelayUrl: vi.fn().mockReturnValue({ url: "ws://localhost:3000", source: "default" as const }) };
});

vi.mock("../src/pairing/qr.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/pairing/qr.js")>();
  return {
    ...orig,
    qrSession: {
      issueToken: vi.fn().mockReturnValue({ token: "test-token", expiresAt: Date.now() + 60_000 }),
      reserveToken: vi.fn((token: string, ownerId: string, requestId: string) => ({ status: "reserved", reservation: Object.freeze({ token, ownerId, requestId }) })),
      commitToken: vi.fn().mockReturnValue(true),
      releaseToken: vi.fn().mockReturnValue(true),
      isReservationCurrent: vi.fn().mockReturnValue(true),
      clear: vi.fn(),
    },
  };
});

vi.mock("../src/transport/relay_client.js", () => ({ RelayClient: MockRelay }));

const { processEndpointIdentity, _getCachedPublicKeyForTest, _getState, _startRelayForTest, _stopForTest } = await import("../src/index.js");

function makeMockCtx() {
  return { ui: { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn() }, cwd: "/tmp/test", abort: vi.fn() };
}

function deviceId(): string { return _getCachedPublicKeyForTest()!; }
function routeLine(ownerId: string, frame: ClientFrame): string {
  return JSON.stringify({
    type: "route",
    purpose: frame.type === "pair_request" ? "pairing" : "session",
    device_id: deviceId(),
    endpoint_id: processEndpointIdentity().endpointId,
    runtime_instance_id: processEndpointIdentity().runtimeInstanceId,
    source_owner_id: ownerId,
    ct: Buffer.from(encodeClientFrameV2(decodeClientFrameV2(frame))).toString("base64"),
  });
}
function decodeSent(raw: string): { target_owner_id?: string; frame: ServerFrame } {
  const route = JSON.parse(raw) as { target_owner_id?: string; ct: string };
  return { target_owner_id: route.target_owner_id, frame: decodeServerFrameV2(Buffer.from(route.ct, "base64").toString("utf8")) };
}

type PairContext = { ownerId: string; channelId: string; historyGeneration: string };

async function pairUp(): Promise<PairContext> {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, handler); },
    registerCommand: () => undefined,
    registerTool: () => undefined,
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => undefined,
    registerMessageRenderer: () => undefined,
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
  } as unknown as ExtensionAPI;
  (await import("../src/index.js")).default(pi as unknown as Parameters<ExtensionFactory>[0]);
  const sessionStart = handlers.get("session_start");
  if (!sessionStart) throw new Error("session_start handler was not registered");
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  sessionStart({ type: "session_start", reason: "startup" }, { sessionManager: SessionManager.inMemory("/tmp/test"), abort: vi.fn(), compact: vi.fn(), ui: makeMockCtx().ui });

  await _startRelayForTest(makeMockCtx());
  expect(_getState()).toBe("started");
  const ownerId = "owner-1";
  relayRef.current!.emit("message", routeLine(ownerId, { protocol_version: 2, type: "pair_request", id: "pair-req-1", token: "test-token", device_name: "Test Phone" }));
  await vi.waitFor(() => expect(_getState()).toBe("paired"), { timeout: 2000 });

  const channelId = "channel-owner-1";
  const sendsBeforeHello = relayRef.current!.send.mock.calls.length;
  relayRef.current!.emit("message", routeLine(ownerId, { protocol_version: 2, type: "session_hello", id: "hello-owner-1", channel_id: channelId }));
  let ready: Extract<ServerFrame, { type: "session_ready" }> | undefined;
  await vi.waitFor(() => {
    ready = relayRef.current!.send.mock.calls.slice(sendsBeforeHello).map((call) => decodeSent(call[0] as string)).find((sent) => sent.frame.type === "session_ready")?.frame as Extract<ServerFrame, { type: "session_ready" }> | undefined;
    expect(ready?.target_channel_id).toBe(channelId);
  });
  return { ownerId, channelId, historyGeneration: ready!.history_generation };
}

function sendPing(context: PairContext, id: string): void {
  relayRef.current!.emit("message", routeLine(context.ownerId, { protocol_version: 2, type: "ping", id, channel_id: context.channelId, history_generation: context.historyGeneration }));
}
function sentPongs(from: number): Array<{ target_owner_id?: string; frame: Extract<ServerFrame, { type: "pong" }> }> {
  return relayRef.current!.send.mock.calls.slice(from).map((call) => decodeSent(call[0] as string)).filter((sent): sent is { target_owner_id?: string; frame: Extract<ServerFrame, { type: "pong" }> } => sent.frame.type === "pong");
}

describe("ping -> pong roundtrip", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    relayRef.current = null;
    await _stopForTest(makeMockCtx());
  });

  test("ping from paired Owner -> targeted pong with matching id", async () => {
    const context = await pairUp();
    const sendsBefore = relayRef.current!.send.mock.calls.length;
    sendPing(context, "ping-abc-123");
    await vi.waitFor(() => expect(sentPongs(sendsBefore)).toHaveLength(1));
    expect(sentPongs(sendsBefore)[0]).toMatchObject({ target_owner_id: context.ownerId, frame: { type: "pong", target_channel_id: context.channelId, in_reply_to: "ping-abc-123" } });
  });

  test("ping from unknown Owner does not receive a route", async () => {
    await pairUp();
    const sendsBefore = relayRef.current!.send.mock.calls.length;
    relayRef.current!.emit("message", routeLine("unknown-owner", { protocol_version: 2, type: "ping", id: "ping-rando", channel_id: "channel-rando", history_generation: "generation-rando" }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    const routes = relayRef.current!.send.mock.calls.slice(sendsBefore).map((call) => decodeSent(call[0] as string));
    expect(routes.some((route) => route.target_owner_id === "unknown-owner")).toBe(false);
    expect(sentPongs(sendsBefore)).toHaveLength(0);
  });

  test("two pings -> two pongs, each with correct in_reply_to", async () => {
    const context = await pairUp();
    const sendsBefore = relayRef.current!.send.mock.calls.length;
    sendPing(context, "ping-001");
    sendPing(context, "ping-002");
    await vi.waitFor(() => expect(sentPongs(sendsBefore)).toHaveLength(2));
    expect(sentPongs(sendsBefore).map((pong) => pong.frame.in_reply_to)).toEqual(["ping-001", "ping-002"]);
  });

  test("ping in idle state does not crash", () => {
    expect(_getState()).toBe("idle");
    expect(relayRef.current).toBeNull();
  });

  test("ping -> pong within 5 seconds", async () => {
    const context = await pairUp();
    const sendsBefore = relayRef.current!.send.mock.calls.length;
    const startedAt = Date.now();
    sendPing(context, "ping-5sec");
    await vi.waitFor(() => expect(sentPongs(sendsBefore)).toHaveLength(1), { timeout: 5000 });
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });
});
