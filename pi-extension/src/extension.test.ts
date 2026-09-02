import { describe, expect, test, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { decodeServerFrameV2 } from "./protocol/v2/index.js";
import { RPC_CONTROL_STATUS_KEY } from "./daemon/rpc_child.js";

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

const {
  default: extension, _connectForTest, _stopForTest, _getState, processEndpointIdentity,
  _setSessionNewBridgeTimeoutForTest,
} = await import("./index.js");

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

function inbound(
  identity: ReturnType<typeof processEndpointIdentity>,
  inner: unknown,
  purpose: "pairing" | "session" = "pairing",
): string {
  return JSON.stringify({
    type: "route",
    purpose,
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
    _setSessionNewBridgeTimeoutForTest(5_000);
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

  test("emits daemon readiness over the structured RPC status channel", () => {
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    const context = ctx();
    const manager = { getSessionId: () => "session-ready", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-ready" };
    process.env["REMOTE_PI_DAEMON"] = "1";
    process.env["REMOTE_PI_DIRECT_CONFIG"] = JSON.stringify({ auto_start_relay: false });
    try {
      pi.handlers.get("session_start")?.({}, { ...context, sessionManager: manager });
    } finally {
      delete process.env["REMOTE_PI_DAEMON"];
      delete process.env["REMOTE_PI_DIRECT_CONFIG"];
    }
    const control = context.ui.setStatus.mock.calls
      .filter(([key]) => key === RPC_CONTROL_STATUS_KEY)
      .map(([, text]) => JSON.parse(text as string) as Record<string, unknown>)
      .find((event) => event["type"] === "runtime_ready");
    expect(control).toMatchObject({
      type: "runtime_ready",
      control_protocol_version: 2,
      endpoint_id: processEndpointIdentity().endpointId,
      runtime_instance_id: processEndpointIdentity().runtimeInstanceId,
      session_id: "session-ready",
    });
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

  test("routes session_new through the internal command bridge and uses its command ctx", async () => {
    owners.push({ name: "owner", remote_epk: sourceOwner(), paired_at: "now" });
    const pi = makePi();
    (pi as { sendUserMessage?: unknown }).sendUserMessage = vi.fn().mockResolvedValue(undefined);
    (extension as ExtensionFactory)(pi);
    const manager = { getSessionId: () => "session-1", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-1" };
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: manager });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    relay.emit("message", inbound(processEndpointIdentity(), {
      protocol_version: 2, type: "session_hello", id: "hello-1", channel_id: "channel-1",
    }, "session"));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalled());
    const readyOuter = JSON.parse(relay.send.mock.calls.at(-1)![0]) as { ct: string };
    const ready = decodeServerFrameV2(Buffer.from(readyOuter.ct, "base64").toString("utf8"));
    if (ready.type !== "session_ready") throw new Error("expected session_ready");
    relay.send.mockClear();
    relay.emit("message", inbound(processEndpointIdentity(), {
      protocol_version: 2, type: "session_new", id: "new-1", channel_id: "channel-1", history_generation: ready.history_generation,
    }, "session"));
    await vi.waitFor(() => expect(pi.sendUserMessage).toHaveBeenCalled());
    const [content, options] = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(content).toMatch(/^\/remote-pi internal-session-new [0-9a-f-]{36}$/);
    expect(options).toEqual({ expandPromptTemplates: true });

    const token = (content as string).split(" ")[2]!;
    const newManager = { ...manager, getSessionId: () => "session-2", getLeafId: () => "session-2" };
    const commandCtx = {
      ...ctx(),
      newSession: vi.fn(async (options?: { withSession?: (fresh: unknown) => Promise<void> }) => {
        expect(pi.handlers.get("session_before_switch")?.({ reason: "new" })).toBeUndefined();
        expect(pi.handlers.get("session_before_switch")?.({ reason: "resume" })).toEqual({ cancel: true });
        expect(pi.handlers.get("session_before_switch")?.({ reason: "new" })).toEqual({ cancel: true });
        expect(pi.handlers.get("session_before_fork")?.({ entryId: "entry", position: "before" })).toEqual({ cancel: true });
        pi.handlers.get("session_shutdown")?.({ reason: "new" });
        pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: newManager });
        await options?.withSession?.({ ...ctx(), newSession: vi.fn() });
        return { cancelled: false };
      }),
    };
    await pi.commands.get("remote-pi")?.(`internal-session-new ${token}`, commandCtx);
    expect(commandCtx.newSession).toHaveBeenCalledTimes(1);
    expect(relay.close).not.toHaveBeenCalled();
    const frames = relay.send.mock.calls.map(([line]) => {
      const outbound = JSON.parse(line) as { ct: string };
      return decodeServerFrameV2(Buffer.from(outbound.ct, "base64").toString("utf8"));
    });
    expect(frames.at(-2)).toMatchObject({ type: "action_ok", in_reply_to: "new-1", action: "session_new" });
    expect(frames.at(-1)).toMatchObject({ type: "bye", session_id: "session-1", reason: "session_replaced" });
    expect(pi.handlers.get("session_before_switch")?.({ reason: "resume" })).toBeUndefined();
    expect(pi.handlers.get("session_before_fork")?.({ entryId: "entry", position: "before" })).toBeUndefined();
  });

  test("a local session replacement keeps Relay alive and sends bye after the new session is ready", async () => {
    owners.push({ name: "owner", remote_epk: sourceOwner(), paired_at: "now" });
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    const oldManager = { getSessionId: () => "session-1", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-1" };
    const newManager = { ...oldManager, getSessionId: () => "session-2", getLeafId: () => "session-2" };
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: oldManager });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_hello", id: "hello-1", channel_id: "channel-1" }, "session"));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalled());
    relay.send.mockClear();
    pi.handlers.get("session_shutdown")?.({ reason: "new" });
    expect(relay.send).not.toHaveBeenCalled();
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: newManager });
    expect(relay.close).not.toHaveBeenCalled();
    const outbound = JSON.parse(relay.send.mock.calls.at(-1)![0]) as { ct: string };
    expect(decodeServerFrameV2(Buffer.from(outbound.ct, "base64").toString("utf8"))).toMatchObject({ type: "bye", session_id: "session-1", reason: "session_replaced" });
  });

  test("session_new bridge returns action_error when dispatch fails", async () => {
    owners.push({ name: "owner", remote_epk: sourceOwner(), paired_at: "now" });
    const pi = makePi();
    (pi as { sendUserMessage?: unknown }).sendUserMessage = vi.fn().mockRejectedValue(new Error("dispatch unavailable"));
    (extension as ExtensionFactory)(pi);
    const manager = { getSessionId: () => "session-1", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-1" };
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: manager });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_hello", id: "hello-1", channel_id: "channel-1" }, "session"));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalled());
    const readyOuter = JSON.parse(relay.send.mock.calls.at(-1)![0]) as { ct: string };
    const ready = decodeServerFrameV2(Buffer.from(readyOuter.ct, "base64").toString("utf8"));
    if (ready.type !== "session_ready") throw new Error("expected session_ready");
    relay.send.mockClear();
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_new", id: "new-1", channel_id: "channel-1", history_generation: ready.history_generation }, "session"));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalled());
    const outbound = JSON.parse(relay.send.mock.calls.at(-1)![0]) as { ct: string };
    expect(decodeServerFrameV2(Buffer.from(outbound.ct, "base64").toString("utf8"))).toMatchObject({
      type: "action_error", in_reply_to: "new-1", action: "session_new", error: "session replacement dispatch failed",
    });
  });

  test("stopping cancels a dispatched session_new before closing Relay", async () => {
    owners.push({ name: "owner", remote_epk: sourceOwner(), paired_at: "now" });
    const pi = makePi();
    (pi as { sendUserMessage?: unknown }).sendUserMessage = vi.fn().mockResolvedValue(undefined);
    (extension as ExtensionFactory)(pi);
    const manager = { getSessionId: () => "session-1", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-1" };
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: manager });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_hello", id: "hello-1", channel_id: "channel-1" }, "session"));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalled());
    const readyOuter = JSON.parse(relay.send.mock.calls.at(-1)![0]) as { ct: string };
    const ready = decodeServerFrameV2(Buffer.from(readyOuter.ct, "base64").toString("utf8"));
    if (ready.type !== "session_ready") throw new Error("expected session_ready");
    relay.send.mockClear();
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_new", id: "new-1", channel_id: "channel-1", history_generation: ready.history_generation }, "session"));
    await vi.waitFor(() => expect(pi.sendUserMessage).toHaveBeenCalled());
    await _stopForTest(ctx());
    const frames = relay.send.mock.calls.map(([line]) => decodeServerFrameV2(Buffer.from((JSON.parse(line) as { ct: string }).ct, "base64").toString("utf8")));
    expect(frames[0]).toMatchObject({ type: "action_error", in_reply_to: "new-1", error: "session replacement cancelled because the endpoint closed" });
    expect(frames[1]).toMatchObject({ type: "bye", reason: "peer_stop" });
    expect(relay.close).toHaveBeenCalledTimes(1);
  });

  test("session_new bridge times out without an internal command invocation", async () => {
    owners.push({ name: "owner", remote_epk: sourceOwner(), paired_at: "now" });
    const pi = makePi();
    (pi as { sendUserMessage?: unknown }).sendUserMessage = vi.fn().mockResolvedValue(undefined);
    (extension as ExtensionFactory)(pi);
    _setSessionNewBridgeTimeoutForTest(5);
    const manager = { getSessionId: () => "session-1", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-1" };
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: manager });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_hello", id: "hello-1", channel_id: "channel-1" }, "session"));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalled());
    const readyOuter = JSON.parse(relay.send.mock.calls.at(-1)![0]) as { ct: string };
    const ready = decodeServerFrameV2(Buffer.from(readyOuter.ct, "base64").toString("utf8"));
    if (ready.type !== "session_ready") throw new Error("expected session_ready");
    relay.send.mockClear();
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_new", id: "new-1", channel_id: "channel-1", history_generation: ready.history_generation }, "session"));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalled());
    const outbound = JSON.parse(relay.send.mock.calls.at(-1)![0]) as { ct: string };
    expect(decodeServerFrameV2(Buffer.from(outbound.ct, "base64").toString("utf8"))).toMatchObject({
      type: "action_error", in_reply_to: "new-1", action: "session_new", error: "session replacement dispatch timed out",
    });
  });
});
