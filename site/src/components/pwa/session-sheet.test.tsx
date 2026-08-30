import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionSheet } from "./session-sheet";
import { PwaUiProvider } from "./pwa-ui-provider";
import type { PwaDeviceRecord, PwaEndpointRecord } from "@/lib/pwa/db";

const device: PwaDeviceRecord = {
  id: "device:main",
  deviceId: "e5FRoCabBqVX",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-01T00:00:00.000Z",
  hostname: "office",
};

const endpoints: PwaEndpointRecord[] = [
  { id: "endpoint-main", deviceId: device.deviceId, endpointId: "main", runtimeInstanceId: "runtime-main", kind: "daemon", cwd: "/work/remote-pi", online: true, updatedAt: 1 },
  { id: "endpoint-old", deviceId: device.deviceId, endpointId: "old", runtimeInstanceId: "runtime-old", kind: "interactive", cwd: "/work/old", online: false, updatedAt: 2 },
  { id: "endpoint-checking", deviceId: device.deviceId, endpointId: "checking", runtimeInstanceId: "runtime-checking", kind: "daemon", cwd: "/work/checking", updatedAt: 3 },
];

test("labels endpoints and keeps offline history read-only", () => {
  const html = renderToStaticMarkup(
    <PwaUiProvider>
      <SessionSheet
        devices={[device]}
        endpoints={endpoints}
        activeDeviceId={device.id}
        activeEndpointId="main"
        pairingPresence={{ [device.id]: { status: "partial", onlineEndpoints: 1, totalEndpoints: 2 } }}
        onSelectDevice={() => {}}
        onSelectEndpoint={() => {}}
        onPair={() => {}}
        onRename={() => {}}
        onRemove={() => {}}
        onClose={() => {}}
        withinPortal={false}
      />
    </PwaUiProvider>
  );

  const pairButton = html.match(/<button[^>]*>.*?Pair a Pi.*?<\/button>/)?.[0] ?? "";
  const renameAction = html.match(/<button[^>]*aria-label="Rename Pi on office"[^>]*>/)?.[0] ?? "";
  const deleteAction = html.match(/<button[^>]*aria-label="Delete Pi on office"[^>]*>/)?.[0] ?? "";

  assert.match(html, /mantine-Drawer-root/);
  assert.match(html, /pwa-badge/);
  assert.match(pairButton, /pwa-button/);
  assert.match(pairButton, /data-tone="secondary"/);
  assert.match(renameAction, /pwa-icon-button/);
  assert.match(renameAction, /title="Rename pairing"/);
  assert.match(deleteAction, /pwa-icon-button/);
  assert.match(deleteAction, /title="Delete pairing"/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /Paired devices/);
  assert.match(html, /Endpoints on Pi on office/);
  assert.match(html, /CURRENT/);
  assert.match(html, /ONLINE/);
  assert.match(html, /OFFLINE/);
  assert.match(html, /CHECKING/);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /Rooms in/);
});
