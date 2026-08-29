import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionSheet } from "./session-sheet";
import { PwaUiProvider } from "./pwa-ui-provider";
import type { PwaPeerRecord, PwaRoomRecord } from "@/lib/pwa/db";

const peer: PwaPeerRecord = {
  id: "peer:main",
  remoteEpk: "e5FRoCabBqVX",
  sessionName: "XCrawl#2",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-01T00:00:00.000Z",
  roomId: "main",
};

const sessions: PwaRoomRecord[] = [
  { id: "peer:main", peerEpk: peer.remoteEpk, roomId: "main", cwd: "/work/remote-pi", online: true, updatedAt: 1 },
  { id: "peer:old", peerEpk: peer.remoteEpk, roomId: "old", cwd: "/work/old", online: false, updatedAt: 2 },
  { id: "peer:checking", peerEpk: peer.remoteEpk, roomId: "checking", cwd: "/work/checking", updatedAt: 3 },
];

test("labels rooms as sessions and keeps offline history read-only", () => {
  const html = renderToStaticMarkup(
    <PwaUiProvider>
      <SessionSheet
        peers={[peer]}
        rooms={sessions}
        activePeerId={peer.id}
        activeRoomId="main"
        pairingPresence={{ [peer.id]: { status: "partial", onlineSessions: 1, totalSessions: 2 } }}
        onSelectPeer={() => {}}
        onSelectRoom={() => {}}
        onPair={() => {}}
        onRename={() => {}}
        onRemove={() => {}}
        onClose={() => {}}
        withinPortal={false}
      />
    </PwaUiProvider>,
  );

  const pairButton = html.match(/<button[^>]*>.*?Pair a Pi.*?<\/button>/)?.[0] ?? "";
  const renameAction = html.match(/<button[^>]*aria-label="Rename Remote Pi · e5FRoCab"[^>]*>/)?.[0] ?? "";
  const deleteAction = html.match(/<button[^>]*aria-label="Delete Remote Pi · e5FRoCab"[^>]*>/)?.[0] ?? "";

  assert.match(html, /mantine-Drawer-root/);
  assert.match(html, /pwa-badge/);
  assert.match(pairButton, /pwa-button/);
  assert.match(pairButton, /data-tone="secondary"/);
  assert.match(renameAction, /pwa-icon-button/);
  assert.match(renameAction, /title="Rename pairing"/);
  assert.match(deleteAction, /pwa-icon-button/);
  assert.match(deleteAction, /title="Delete pairing"/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /Pairing records/);
  assert.match(html, /Sessions in/);
  assert.match(html, /CURRENT/);
  assert.match(html, /ONLINE/);
  assert.match(html, /OFFLINE/);
  assert.match(html, /CHECKING/);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /Rooms in/);
});
