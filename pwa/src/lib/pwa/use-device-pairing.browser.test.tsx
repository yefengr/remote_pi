import { useEffect } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderPwa } from "@/test/browser/render";
import { encodeBase64 } from "@/lib/remote-pi/encoding";
import type { ClientFrame, ServerFrame } from "@/lib/remote-pi/protocol-v2/frames";
import type { OwnerKeyPair } from "@/lib/remote-pi/types";
import type { DevicePairingController, DevicePairingResult } from "./use-device-pairing";
import { useDevicePairing } from "./use-device-pairing";

const relayHarness = vi.hoisted(() => ({
  instances: [] as Array<{ state: string; connectCalls: number; closeCalls: number; emitClose: () => void }>,
  nextConnectRejects: 0,
}));
const channelHarness = vi.hoisted(() => ({
  channels: [] as Array<{
    pairRequestFrames: Array<Extract<ClientFrame, { type: "pair_request" }>>;
    closeCalls: number;
    emitPairOk: (frame: Extract<ServerFrame, { type: "pair_ok" }>) => void;
    emitPairError: (frame: Extract<ServerFrame, { type: "pair_error" }>) => void;
    emitMalformed: (reason: string) => void;
  }>,
  nextSendResults: [] as boolean[],
}));

type PairOkFrame = Extract<ServerFrame, { type: "pair_ok" }>;
type PairErrorFrame = Extract<ServerFrame, { type: "pair_error" }>;

type RelayInstance = { state: string; connectCalls: number; closeCalls: number; emitClose: () => void };

vi.mock("@/lib/remote-pi/relay-client", () => ({
  RelayClient: class {
    state = "idle";
    connectCalls = 0;
    closeCalls = 0;
    connectRejects = 0;
    closeListeners = new Set<() => void>();

    constructor() {
      this.connectRejects = relayHarness.nextConnectRejects;
      relayHarness.nextConnectRejects = 0;
      relayHarness.instances.push(this as RelayInstance);
    }

    on(event: string, callback: () => void) {
      if (event === "close") this.closeListeners.add(callback);
      return () => this.closeListeners.delete(callback);
    }

    async connect() {
      this.connectCalls += 1;
      if (this.connectRejects > 0) {
        this.connectRejects -= 1;
        this.state = "closed";
        throw new Error("Relay connection failed.");
      }
      this.state = "open";
    }

    sendRoute() {
      return this.state === "open";
    }

    close() {
      this.closeCalls += 1;
      this.state = "closed";
    }

    emitClose() {
      this.state = "closed";
      for (const callback of this.closeListeners) callback();
    }
  },
}));

vi.mock("@/lib/remote-pi/peer-channel", () => ({
  PeerChannel: class {
    private readonly channel: (typeof channelHarness.channels)[number];

    constructor(options: {
      onPairOk?: (frame: PairOkFrame) => void;
      onPairError?: (frame: PairErrorFrame) => void;
      onMalformed?: (reason: string) => void;
    }) {
      this.channel = {
        pairRequestFrames: [],
        closeCalls: 0,
        emitPairOk: (frame) => options.onPairOk?.(frame),
        emitPairError: (frame) => options.onPairError?.(frame),
        emitMalformed: (reason) => options.onMalformed?.(reason),
      };
      channelHarness.channels.push(this.channel);
    }

    sendPairRequest(frame: Extract<ClientFrame, { type: "pair_request" }>) {
      const sendResult = channelHarness.nextSendResults.shift() ?? true;
      if (!sendResult) return false;
      this.channel.pairRequestFrames.push(frame);
      return true;
    }

    close() {
      this.channel.closeCalls += 1;
    }
  },
}));

const identity: OwnerKeyPair = { privateKey: new Uint8Array(32), publicKey: new Uint8Array(32) };
const relayUrl = "https://relay.example.test";
const endpointId = "123e4567-e89b-42d3-a456-426614174001";
const runtimeInstanceId = "123e4567-e89b-42d3-a456-426614174002";
const token = encodeBase64(new Uint8Array(16), "url");
const deviceIdBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const deviceId = encodeBase64(deviceIdBytes, "url");
const normalizedDeviceId = encodeBase64(deviceIdBytes, "standard");

function pairingUri(pairRelayUrl = relayUrl): string {
  return `remotepi://pair?t=${token}&epk=${deviceId}&n=Test&ep=${endpointId}&rt=${runtimeInstanceId}&r=${encodeURIComponent(pairRelayUrl)}`;
}

type PairingHarnessProps = {
  onController: (controller: DevicePairingController) => void;
  onPaired: (result: DevicePairingResult) => Promise<void>;
  onError: (message: string | null) => void;
};

function PairingHarness({ onController, onPaired, onError }: PairingHarnessProps) {
  const controller = useDevicePairing({ identity, relayUrl, onPaired, onError });
  useEffect(() => { onController(controller); }, [controller, onController]);
  return <output data-testid="pairing-state">{controller.state}</output>;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function renderController(onPaired: (result: DevicePairingResult) => Promise<void>) {
  let current: DevicePairingController | null = null;
  const errors: Array<string | null> = [];
  const screen = await renderPwa(<PairingHarness onController={(controller) => { current = controller; }} onPaired={onPaired} onError={(message) => { errors.push(message); }} />);
  await vi.waitFor(() => expect(current).not.toBeNull());
  return {
    screen,
    errors,
    controller: () => {
      if (!current) throw new Error("Pairing controller did not mount.");
      return current;
    },
  };
}

beforeEach(() => {
  relayHarness.instances.length = 0;
  relayHarness.nextConnectRejects = 0;
  channelHarness.channels.length = 0;
  channelHarness.nextSendResults.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

test("opens scanning and keeps invalid or mismatched QR errors without transport", async () => {
  const { controller, errors, screen } = await renderController(async () => undefined);
  try {
    controller().open();
    await vi.waitFor(() => expect(controller().state).toBe("scanning"));

    await controller().pairFromQr("not-a-pairing-uri");
    expect(controller().state).toBe("scanning");
    expect(errors.at(-1)).toBe("That is not a valid endpoint pairing QR.");

    await controller().pairFromQr(pairingUri("https://other-relay.example.test"));
    expect(controller().state).toBe("scanning");
    expect(errors.at(-1)).toBe("This QR belongs to a different Relay.");
    expect(relayHarness.instances).toHaveLength(0);
    expect(channelHarness.channels).toHaveLength(0);
  } finally {
    await screen.unmount();
  }
});

test("pairs a device, waits for onPaired, and cleans up temporary transport", async () => {
  let releasePaired!: () => void;
  let pairedResult: DevicePairingResult | undefined;
  const onPaired = vi.fn(async (result: DevicePairingResult) => {
    pairedResult = result;
    await new Promise<void>((resolve) => { releasePaired = resolve; });
  });
  const { controller, screen } = await renderController(onPaired);
  try {
    controller().open();
    const pairing = controller().pairFromQr(pairingUri());
    await expect.element(screen.getByTestId("pairing-state")).toHaveTextContent("pairing");
    expect(relayHarness.instances).toHaveLength(1);
    expect(channelHarness.channels).toHaveLength(1);
    const relay = relayHarness.instances[0];
    const channel = channelHarness.channels[0];
    expect(relay?.connectCalls).toBe(1);
    expect(channel?.pairRequestFrames[0]).toMatchObject({ type: "pair_request", token });

    channel?.emitPairOk({ protocol_version: 2, type: "pair_ok", in_reply_to: channel.pairRequestFrames[0]?.id ?? "missing-request", session_name: "test-session", session_started_at: Date.now(), endpoint_id: endpointId, hostname: "paired-host", harness: { name: "pi", version: "1.0.0" } });
    await vi.waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
    expect(controller().state).toBe("pairing");

    releasePaired();
    await pairing;
    await vi.waitFor(() => expect(controller().state).toBe("idle"));
    expect(pairedResult).toMatchObject({ endpointId, device: { id: encodeURIComponent(normalizedDeviceId), deviceId: normalizedDeviceId, relayUrl, hostname: "paired-host", harness: { name: "pi", version: "1.0.0" } } });
    expect(channel?.closeCalls).toBe(1);
    expect(relay?.closeCalls).toBe(1);
  } finally {
    await screen.unmount();
  }
});

test("retries a sent request with the same id after Relay disconnect", async () => {
  const onPaired = vi.fn<(result: DevicePairingResult) => Promise<void>>(async () => undefined);
  const { controller, screen } = await renderController(onPaired);
  try {
    controller().open();
    const pairing = controller().pairFromQr(pairingUri());
    await vi.waitFor(() => expect(channelHarness.channels[0]?.pairRequestFrames).toHaveLength(1));
    const firstRequest = channelHarness.channels[0]!.pairRequestFrames[0]!;

    relayHarness.instances[0]!.emitClose();
    await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(2));
    await vi.waitFor(() => expect(channelHarness.channels[1]?.pairRequestFrames).toHaveLength(1));
    const secondRequest = channelHarness.channels[1]!.pairRequestFrames[0]!;
    expect(secondRequest).toEqual(firstRequest);

    channelHarness.channels[1]!.emitPairOk({ protocol_version: 2, type: "pair_ok", in_reply_to: secondRequest.id, session_name: "recovered", session_started_at: Date.now(), endpoint_id: endpointId, hostname: "paired-host" });
    await pairing;

    expect(onPaired).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(controller().state).toBe("idle"));
    expect(channelHarness.channels[0]?.closeCalls).toBe(1);
    expect(relayHarness.instances[0]?.closeCalls).toBe(1);
  } finally {
    await screen.unmount();
  }
});

test("ignores a late response for a different pairing request", async () => {
  const onPaired = vi.fn<(result: DevicePairingResult) => Promise<void>>(async () => undefined);
  const { controller, screen } = await renderController(onPaired);
  try {
    controller().open();
    const pairing = controller().pairFromQr(pairingUri());
    await vi.waitFor(() => expect(channelHarness.channels[0]?.pairRequestFrames).toHaveLength(1));
    const channel = channelHarness.channels[0]!;
    const request = channel.pairRequestFrames[0]!;
    channel.emitPairOk({ protocol_version: 2, type: "pair_ok", in_reply_to: "stale-request", session_name: "stale", session_started_at: Date.now(), endpoint_id: endpointId });
    expect(onPaired).not.toHaveBeenCalled();
    channel.emitPairOk({ protocol_version: 2, type: "pair_ok", in_reply_to: request.id, session_name: "current", session_started_at: Date.now(), endpoint_id: endpointId });
    await pairing;
    expect(onPaired).toHaveBeenCalledTimes(1);
  } finally {
    await screen.unmount();
  }
});

test("cancels and cleans an active attempt before starting a newer pairing", async () => {
  vi.useFakeTimers();
  const onPaired = vi.fn<(result: DevicePairingResult) => Promise<void>>(async () => undefined);
  const { controller, errors, screen } = await renderController(onPaired);
  try {
    controller().open();
    const firstPairing = controller().pairFromQr(pairingUri());
    await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(1));
    const firstChannel = channelHarness.channels[0];
    const firstRelay = relayHarness.instances[0];

    const secondPairing = controller().pairFromQr(pairingUri());
    await vi.waitFor(() => expect(channelHarness.channels).toHaveLength(2));
    const secondChannel = channelHarness.channels[1];
    const secondRelay = relayHarness.instances[1];
    await firstPairing;

    expect(firstChannel?.closeCalls).toBe(1);
    expect(firstRelay?.closeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    firstChannel?.emitPairOk({ protocol_version: 2, type: "pair_ok", in_reply_to: "cancelled-request", session_name: "cancelled-session", session_started_at: Date.now(), endpoint_id: endpointId, hostname: "cancelled-host" });
    expect(onPaired).not.toHaveBeenCalled();
    expect(errors.filter((message) => message !== null)).toEqual([]);

    const secondRequestId = secondChannel?.pairRequestFrames[0]?.id ?? "missing-request";
    secondChannel?.emitPairOk({ protocol_version: 2, type: "pair_ok", in_reply_to: secondRequestId, session_name: "current-session", session_started_at: Date.now(), endpoint_id: endpointId, hostname: "current-host" });
    await secondPairing;

    expect(onPaired).toHaveBeenCalledTimes(1);
    expect(onPaired.mock.calls[0]?.[0].device.hostname).toBe("current-host");
    expect(controller().state).toBe("idle");
    expect(secondChannel?.closeCalls).toBe(1);
    expect(secondRelay?.closeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await screen.unmount();
    vi.useRealTimers();
  }
});

test("returns to scanning and cleans up after endpoint mismatch and pair error", async () => {
  const { controller, errors, screen } = await renderController(async () => undefined);
  try {
    controller().open();
    const mismatchPairing = controller().pairFromQr(pairingUri());
    const mismatchChannel = channelHarness.channels[0];
    expect(mismatchChannel).toBeDefined();
    await flushMicrotasks();
    mismatchChannel?.emitPairOk({ protocol_version: 2, type: "pair_ok", in_reply_to: mismatchChannel.pairRequestFrames[0]?.id ?? "missing-request", session_name: "test-session", session_started_at: Date.now(), endpoint_id: "123e4567-e89b-42d3-a456-426614174099" });
    await mismatchPairing;
    await vi.waitFor(() => expect(controller().state).toBe("scanning"));
    expect(errors.at(-1)).toBe("Pairing response belongs to a different endpoint.");
    expect(mismatchChannel?.closeCalls).toBe(1);
    expect(relayHarness.instances[0]?.closeCalls).toBe(1);

    const errorPairing = controller().pairFromQr(pairingUri());
    const errorChannel = channelHarness.channels[1];
    expect(errorChannel).toBeDefined();
    await flushMicrotasks();
    errorChannel?.emitPairError({ protocol_version: 2, type: "pair_error", in_reply_to: errorChannel.pairRequestFrames[0]?.id ?? "missing-request", code: "internal_error", message: "Pairing rejected by Pi." });
    await errorPairing;
    await vi.waitFor(() => expect(controller().state).toBe("scanning"));
    expect(errors.at(-1)).toBe("Pairing rejected by Pi.");
    expect(errorChannel?.closeCalls).toBe(1);
    expect(relayHarness.instances[1]?.closeCalls).toBe(1);

    const malformedPairing = controller().pairFromQr(pairingUri());
    const malformedChannel = channelHarness.channels[2];
    expect(malformedChannel).toBeDefined();
    await flushMicrotasks();
    malformedChannel?.emitMalformed("Malformed pairing route.");
    await malformedPairing;
    await vi.waitFor(() => expect(controller().state).toBe("scanning"));
    expect(errors.at(-1)).toBe("Malformed pairing route.");
    expect(malformedChannel?.closeCalls).toBe(1);
    expect(relayHarness.instances[2]?.closeCalls).toBe(1);
  } finally {
    await screen.unmount();
  }
});

test("clears pairing timeout after connect and send failures", async () => {
  vi.useFakeTimers();
  relayHarness.nextConnectRejects = 1;
  const { controller, errors, screen } = await renderController(async () => undefined);
  try {
    controller().open();
    await controller().pairFromQr(pairingUri());
    expect(errors.at(-1)).toBe("Relay connection failed.");
    expect(relayHarness.instances[0]?.closeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    channelHarness.nextSendResults.push(false);
    controller().open();
    await controller().pairFromQr(pairingUri());
    expect(errors.at(-1)).toBe("Relay is not ready for pairing.");
    expect(relayHarness.instances[1]?.closeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await screen.unmount();
    vi.useRealTimers();
  }
});

test("cleans an active pairing attempt when the hook unmounts", async () => {
  const onPaired = vi.fn(async () => undefined);
  const { controller, errors, screen } = await renderController(onPaired);
  controller().open();
  const pairing = controller().pairFromQr(pairingUri());
  const channel = channelHarness.channels[0];
  const relay = relayHarness.instances[0];
  await expect.element(screen.getByTestId("pairing-state")).toHaveTextContent("pairing");

  await screen.unmount();
  channel?.emitPairOk({ protocol_version: 2, type: "pair_ok", in_reply_to: "late-response", session_name: "test-session", session_started_at: Date.now(), endpoint_id: endpointId, hostname: "paired-host" });
  await pairing;

  expect(onPaired).not.toHaveBeenCalled();
  expect(errors.filter((message) => message !== null)).toEqual([]);
  expect(channel?.closeCalls).toBe(1);
  expect(relay?.closeCalls).toBe(1);
});

test("cancels an active pairing attempt when the dialog is closed", async () => {
  vi.useFakeTimers();
  const onPaired = vi.fn<(result: DevicePairingResult) => Promise<void>>(async () => undefined);
  const { controller, errors, screen } = await renderController(onPaired);
  try {
    controller().open();
    const pairing = controller().pairFromQr(pairingUri());
    await vi.waitFor(() => expect(channelHarness.channels[0]?.pairRequestFrames).toHaveLength(1));
    const channel = channelHarness.channels[0]!;
    const relay = relayHarness.instances[0]!;
    const requestId = channel.pairRequestFrames[0]!.id;

    controller().close();
    await pairing;
    await expect.element(screen.getByTestId("pairing-state")).toHaveTextContent("idle");
    vi.advanceTimersByTime(30_000);
    await flushMicrotasks();

    expect(channel.closeCalls).toBe(1);
    expect(relay.closeCalls).toBe(1);
    expect(channelHarness.channels).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    channel.emitPairOk({ protocol_version: 2, type: "pair_ok", in_reply_to: requestId, session_name: "late", session_started_at: Date.now(), endpoint_id: endpointId });
    expect(onPaired).not.toHaveBeenCalled();
    expect(errors.filter((message) => message !== null)).toEqual([]);
  } finally {
    await screen.unmount();
    vi.useRealTimers();
  }
});

test("retries an already-sent request once after timeout, then stops", async () => {
  vi.useFakeTimers();
  const { controller, errors, screen } = await renderController(async () => undefined);
  try {
    controller().open();
    const pairing = controller().pairFromQr(pairingUri());
    await vi.waitFor(() => expect(channelHarness.channels[0]?.pairRequestFrames).toHaveLength(1));
    const firstChannel = channelHarness.channels[0]!;
    const firstRelay = relayHarness.instances[0]!;
    const firstRequest = firstChannel.pairRequestFrames[0]!;

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(channelHarness.channels[1]?.pairRequestFrames).toHaveLength(1));
    const secondChannel = channelHarness.channels[1]!;
    const secondRelay = relayHarness.instances[1]!;
    expect(secondChannel.pairRequestFrames[0]).toEqual(firstRequest);
    expect(firstChannel.closeCalls).toBe(1);
    expect(firstRelay.closeCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(15_000);
    await pairing;
    await expect.element(screen.getByTestId("pairing-state")).toHaveTextContent("scanning");
    expect(errors.at(-1)).toBe("Pairing timed out. Generate a fresh QR on the Pi.");
    expect(channelHarness.channels).toHaveLength(2);
    expect(secondChannel.closeCalls).toBe(1);
    expect(secondRelay.closeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await screen.unmount();
    vi.useRealTimers();
  }
});
