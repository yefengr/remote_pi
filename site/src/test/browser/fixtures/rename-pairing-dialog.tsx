"use client";

import { useState } from "react";
import { RenamePairingDialog } from "@/components/pwa/rename-pairing-dialog";
import { SessionSheet } from "@/components/pwa/session-sheet";
import type { PwaPeerRecord, PwaRoomRecord } from "@/lib/pwa/db";

export const renamePeer: PwaPeerRecord = {
  id: "peer:main",
  remoteEpk: "e5FRoCabBqVX",
  sessionName: "XCrawl#2",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-01T00:00:00.000Z",
  roomId: "main",
  hostname: "office",
};

const renameRooms: PwaRoomRecord[] = [
  { id: "peer:main", peerEpk: renamePeer.remoteEpk, roomId: "main", cwd: "/work/remote-pi", online: true, updatedAt: 1 },
];

type RenameRequest = {
  peer: PwaPeerRecord;
  focusOrigin: HTMLElement | null;
};

export function SessionRenameHarness({ onSave = async () => {} }: { onSave?: (nickname: string) => Promise<void> }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [renameRequest, setRenameRequest] = useState<RenameRequest | null>(null);

  const openRename = (peer: PwaPeerRecord) => {
    setRenameRequest({
      peer,
      focusOrigin: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    });
    setSheetOpen(false);
  };

  return (
    <>
      <button type="button" aria-label="Open session switcher" onClick={() => setSheetOpen(true)}>
        Session switcher
      </button>
      {sheetOpen ? <SessionSheet peers={[renamePeer]} rooms={renameRooms} activePeerId={renamePeer.id} activeRoomId="main" onSelectPeer={() => {}} onSelectRoom={() => {}} onPair={() => {}} onRename={openRename} onRemove={() => {}} onClose={() => setSheetOpen(false)} /> : null}
      {renameRequest ? <RenamePairingDialog peer={renameRequest.peer} onSave={onSave} onClose={() => setRenameRequest(null)} focusOrigin={renameRequest.focusOrigin} focusFallbackSelectors={['button[aria-label="Open session switcher"]']} /> : null}
    </>
  );
}
