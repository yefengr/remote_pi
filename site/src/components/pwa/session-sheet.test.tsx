import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionSheet } from "./session-sheet";
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
];

test("labels rooms as sessions and keeps offline history read-only", () => {
  const html = renderToStaticMarkup(
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
    />,
  );

  assert.match(html, /Pairing records/);
  assert.match(html, /Sessions in/);
  assert.match(html, /ONLINE/);
  assert.match(html, /OFFLINE/);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /Rooms in/);
});
