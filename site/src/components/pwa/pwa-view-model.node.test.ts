import { describe, expect, test } from "vitest";
import { displayPeer, selectActiveSessionRows, selectPairingSummary, type PairingPresence } from "./pwa-view-model";
import type { PwaPeerRecord, PwaRoomRecord } from "@/lib/pwa/db";

const primaryPeer: PwaPeerRecord = {
  id: "peer:primary",
  remoteEpk: "primary-public-key-1234",
  sessionName: "Primary",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-01T00:00:00.000Z",
  roomId: "main",
};

function room(overrides: Partial<PwaRoomRecord>): PwaRoomRecord {
  return { id: "room:main", peerEpk: primaryPeer.remoteEpk, roomId: "main", updatedAt: 1, ...overrides };
}

describe("PWA view model selectors", () => {
  test("uses the stable pairing display name precedence", () => {
    expect(displayPeer({ ...primaryPeer, nickname: "Office Mac", hostname: "office" })).toBe("Office Mac");
    expect(displayPeer({ ...primaryPeer, hostname: "office" })).toBe("Pi on office");
    expect(displayPeer(primaryPeer)).toBe("Remote Pi · primary-");
  });

  test("deduplicates pairing summary by first peer public key", () => {
    const duplicatePeer = { ...primaryPeer, id: "peer:archive" };
    const presence: Record<string, PairingPresence> = {
      [primaryPeer.id]: { status: "online", onlineSessions: 2, totalSessions: 3 },
      [duplicatePeer.id]: { status: "offline", onlineSessions: 50, totalSessions: 50 },
    };

    expect(selectPairingSummary([primaryPeer, duplicatePeer], presence)).toEqual({
      onlinePairingCount: 1,
      offlinePairingCount: 0,
      checkingPairingCount: 0,
      onlineSessionCount: 2,
      totalSessionCount: 3,
    });
  });

  test("filters and sorts active sessions while preserving selection rules", () => {
    const rows = selectActiveSessionRows([
      room({ id: "room:offline", roomId: "offline", name: "D offline", online: false }),
      room({ id: "room:checking", roomId: "checking", name: "C checking" }),
      room({ id: "room:other", peerEpk: "other-key", roomId: "other", name: "A other", online: true }),
      room({ id: "room:current", roomId: "current", name: "A current", online: true }),
      room({ id: "room:working", roomId: "working", name: "B working", cwd: "/work/working", online: true }),
    ], primaryPeer.remoteEpk, "current");

    expect(rows.map((row) => row.roomId)).toEqual(["current", "working", "checking", "offline"]);
    expect(rows.map(({ roomId, status, selectable, title }) => ({ roomId, status, selectable, title }))).toEqual([
      { roomId: "current", status: "online", selectable: false, title: "Current session is read-only here" },
      { roomId: "working", status: "online", selectable: true, title: undefined },
      { roomId: "checking", status: "checking", selectable: false, title: "Checking session status" },
      { roomId: "offline", status: "offline", selectable: false, title: "This session is offline" },
    ]);
  });
});
