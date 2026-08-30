"use client";

import { useRef } from "react";
import { Drawer } from "@mantine/core";
import { Button } from "@/components/ui";
import { Plus } from "lucide-react";
import { PairingRecordCard } from "@/components/pwa/pairing-record-card";
import { selectActiveSessionRows, displayPeer, selectPairingRecord, selectPairingSummary, type PairingPresence } from "@/components/pwa/pwa-view-model";
import { SessionList } from "@/components/pwa/session-list";
import type { PwaPeerRecord, PwaRoomRecord } from "@/lib/pwa/db";

type SessionSheetProps = {
  peers: PwaPeerRecord[];
  rooms: PwaRoomRecord[];
  activePeerId: string | null;
  activeRoomId: string;
  pairingPresence?: Record<string, PairingPresence>;
  onSelectPeer: (peerId: string) => void;
  onSelectRoom: (roomId: string) => void;
  onPair: () => void;
  onRename: (peer: PwaPeerRecord) => void;
  onRemove: (peer: PwaPeerRecord) => void;
  onClose: () => void;
  focusOrigin?: HTMLElement | null;
  withinPortal?: boolean;
};

export function SessionSheet({ peers, rooms, activePeerId, activeRoomId, pairingPresence = {}, onSelectPeer, onSelectRoom, onPair, onRename, onRemove, onClose, focusOrigin = null, withinPortal = true }: SessionSheetProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const activePeer = peers.find((peer) => peer.id === activePeerId);
  const activeSessions = selectActiveSessionRows(rooms, activePeer?.remoteEpk, activeRoomId);
  const pairingSummary = selectPairingSummary(peers, pairingPresence);
  const closeDrawer = () => {
    const content = contentRef.current;
    onClose();
    requestAnimationFrame(() => {
      if (content?.isConnected) return;
      const activeElement = document.activeElement;
      const hasValidFocus = activeElement instanceof HTMLElement
        && activeElement !== document.body
        && activeElement !== document.documentElement
        && activeElement.isConnected;
      const canRestoreOrigin = focusOrigin?.isConnected
        && !focusOrigin.matches(":disabled")
        && focusOrigin.getClientRects().length > 0
        && !focusOrigin.closest('[aria-hidden="true"]');
      if (!hasValidFocus && canRestoreOrigin) focusOrigin.focus({ preventScroll: true });
    });
  };
  const choosePeer = (peerId: string) => {
    onSelectPeer(peerId);
    onClose();
  };
  const chooseSession = (nextRoomId: string) => {
    onSelectRoom(nextRoomId);
    onClose();
  };

  return (
    <Drawer.Root
      opened
      onClose={closeDrawer}
      position="left"
      size="min(420px, 100vw)"
      withinPortal={withinPortal}
      portalProps={{ target: ".pwa-root" }}
      zIndex={30}
      padding={0}
      classNames={{ content: "pwa-session-sheet", header: "pwa-session-sheet-head", body: "pwa-session-sheet-body", close: "pwa-icon-button" }}
      styles={{ content: { height: "100%", maxHeight: "100%", borderRadius: 0 }, header: { paddingTop: "calc(20px + var(--pwa-safe-top))" } }}
    >
      <Drawer.Overlay backgroundOpacity={0.7} blur={7} />
      <Drawer.Content ref={contentRef} role="dialog" aria-modal="true" aria-labelledby="pwa-session-sheet-title">
        <Drawer.Header>
          <div><span className="pwa-kicker">Pairing records · {peers.length}</span><Drawer.Title id="pwa-session-sheet-title">Sessions</Drawer.Title><p className="pwa-sheet-summary"><span className="pwa-summary-online">{pairingSummary.onlinePairingCount} ONLINE</span><span>·</span><span>{pairingSummary.offlinePairingCount} OFFLINE</span>{pairingSummary.checkingPairingCount ? <><span>·</span><span>{pairingSummary.checkingPairingCount} CHECKING</span></> : null}<small>{pairingSummary.onlineSessionCount} of {pairingSummary.totalSessionCount} sessions online</small></p></div>
          <Drawer.CloseButton aria-label="Close sessions" title="Close sessions" />
        </Drawer.Header>
        <Drawer.Body>
          <div className="pwa-sheet-section-head"><span>Pairing records</span><Button tone="secondary" type="button" onClick={() => { onPair(); onClose(); }} leftSection={<Plus size={15} />}>Pair a Pi</Button></div>
          {peers.length ? peers.map((peer) => <PairingRecordCard key={peer.id} viewModel={selectPairingRecord(peer, peer.id === activePeerId, pairingPresence[peer.id])} surface="sheet" onSelect={() => choosePeer(peer.id)} onRename={() => onRename(peer)} onRemove={() => onRemove(peer)} />) : <p className="pwa-muted">No pairing records yet.</p>}
          {activePeer ? (
            <div className="pwa-sheet-rooms">
              <div className="pwa-sheet-section-head"><span>Sessions in {displayPeer(activePeer)}</span></div>
              {activeSessions.length === 0 ? <p className="pwa-muted pwa-sheet-empty">No sessions have been discovered for this pairing.</p> : <>
                {!activeSessions.some((session) => session.status === "online") ? <p className="pwa-muted pwa-sheet-empty">No sessions are online right now.</p> : null}
                <SessionList sessions={activeSessions} onSelect={chooseSession} />
              </>}
            </div>
          ) : null}
        </Drawer.Body>
      </Drawer.Content>
    </Drawer.Root>
  );
}
