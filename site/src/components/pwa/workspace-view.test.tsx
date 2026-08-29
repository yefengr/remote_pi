import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopSidebar, displayPeer, EmptyWorkspace } from "./workspace-view";
import { PwaUiProvider } from "./pwa-ui-provider";
import type { PwaPeerRecord } from "@/lib/pwa/db";

function peer(overrides: Partial<PwaPeerRecord> = {}): PwaPeerRecord {
  return {
    id: "peer:main",
    remoteEpk: "e5FRoCabBqVX",
    sessionName: "XCrawl#2",
    relayUrl: "https://relay.example.test",
    pairedAt: "2026-01-01T00:00:00.000Z",
    roomId: "main",
    ...overrides,
  };
}

test("pairing display name prefers local nickname, then host, then stable key", () => {
  assert.equal(displayPeer(peer({ nickname: "Office Mac", hostname: "office" })), "Office Mac");
  assert.equal(displayPeer(peer({ hostname: "office" })), "Pi on office");
  assert.equal(displayPeer(peer()), "Remote Pi · e5FRoCab");
  assert.notEqual(displayPeer(peer()), "XCrawl#2");
});

test("pairing card keeps current selection separate from online status", () => {
  const html = renderToStaticMarkup(
    <PwaUiProvider>
      <DesktopSidebar
        peers={[peer({ nickname: "Office Mac" })]}
        activePeerId="peer:main"
        pairingPresence={{ "peer:main": { status: "offline", onlineSessions: 0, totalSessions: 1 } }}
        onPair={() => {}}
        onSelect={() => {}}
        onRename={() => {}}
        onRemove={() => {}}
        onClearData={async () => {}}
      />
    </PwaUiProvider>,
  );
  const renameAction = html.match(/<button[^>]*aria-label="Rename Office Mac"[^>]*>/)?.[0] ?? "";
  const removeAction = html.match(/<button[^>]*aria-label="Remove Office Mac"[^>]*>/)?.[0] ?? "";
  const clearButton = html.match(/<button[^>]*class="[^"]*pwa-button[^"]*"[^>]*data-tone="text"[^>]*>/)?.[0] ?? "";

  assert.match(html, /OFFLINE/);
  assert.match(html, /CURRENT/);
  assert.match(html, /pwa-badge/);
  assert.match(html, /Pairing records/);
  assert.match(renameAction, /pwa-icon-button/);
  assert.match(renameAction, /title="Rename pairing"/);
  assert.match(removeAction, /pwa-icon-button/);
  assert.match(removeAction, /title="Remove pairing"/);
  assert.match(clearButton, /pwa-button/);
  assert.match(clearButton, /data-tone="text"/);
  assert.doesNotMatch(html, />XCrawl#2</);
});

test("uses Mantine actions for pairing entry points", () => {
  const sidebarHtml = renderToStaticMarkup(
    <PwaUiProvider>
      <DesktopSidebar peers={[]} activePeerId={null} onPair={() => {}} onSelect={() => {}} onRename={() => {}} onRemove={() => {}} onClearData={async () => {}} />
    </PwaUiProvider>,
  );
  const emptyWorkspaceHtml = renderToStaticMarkup(<PwaUiProvider><EmptyWorkspace onPair={() => {}} /></PwaUiProvider>);
  const roundAction = sidebarHtml.match(/<button[^>]*aria-label="Pair a Pi"[^>]*>/)?.[0] ?? "";

  assert.match(roundAction, /pwa-icon-button/);
  assert.match(roundAction, /title="Pair a Pi"/);
  assert.match(sidebarHtml, /pwa-button/);
  assert.match(sidebarHtml, /data-tone="primary"/);
  assert.match(emptyWorkspaceHtml, /pwa-button/);
  assert.match(emptyWorkspaceHtml, /data-tone="primary"/);
  assert.match(emptyWorkspaceHtml, /Pair a Pi/);
});
