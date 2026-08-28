import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopSidebar, displayPeer } from "./workspace-view";
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
        peers={[peer()]}
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

  assert.match(html, /OFFLINE/);
  assert.match(html, /CURRENT/);
  assert.match(html, /mantine-Badge-root/);
  assert.match(html, /Pairing records/);
  assert.doesNotMatch(html, />XCrawl#2</);
});
