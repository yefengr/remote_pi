import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopSidebar, displayDevice, EmptyWorkspace } from "./workspace-view";
import { PwaUiProvider } from "./pwa-ui-provider";
import type { PwaDeviceRecord } from "@/lib/pwa/db";

function device(overrides: Partial<PwaDeviceRecord> = {}): PwaDeviceRecord {
  return {
    id: "device:main",
    deviceId: "e5FRoCabBqVX",
    relayUrl: "https://relay.example.test",
    pairedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("pairing display name prefers local nickname, then host, then stable key", () => {
  expect(displayDevice(device({ nickname: "Office Mac", hostname: "office" }))).toBe("Office Mac");
  expect(displayDevice(device({ hostname: "office" }))).toBe("Pi on office");
  expect(displayDevice(device())).toBe("Remote Pi · e5FRoCab");
});

test("pairing card keeps current selection separate from online status", () => {
  const html = renderToStaticMarkup(
    <PwaUiProvider>
      <DesktopSidebar
        devices={[device({ nickname: "Office Mac" })]}
        activeDeviceId="device:main"
        pairingPresence={{ "device:main": { status: "offline", onlineEndpoints: 0, totalEndpoints: 1 } }}
        onPair={() => {}}
        onSelect={() => {}}
        onRename={() => {}}
        onRemove={() => {}}
        onClearData={async () => {}}
      />
    </PwaUiProvider>
  );
  const renameAction = html.match(/<button[^>]*aria-label="Rename Office Mac"[^>]*>/)?.[0] ?? "";
  const removeAction = html.match(/<button[^>]*aria-label="Remove Office Mac"[^>]*>/)?.[0] ?? "";
  const clearButton = html.match(/<button[^>]*class="[^"]*pwa-button[^"]*"[^>]*data-tone="text"[^>]*>/)?.[0] ?? "";

  expect(html).toMatch(/OFFLINE/);
  expect(html).toMatch(/CURRENT/);
  expect(html).toMatch(/pwa-badge/);
  expect(html).toMatch(/Paired devices/);
  expect(renameAction).toMatch(/pwa-icon-button/);
  expect(renameAction).toMatch(/title="Rename pairing"/);
  expect(removeAction).toMatch(/pwa-icon-button/);
  expect(removeAction).toMatch(/title="Remove pairing"/);
  expect(clearButton).toMatch(/pwa-button/);
  expect(clearButton).toMatch(/data-tone="text"/);
  expect(html).not.toMatch(/>XCrawl#2</);
});

test("uses Mantine actions for pairing entry points", () => {
  const sidebarHtml = renderToStaticMarkup(
    <PwaUiProvider>
      <DesktopSidebar devices={[]} activeDeviceId={null} onPair={() => {}} onSelect={() => {}} onRename={() => {}} onRemove={() => {}} onClearData={async () => {}} />
    </PwaUiProvider>
  );
  const emptyWorkspaceHtml = renderToStaticMarkup(<PwaUiProvider><EmptyWorkspace onPair={() => {}} /></PwaUiProvider>);
  const roundAction = sidebarHtml.match(/<button[^>]*aria-label="Pair a Pi"[^>]*>/)?.[0] ?? "";

  expect(roundAction).toMatch(/pwa-icon-button/);
  expect(roundAction).toMatch(/title="Pair a Pi"/);
  expect(sidebarHtml).toMatch(/pwa-button/);
  expect(sidebarHtml).toMatch(/data-tone="primary"/);
  expect(emptyWorkspaceHtml).toMatch(/pwa-button/);
  expect(emptyWorkspaceHtml).toMatch(/data-tone="primary"/);
  expect(emptyWorkspaceHtml).toMatch(/Pair a Pi/);
});
