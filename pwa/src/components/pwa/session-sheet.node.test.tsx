import { expect, test } from "vitest";
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

  expect(html).toMatch(/mantine-Drawer-root/);
  expect(html).toMatch(/pwa-badge/);
  expect(pairButton).toMatch(/pwa-button/);
  expect(pairButton).toMatch(/data-tone="secondary"/);
  expect(renameAction).toMatch(/pwa-icon-button/);
  expect(renameAction).toMatch(/title="Rename pairing"/);
  expect(deleteAction).toMatch(/pwa-icon-button/);
  expect(deleteAction).toMatch(/title="Delete pairing"/);
  expect(html).toMatch(/role="dialog"/);
  expect(html).toMatch(/Paired devices/);
  expect(html).toMatch(/Endpoints on Pi on office/);
  expect(html).toMatch(/CURRENT/);
  expect(html).toMatch(/ONLINE/);
  expect(html).toMatch(/OFFLINE/);
  expect(html).toMatch(/CHECKING/);
  expect(html).toMatch(/disabled=""/);
  expect(html).not.toMatch(/Rooms in/);
});
