import { beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { generateOwnerKeyPair } from "@/lib/remote-pi/crypto";
import { encodeBase64 } from "@/lib/remote-pi/encoding";
import { toStoredKey } from "@/lib/pwa/runtime";
import { makePwaDeviceId, makePwaEndpointId, openPwaDatabase } from "@/lib/pwa/db";
import { PwaApp } from "./pwa-app";

const relayHarness = vi.hoisted(() => ({
  instances: [] as Array<{
    state: string;
    closeCalls: number;
    connectCalls: number;
    subscriptions: string[][];
    stateListeners: Array<(state: string) => void>;
    errorListeners: Array<(error: Error) => void>;
    controlListeners: Array<(frame: unknown) => void>;
    emitState: (state: string) => void;
    emitControl: (frame: unknown) => void;
    emitError: (error: Error) => void;
    connectRejects: number;
  }>,
  nextConnectRejects: 0,
  rejectConnect: null as ((error: Error) => void) | null,
}));
const channelHarness = vi.hoisted(() => ({
  channels: [] as Array<{
    channelId: string;
    frames: Array<{ type: string; id: string; channel_id?: string }>;
    emit: (frame: unknown) => void;
    closeCalls: number;
  }>,
  nextSendResults: [] as boolean[],
}));

vi.mock("@/lib/remote-pi/relay-client", () => ({
  RelayClient: class {
    state = "idle";
    closeCalls = 0;
    connectCalls = 0;
    subscriptions: string[][] = [];
    stateListeners: Array<(state: string) => void> = [];
    errorListeners: Array<(error: Error) => void> = [];
    controlListeners: Array<(frame: unknown) => void> = [];
    connectRejects = relayHarness.nextConnectRejects;

    constructor() {
      relayHarness.nextConnectRejects = 0;
      relayHarness.rejectConnect = null;
      relayHarness.instances.push(this);
    }

    on(event: string, callback: (value: unknown) => void) {
      if (event === "state") this.stateListeners.push(callback as (state: string) => void);
      if (event === "error") this.errorListeners.push(callback as (error: Error) => void);
      if (event === "control") this.controlListeners.push(callback);
      return () => undefined;
    }

    async connect() {
      this.connectCalls += 1;
      if (this.connectRejects > 0) {
        this.connectRejects -= 1;
        this.state = "closed";
        await new Promise<void>((_, reject) => {
          relayHarness.rejectConnect = () => reject(new Error("connect rejected"));
        });
      }
      this.state = "open";
    }

    subscribeEndpoints(deviceIds: string[]) {
      this.subscriptions.push([...deviceIds]);
      return this.state === "open";
    }

    sendControl() {
      return this.state === "open";
    }

    sendRoute() {
      return this.state === "open";
    }

    emitState(state: string) {
      this.state = state;
      for (const listener of this.stateListeners) listener(state);
    }

    emitError(error: Error) {
      for (const listener of this.errorListeners) listener(error);
    }

    emitControl(frame: unknown) {
      for (const listener of this.controlListeners) listener(frame);
    }

    close() {
      this.closeCalls += 1;
      this.emitState("closed");
    }
  },
}));

vi.mock("@/lib/remote-pi/peer-channel", () => ({
  PeerChannel: class {
    readonly channelId: string;
    readonly frames: Array<{ type: string; id: string; channel_id?: string }> = [];
    closeCalls = 0;
    private readonly onFrame?: (frame: unknown) => void;

    constructor(options: {
      endpoint: { endpointId: string };
      channelId?: string;
      onFrame?: (frame: unknown) => void;
      onPairOk?: (frame: {
        protocol_version: 2;
        type: "pair_ok";
        in_reply_to: string;
        session_name: string;
        session_started_at: number;
        endpoint_id: string;
        hostname: string;
      }) => void;
    }) {
      this.channelId = options.channelId ?? `pairing-channel-${channelHarness.channels.length}`;
      this.onFrame = options.onFrame;
      channelHarness.channels.push({ channelId: this.channelId, frames: this.frames, emit: (frame) => this.onFrame?.(frame), closeCalls: 0 });
      this.options = options;
    }
    private readonly options: {
      endpoint: { endpointId: string };
      onPairOk?: (frame: {
        protocol_version: 2;
        type: "pair_ok";
        in_reply_to: string;
        session_name: string;
        session_started_at: number;
        endpoint_id: string;
        hostname: string;
      }) => void;
    };

    send(frame: { type: string; id: string; channel_id?: string }) {
      this.frames.push({ type: frame.type, id: frame.id, ...(frame.channel_id ? { channel_id: frame.channel_id } : {}) });
      const sendResult = channelHarness.nextSendResults.shift() ?? true;
      if (!sendResult) return false;
      if (frame.type === "pair_request") {
        queueMicrotask(() => this.options.onPairOk?.({
          protocol_version: 2,
          type: "pair_ok",
          in_reply_to: frame.id,
          session_name: "test-session",
          session_started_at: Date.now(),
          endpoint_id: this.options.endpoint.endpointId,
          hostname: "paired-host",
        }));
      }
      return true;
    }

    sendPairRequest(frame: { type: string; id: string }) {
      return this.send(frame);
    }

    close() {
      this.closeCalls += 1;
    }
  },
}));

beforeEach(async () => {
  relayHarness.instances.length = 0;
  relayHarness.nextConnectRejects = 0;
  relayHarness.rejectConnect = null;
  channelHarness.channels.length = 0;
  channelHarness.nextSendResults.length = 0;
  const db = await openPwaDatabase();
  await db.transaction("rw", [db.identities, db.devices, db.endpoints, db.timelineEvents, db.settings], async () => {
    await Promise.all([
      db.identities.clear(),
      db.devices.clear(),
      db.endpoints.clear(),
      db.timelineEvents.clear(),
      db.settings.clear(),
    ]);
  });
  const identity = await generateOwnerKeyPair();
  const deviceId = "owner-device-key";
  const endpointId = "daemon-endpoint";
  await Promise.all([
    db.identities.put({ id: "owner", publicKey: toStoredKey(identity.publicKey), secretKey: toStoredKey(identity.privateKey), createdAt: Date.now() }),
    db.devices.put({ id: makePwaDeviceId(deviceId), deviceId, relayUrl: "https://relay.example.test", pairedAt: "2026-08-30T00:00:00.000Z", hostname: "test-host" }),
    db.endpoints.put({ id: makePwaEndpointId(deviceId, endpointId), deviceId, endpointId, runtimeInstanceId: "runtime-1", kind: "daemon", cwd: "/workspace", updatedAt: Date.now() }),
    db.settings.put({ key: `active_endpoint:${makePwaDeviceId(deviceId)}`, value: endpointId }),
  ]);
});

test("keeps the Owner Relay alive while endpoint discovery is still checking", async () => {
  renderPwa(<PwaApp />);

  await expect.element(page.getByRole("button", { name: /^Pi on test-host Device key/i })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "daemon-endpoint" })).toBeVisible();
  expect(relayHarness.instances).toHaveLength(1);
  expect(relayHarness.instances[0]?.closeCalls).toBe(0);
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function renderOnlineApp() {
  const db = await openPwaDatabase();
  const deviceId = "owner-device-key";
  await db.endpoints.update(makePwaEndpointId(deviceId, "daemon-endpoint"), { online: true });
  const screen = await renderPwa(<PwaApp />);
  await expect.element(screen.getByRole("heading", { name: "daemon-endpoint" })).toBeVisible();
  await flushMicrotasks();
  const relay = relayHarness.instances[0];
  relay?.emitControl({
    type: "endpoint_updated",
    device_id: deviceId,
    endpoint_id: "daemon-endpoint",
    runtime_instance_id: "runtime-1",
    metadata: { kind: "daemon", cwd: "/workspace" },
  });
  await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(1));
  return screen;
}

function readyFrame(channel: { channelId: string; frames: Array<{ type: string; id: string; channel_id?: string }> }, sessionId: string) {
  return {
    protocol_version: 2 as const,
    type: "session_ready" as const,
    target_channel_id: channel.channelId,
    in_reply_to: channel.frames.find((frame) => frame.type === "session_hello")?.id ?? "missing-hello",
    session_id: sessionId,
    history_generation: `generation-${sessionId}`,
    self_sender_ref: `sender-${sessionId}`,
  };
}

async function renderReadyTimeline() {
  const screen = await renderOnlineApp();
  const channel = channelHarness.channels[0];
  if (!channel) throw new Error("Expected a session channel.");
  channel.emit(readyFrame(channel, "session-1"));
  await flushMicrotasks();
  const list = document.querySelector<HTMLDivElement>(".pwa-message-list");
  if (!list) throw new Error("Expected the message list.");
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 400 },
    scrollTop: { configurable: true, writable: true, value: 600 },
  });
  const scrollTo = vi.fn();
  Object.defineProperty(list, "scrollTo", { configurable: true, value: scrollTo });
  return { channel, list, screen, scrollTo };
}

function partialFrame(partialId: string, groupId: string, delta: string) {
  return {
    protocol_version: 2 as const,
    type: "timeline_partial" as const,
    session_id: "session-1",
    history_generation: "generation-session-1",
    group_id: groupId,
    partial_id: partialId,
    kind: "assistant" as const,
    status: "delta" as const,
    delta,
  };
}

test("shows Latest after scrolling away and preserves position while unread realtime output arrives", async () => {
  const { channel, list, screen, scrollTo } = await renderReadyTimeline();
  list.scrollTop = 500;
  list.dispatchEvent(new Event("scroll", { bubbles: true }));
  await expect.element(screen.getByRole("button", { name: "Latest" })).toBeVisible();

  channel.emit(partialFrame("partial-1", "group-1", "first"));
  channel.emit(partialFrame("partial-1", "group-1", " second"));
  await expect.element(screen.getByRole("button", { name: "1 new output" })).toBeVisible();
  expect(scrollTo).not.toHaveBeenCalled();

  scrollTo.mockImplementation((options: ScrollToOptions) => {
    list.scrollTop = options.behavior === "smooth" ? 500 : 600;
    list.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await screen.getByRole("button", { name: "1 new output" }).click();
  expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });
  await expect.element(screen.getByRole("button", { name: "Latest" })).not.toBeInTheDocument();

  channel.emit(partialFrame("partial-2", "group-2", "during smooth scroll"));
  await expect.poll(() => scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "auto" });
  await expect.element(screen.getByRole("button", { name: /new output/ })).not.toBeInTheDocument();
  await screen.unmount();
});

test("follows realtime output at the bottom without showing Latest", async () => {
  const { channel, screen, scrollTo } = await renderReadyTimeline();

  channel.emit(partialFrame("partial-1", "group-1", "first"));
  await expect.poll(() => scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "auto" });
  await expect.element(screen.getByRole("button", { name: "Latest" })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: /new output/ })).not.toBeInTheDocument();
  await screen.unmount();
});

test("waits for the endpoint after Owner Relay recovery before rebuilding the stable channel", async () => {
  const screen = await renderOnlineApp();
  const relay = relayHarness.instances[0];
  expect(relay).toBeDefined();
  const initialCalls = relay?.connectCalls ?? 0;
  vi.useFakeTimers();
  try {
    relay?.emitState("closed");
    await flushMicrotasks();
    expect(relay?.connectCalls).toBe(initialCalls);
    expect(channelHarness.channels).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(relay?.connectCalls).toBe(initialCalls);
    vi.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(relay?.connectCalls).toBe(initialCalls + 1);
    expect(relay?.subscriptions.at(-1)).toEqual(["owner-device-key"]);
    expect(channelHarness.channels).toHaveLength(1);

    relay?.emitControl({
      type: "endpoint_updated",
      device_id: "owner-device-key",
      endpoint_id: "daemon-endpoint",
      runtime_instance_id: "runtime-1",
      metadata: { kind: "daemon", cwd: "/workspace" },
    });
    await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(2));
    expect(channelHarness.channels[1]?.channelId).toBe(channelHarness.channels[0]?.channelId);
  } finally {
    vi.useRealTimers();
    await screen.unmount();
  }
});

test("counts error and close from one Owner Relay failure as one retry", async () => {
  const screen = await renderOnlineApp();
  const relay = relayHarness.instances[0];
  expect(relay).toBeDefined();
  vi.useFakeTimers();
  try {
    relay?.emitError(new Error("socket error"));
    relay?.emitState("closed");
    await flushMicrotasks();
    vi.advanceTimersByTime(999);
    expect(relay?.connectCalls).toBe(1);
    vi.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(relay?.connectCalls).toBe(2);
  } finally {
    vi.useRealTimers();
    await screen.unmount();
  }
});

test("backs off a rejected Owner Relay connection and cleanup cancels recovery", async () => {
  relayHarness.nextConnectRejects = 1;
  const screen = await renderPwa(<PwaApp />);
  await expect.element(screen.getByRole("heading", { name: "daemon-endpoint" })).toBeVisible();
  await flushMicrotasks();
  const relay = relayHarness.instances[0];
  expect(relay?.connectCalls).toBe(1);
  vi.useFakeTimers();
  try {
    relayHarness.rejectConnect?.(new Error("connect rejected"));
    await flushMicrotasks();
    vi.advanceTimersByTime(999);
    expect(relay?.connectCalls).toBe(1);
    vi.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(relay?.connectCalls).toBe(2);
    const callsAfterRecovery = relay?.connectCalls ?? 0;
    await screen.unmount();
    relay?.emitState("closed");
    vi.advanceTimersByTime(30_000);
    expect(relay?.connectCalls).toBe(callsAfterRecovery);
  } finally {
    vi.useRealTimers();
  }
});

test("does not reconnect after a session channel failure closes Relay intentionally", async () => {
  channelHarness.nextSendResults.push(false);
  const screen = await renderOnlineApp();
  const relay = relayHarness.instances[0];
  expect(relay?.connectCalls).toBe(1);
  vi.useFakeTimers();
  try {
    vi.advanceTimersByTime(30_000);
    expect(relay?.connectCalls).toBe(1);
  } finally {
    vi.useRealTimers();
    await screen.unmount();
  }
});

test("keeps a stable session channel across reset and session replacement, with terminal bye requiring Retry", async () => {
  const screen = await renderOnlineApp();
  await expect.element(screen.getByRole("heading", { name: "daemon-endpoint" })).toBeVisible();
  const firstChannel = channelHarness.channels[0];
  expect(firstChannel?.frames[0]?.type).toBe("session_hello");
  firstChannel?.emit(readyFrame(firstChannel, "session-1"));
  await flushMicrotasks();

  firstChannel?.emit({ protocol_version: 2, type: "reset", target_channel_id: firstChannel.channelId, session_id: "session-1", history_generation: "generation-session-2", reason: "generation_changed" });
  await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(2));
  const secondChannel = channelHarness.channels[1];
  expect(secondChannel?.channelId).toBe(firstChannel?.channelId);
  expect(secondChannel?.frames[0]?.type).toBe("session_hello");

  secondChannel?.emit(readyFrame(secondChannel, "session-2"));
  await flushMicrotasks();
  secondChannel?.emit({ protocol_version: 2, type: "bye", session_id: "session-1", history_generation: "generation-session-1", reason: "peer_stop" });
  await flushMicrotasks();
  expect(channelHarness.channels).toHaveLength(2);
  secondChannel?.emit({ protocol_version: 2, type: "bye", session_id: "session-2", history_generation: "generation-session-2", reason: "session_replaced" });
  await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(3));
  const thirdChannel = channelHarness.channels[2];
  expect(thirdChannel?.channelId).toBe(firstChannel?.channelId);
  expect(thirdChannel?.frames[0]?.type).toBe("session_hello");

  thirdChannel?.emit(readyFrame(thirdChannel, "session-3"));
  await flushMicrotasks();
  thirdChannel?.emit({ protocol_version: 2, type: "bye", session_id: "session-3", history_generation: "generation-session-3", reason: "peer_stop" });
  await flushMicrotasks();
  expect(channelHarness.channels).toHaveLength(3);
  await expect.element(screen.getByLabelText("Offline")).toBeVisible();
  await screen.getByRole("button", { name: "Try again" }).click();
  await flushMicrotasks();
  expect(channelHarness.channels).toHaveLength(4);
  expect(channelHarness.channels[3]?.channelId).toBe(firstChannel?.channelId);
  await screen.unmount();
});

test("does not rebuild the session channel for metadata-only endpoint updates or stale callbacks", async () => {
  const screen = await renderOnlineApp();
  const relay = relayHarness.instances[0];
  const firstChannel = channelHarness.channels[0];
  expect(firstChannel).toBeDefined();
  relay?.emitControl({ type: "endpoint_updated", device_id: "owner-device-key", endpoint_id: "daemon-endpoint", runtime_instance_id: "runtime-1", metadata: { kind: "daemon", name: "Renamed daemon", cwd: "/workspace", working: true } });
  await flushMicrotasks();
  expect(channelHarness.channels).toHaveLength(1);

  firstChannel?.emit(readyFrame(firstChannel, "session-1"));
  await flushMicrotasks();
  firstChannel?.emit({ protocol_version: 2, type: "bye", session_id: "session-1", history_generation: "generation-session-1", reason: "session_replaced" });
  await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(2));
  const secondChannel = channelHarness.channels[1];
  secondChannel?.emit(readyFrame(secondChannel, "session-2"));
  await flushMicrotasks();
  secondChannel?.emit({ protocol_version: 2, type: "bye", session_id: "session-1", history_generation: "generation-session-1", reason: "peer_stop" });
  await flushMicrotasks();
  expect(channelHarness.channels).toHaveLength(2);
  await screen.unmount();
});

test("persists the paired endpoint and restores it after remount", async () => {
  const db = await openPwaDatabase();
  await Promise.all([
    db.devices.clear(),
    db.endpoints.clear(),
    db.settings.clear(),
  ]);
  const token = encodeBase64(new Uint8Array(16), "url");
  const deviceBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const deviceId = encodeBase64(deviceBytes, "url");
  const normalizedDeviceId = encodeBase64(deviceBytes, "standard");
  const endpointId = "123e4567-e89b-42d3-a456-426614174001";
  const runtimeInstanceId = "123e4567-e89b-42d3-a456-426614174002";
  const pairingUri = `remotepi://pair?t=${token}&epk=${deviceId}&n=Test&ep=${endpointId}&rt=${runtimeInstanceId}`;
  const firstRender = await renderPwa(<PwaApp />);

  await firstRender.getByRole("button", { name: "Pair a Pi" }).first().click();
  await firstRender.getByRole("textbox", { name: "Pairing code" }).fill(pairingUri);
  await firstRender.getByRole("button", { name: "Use pasted code" }).click();
  await expect.element(firstRender.getByRole("button", { name: /^Pi on paired-host Device key/i })).toBeVisible();

  const activeEndpointKey = `active_endpoint:${makePwaDeviceId(normalizedDeviceId)}`;
  expect((await db.settings.get(activeEndpointKey))?.value).toBe(endpointId);
  await db.endpoints.put({
    id: makePwaEndpointId(normalizedDeviceId, endpointId),
    deviceId: normalizedDeviceId,
    endpointId,
    runtimeInstanceId,
    kind: "daemon",
    name: "Restored daemon",
    cwd: "/workspace",
    updatedAt: Date.now(),
  });

  await firstRender.unmount();
  const secondRender = await renderPwa(<PwaApp />);
  await expect.element(secondRender.getByRole("heading", { name: "Restored daemon" })).toBeVisible();
});
