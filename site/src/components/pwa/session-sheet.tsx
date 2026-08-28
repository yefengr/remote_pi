"use client";

import { ActionIcon, Badge, Button, Drawer } from "@mantine/core";
import { MessageSquare, Pencil, Plus, Trash2 } from "lucide-react";
import { displayPeer, type PairingPresence, type PairingStatus } from "@/components/pwa/workspace-view";
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
  withinPortal?: boolean;
};

function pairingStatusLabel(status: PairingStatus): string {
  return status.toUpperCase();
}

function sessionLabel(session: PwaRoomRecord): string {
  const cwd = session.cwd?.replace(/[\\/]$/, "");
  const folder = cwd?.split(/[\\/]/).filter(Boolean).pop();
  return folder ? `Session · ${folder}` : "Session";
}

export function SessionSheet({ peers, rooms, activePeerId, activeRoomId, pairingPresence = {}, onSelectPeer, onSelectRoom, onPair, onRename, onRemove, onClose, withinPortal = true }: SessionSheetProps) {

  const activePeer = peers.find((peer) => peer.id === activePeerId);
  const activeSessions = activePeer
    ? rooms.filter((session) => session.peerEpk === activePeer.remoteEpk).sort((a, b) => (a.name || a.cwd || a.roomId).localeCompare(b.name || b.cwd || b.roomId))
    : [];
  const distinctPresence = new Map<string, PairingPresence>();
  for (const peer of peers) {
    const presence = pairingPresence[peer.id];
    if (presence && !distinctPresence.has(peer.remoteEpk)) distinctPresence.set(peer.remoteEpk, presence);
  }
  const onlineSessionCount = [...distinctPresence.values()].reduce((count, presence) => count + presence.onlineSessions, 0);
  const totalSessionCount = [...distinctPresence.values()].reduce((count, presence) => count + presence.totalSessions, 0);
  const onlinePairingCount = [...distinctPresence.values()].filter((presence) => presence.status === "online" || presence.status === "partial").length;
  const offlinePairingCount = [...distinctPresence.values()].filter((presence) => presence.status === "offline").length;
  const checkingPairingCount = [...distinctPresence.values()].filter((presence) => presence.status === "checking").length;
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
      onClose={onClose}
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
      <Drawer.Content role="dialog" aria-modal="true" aria-labelledby="pwa-session-sheet-title">
        <Drawer.Header>
          <div><span className="pwa-kicker">Pairing records · {peers.length}</span><Drawer.Title id="pwa-session-sheet-title">Sessions</Drawer.Title><p className="pwa-sheet-summary"><span className="pwa-summary-online">{onlinePairingCount} ONLINE</span><span>·</span><span>{offlinePairingCount} OFFLINE</span>{checkingPairingCount ? <><span>·</span><span>{checkingPairingCount} CHECKING</span></> : null}<small>{onlineSessionCount} of {totalSessionCount} sessions online</small></p></div>
          <Drawer.CloseButton aria-label="Close sessions" title="Close sessions" />
        </Drawer.Header>
        <Drawer.Body>
          <div className="pwa-sheet-section-head"><span>Pairing records</span><Button className="pwa-secondary-button" type="button" variant="default" onClick={() => { onPair(); onClose(); }} leftSection={<Plus size={15} />}>Pair a Pi</Button></div>
          {peers.length ? peers.map((peer) => {
            const active = peer.id === activePeerId;
            const presence = pairingPresence[peer.id];
            const status = presence?.status ?? "checking";
            const onlineSessions = presence?.onlineSessions ?? 0;
            const totalSessions = presence?.totalSessions ?? 0;
            return (
              <div className={`pwa-sheet-peer ${active ? "active" : ""}`} key={peer.id}>
                <button className="pwa-sheet-peer-select" type="button" onClick={() => choosePeer(peer.id)}>
                  <span className={`pwa-peer-icon ${status === "online" ? "online" : ""}`}><MessageSquare size={17} /></span>
                  <span className="pwa-peer-copy"><strong>{displayPeer(peer)}</strong><small className="pwa-peer-technical">Pi key {peer.remoteEpk.slice(0, 8)}…</small><span className="pwa-peer-presence"><Badge className={`pwa-presence-label ${status}`} variant="light">{pairingStatusLabel(status)}</Badge><span>{onlineSessions}/{totalSessions} SESSIONS</span></span></span>
                  {active ? <Badge className="pwa-current-label" variant="light">CURRENT</Badge> : null}
                </button>
                <ActionIcon className="pwa-peer-action" type="button" size={44} variant="subtle" onClick={() => onRename(peer)} aria-label={`Rename ${displayPeer(peer)}`} title="Rename pairing"><Pencil size={16} /></ActionIcon>
                <ActionIcon className="pwa-peer-remove" type="button" size={44} variant="subtle" onClick={() => onRemove(peer)} aria-label={`Delete ${displayPeer(peer)}`} title="Delete pairing"><Trash2 size={16} /></ActionIcon>
              </div>
            );
          }) : <p className="pwa-muted">No pairing records yet.</p>}
          {activePeer ? (
            <div className="pwa-sheet-rooms">
              <div className="pwa-sheet-section-head"><span>Sessions in {displayPeer(activePeer)}</span></div>
              {activeSessions.length === 0 ? <p className="pwa-muted pwa-sheet-empty">No sessions have been discovered for this pairing.</p> : <>
                {!activeSessions.some((session) => session.online) ? <p className="pwa-muted pwa-sheet-empty">No sessions are online right now.</p> : null}
                {activeSessions.map((session) => {
                  const active = activeRoomId === session.roomId;
                  const online = session.online === true;
                  const checking = session.online === undefined;
                  const selectable = online && !active;
                  const status = checking ? "checking" : online ? "online" : "offline";
                  return <button className={`pwa-sheet-room ${active ? "active" : ""} ${!selectable ? "disabled" : ""}`} key={session.id} type="button" disabled={!selectable} aria-disabled={!selectable} title={active ? "Current session is read-only here" : checking ? "Checking session status" : online ? undefined : "This session is offline"} onClick={() => chooseSession(session.roomId)}><span className="pwa-sheet-session-copy"><strong>{sessionLabel(session)}</strong><small><Badge className={`pwa-presence-label ${status}`} variant="light">{status.toUpperCase()}</Badge>{session.cwd ? <span className="pwa-sheet-session-cwd">{session.cwd}</span> : null}<code>session ID {session.roomId}</code></small></span>{active ? <Badge className="pwa-current-label" variant="light">CURRENT</Badge> : null}</button>;
                })}
              </>}
            </div>
          ) : null}
        </Drawer.Body>
      </Drawer.Content>
    </Drawer.Root>
  );
}
