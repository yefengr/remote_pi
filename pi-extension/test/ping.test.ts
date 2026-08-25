/**
 * Ping → Pong roundtrip test.
 *
 * Verifies the full flow: app sends a `ping` ClientMessage over the relay,
 * the extension handler calls `_peerChannel.send({ type: "pong", … })`,
 * and the pong is sent back to the correct peer with the matching id.
 */
import { describe, expect, test, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  decodeClientFrameV2,
  decodeServerFrameV2,
  encodeClientFrameV2,
  type ClientFrame,
  type ServerFrame,
} from "../src/protocol/v2/index.js";

// ── Mock RelayClient ──────────────────────────────────────────────────────────

const relayRef: { current: MockRelay | null } = { current: null };

class MockRelay extends EventEmitter {
  static OPEN = 1;
  readyState = MockRelay.OPEN;
  connect     = vi.fn();
  send        = vi.fn();
  sendControl = vi.fn();
  close       = vi.fn();
  constructor() { super(); relayRef.current = this; }
}

// ── Mock storage (empty — no peer persistence tests here) ─────────────────────

vi.mock("../src/pairing/storage.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/pairing/storage.js")>();
  return {
    ...orig,
    getOrCreateEd25519Keypair: vi.fn().mockResolvedValue({
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(32),
    }),
    listPeers: vi.fn().mockResolvedValue([]),
    snapshotOwnerPubkeys: vi.fn().mockRejectedValue(
      new Error("strict Owner snapshot unavailable"),
    ),
    addPeer: vi.fn(),
    removePeer: vi.fn(),
  };
});

// ── Mock config ───────────────────────────────────────────────────────────────

vi.mock("../src/config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/config.js")>();
  return {
    ...orig,
    loadConfig: vi.fn().mockReturnValue({}),
    saveConfig: vi.fn(),
    resolveRelayUrl: vi.fn().mockReturnValue({
      url: "ws://localhost:3000",
      source: "default" as const,
    }),
  };
});

// ── Mock qr ───────────────────────────────────────────────────────────────────

vi.mock("../src/pairing/qr.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/pairing/qr.js")>();
  return {
    ...orig,
    displayQR: vi.fn(),
    qrSession: {
      issueToken: vi.fn().mockReturnValue({ token: "test-token", expiresAt: Date.now() + 60_000 }),
      consumeToken: vi.fn().mockReturnValue("ok"),
      clear: vi.fn(),
      generateToken: vi.fn().mockReturnValue("test-token"),
    },
  };
});

// Mock RelayClient *after* qr import (so module resolution order is consistent)
vi.mock("../src/transport/relay_client.js", () => ({
  RelayClient: MockRelay,
}));

// ── Import the extension after mocks ──────────────────────────────────────────

const {
  default: extension,
  _getState,
  _startRelayForTest,
  _stopForTest,
} = await import("../src/index.js");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockCtx() {
  return {
    ui: { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn() },
    cwd: "/tmp/test",
    abort: vi.fn(),
  };
}

function makeV2Line(peer: string, frame: ClientFrame): string {
  const inner = encodeClientFrameV2(decodeClientFrameV2(frame));
  return JSON.stringify({ peer, ct: Buffer.from(inner).toString("base64") });
}

function decodeV2Sent(raw: string): { peer: string; frame: ServerFrame } {
  const outer = JSON.parse(raw) as { peer: string; ct: string };
  return {
    peer: outer.peer,
    frame: decodeServerFrameV2(Buffer.from(outer.ct, "base64").toString("utf8")),
  };
}

type PairContext = {
  peer: string;
  channelId: string;
  historyGeneration: string;
};

/** Completes the production v2 pairing and logical-channel handshake. */
async function pairUp(): Promise<PairContext> {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    },
    registerCommand: () => undefined,
    registerTool: () => undefined,
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => undefined,
    registerMessageRenderer: () => undefined,
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
  } as unknown as ExtensionAPI;
  (extension as ExtensionFactory)(pi);

  const sessionStart = handlers.get("session_start");
  if (!sessionStart) throw new Error("session_start handler was not registered");
  sessionStart(
    { type: "session_start", reason: "startup" },
    {
      sessionManager: SessionManager.inMemory("/tmp/test"),
      abort: vi.fn(),
      compact: vi.fn(),
      ui: makeMockCtx().ui,
    },
  );

  await _startRelayForTest(makeMockCtx());
  expect(_getState()).toBe("started");

  const peer = "app-peer-001";
  relayRef.current!.emit("message", makeV2Line(peer, {
    protocol_version: 2,
    type: "pair_request",
    id: "pair-req-1",
    token: "test-token",
    device_name: "Test Phone",
  }));
  await vi.waitFor(() => expect(_getState()).toBe("paired"), { timeout: 2000 });

  const channelId = "channel-app-peer-001";
  const sendsBeforeHello = relayRef.current!.send.mock.calls.length;
  relayRef.current!.emit("message", makeV2Line(peer, {
    protocol_version: 2,
    type: "session_hello",
    id: "hello-app-peer-001",
    channel_id: channelId,
  }));

  let ready: Extract<ServerFrame, { type: "session_ready" }> | undefined;
  await vi.waitFor(() => {
    ready = relayRef.current!.send.mock.calls
      .slice(sendsBeforeHello)
      .map((call) => decodeV2Sent(call[0] as string))
      .find((sent): sent is { peer: string; frame: Extract<ServerFrame, { type: "session_ready" }> } =>
        sent.peer === peer && sent.frame.type === "session_ready");
    expect(ready?.frame.target_channel_id).toBe(channelId);
  });

  return { peer, channelId, historyGeneration: ready!.frame.history_generation };
}

function sendPing(context: PairContext, id: string): void {
  relayRef.current!.emit("message", makeV2Line(context.peer, {
    protocol_version: 2,
    type: "ping",
    id,
    channel_id: context.channelId,
    history_generation: context.historyGeneration,
  }));
}

function sentPongs(from: number): Array<{ peer: string; frame: Extract<ServerFrame, { type: "pong" }> }> {
  return relayRef.current!.send.mock.calls
    .slice(from)
    .map((call) => decodeV2Sent(call[0] as string))
    .filter((sent): sent is { peer: string; frame: Extract<ServerFrame, { type: "pong" }> } =>
      sent.frame.type === "pong");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ping → pong roundtrip", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    relayRef.current = null;

    // Stop any active session first (idempotent — safe when already idle).
    await _stopForTest(makeMockCtx());
  });

  test("ping from paired peer → pong sent back with matching in_reply_to", async () => {
    const context = await pairUp();
    expect(_getState()).toBe("paired");
    const sendsBefore = relayRef.current!.send.mock.calls.length;

    sendPing(context, "ping-abc-123");

    await vi.waitFor(() => expect(sentPongs(sendsBefore)).toHaveLength(1));
    expect(sentPongs(sendsBefore)[0]).toMatchObject({
      peer: context.peer,
      frame: {
        protocol_version: 2,
        type: "pong",
        target_channel_id: context.channelId,
        in_reply_to: "ping-abc-123",
      },
    });
  });

  test("ping from unknown peer → no pong sent", async () => {
    await pairUp();
    const sendsBefore = relayRef.current!.send.mock.calls.length;

    relayRef.current!.emit("message", makeV2Line("some-rando-peer", {
      protocol_version: 2,
      type: "ping",
      id: "ping-rando",
      channel_id: "channel-rando",
      history_generation: "generation-rando",
    }));

    await vi.waitFor(() => expect(relayRef.current!.send.mock.calls.length).toBeGreaterThan(sendsBefore));
    expect(sentPongs(sendsBefore)).toHaveLength(0);
    expect(
      relayRef.current!.send.mock.calls
        .slice(sendsBefore)
        .map((call) => decodeV2Sent(call[0] as string)),
    ).toContainEqual(expect.objectContaining({
      peer: "some-rando-peer",
      frame: expect.objectContaining({ type: "protocol_error", code: "invalid_channel" }),
    }));
  });

  test("two pings → two pongs, each with correct in_reply_to", async () => {
    const context = await pairUp();
    const sendsBefore = relayRef.current!.send.mock.calls.length;

    sendPing(context, "ping-001");
    sendPing(context, "ping-002");

    await vi.waitFor(() => expect(sentPongs(sendsBefore)).toHaveLength(2));
    expect(sentPongs(sendsBefore).map((pong) => pong.frame.in_reply_to)).toEqual([
      "ping-001",
      "ping-002",
    ]);
  });

  test("ping in idle state (no relay) → no crash, no pong", () => {
    expect(_getState()).toBe("idle");
    expect(relayRef.current).toBeNull();
  });

  test("ping → pong within 5 seconds", async () => {
    const context = await pairUp();
    const sendsBefore = relayRef.current!.send.mock.calls.length;
    const startedAt = Date.now();

    sendPing(context, "ping-5sec");

    await vi.waitFor(() => expect(sentPongs(sendsBefore)).toHaveLength(1), { timeout: 5_000 });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(sentPongs(sendsBefore)[0]!.frame.in_reply_to).toBe("ping-5sec");
  });
});
