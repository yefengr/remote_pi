import { beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { generateOwnerKeyPair } from "@/lib/remote-pi/crypto";
import { encodeBase64 } from "@/lib/remote-pi/encoding";
import { toStoredKey } from "@/lib/pwa/runtime";
import { makePwaDeviceId, makePwaEndpointId, openPwaDatabase } from "@/lib/pwa/db";
import { PwaApp } from "./pwa-app";

const relayHarness = vi.hoisted(() => ({
  instances: [] as Array<{ closeCalls: number }>,
}));

vi.mock("@/lib/remote-pi/relay-client", () => ({
  RelayClient: class {
    state = "idle" as "idle" | "open";
    closeCalls = 0;

    constructor() {
      relayHarness.instances.push(this);
    }

    on() {
      return () => undefined;
    }

    async connect() {
      this.state = "open";
    }

    subscribeEndpoints() {
      return true;
    }

    sendControl() {
      return false;
    }

    sendRoute() {
      return false;
    }

    close() {
      this.closeCalls += 1;
    }
  },
}));

vi.mock("@/lib/remote-pi/peer-channel", () => ({
  PeerChannel: class {
    readonly channelId = "test-channel";

    constructor(private readonly options: {
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
    }) {}

    send(frame: { type: string; id: string }) {
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

    close() {}
  },
}));

beforeEach(async () => {
  relayHarness.instances.length = 0;
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
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(relayHarness.instances).toHaveLength(1);
  expect(relayHarness.instances[0]?.closeCalls).toBe(0);
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
