"use client";

import { useEffect, useRef } from "react";
import { MessageSquare, Pencil, Plus, Trash2, X } from "lucide-react";
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
};

function pairingStatusLabel(status: PairingStatus): string {
  return status.toUpperCase();
}

function sessionLabel(session: PwaRoomRecord): string {
  const cwd = session.cwd?.replace(/[\\/]$/, "");
  const folder = cwd?.split(/[\\/]/).filter(Boolean).pop();
  return folder ? `Session · ${folder}` : "Session";
}

export function SessionSheet({ peers, rooms, activePeerId, activeRoomId, pairingPresence = {}, onSelectPeer, onSelectRoom, onPair, onRename, onRemove, onClose }: SessionSheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")).filter((element) => !element.hasAttribute("disabled"));
      if (!focusable.length) return;
      const current = document.activeElement;
      const index = focusable.indexOf(current as HTMLElement);
      const nextIndex = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index === focusable.length - 1 ? 0 : index + 1);
      if (index < 0 || (event.shiftKey && index === 0) || (!event.shiftKey && index === focusable.length - 1)) {
        event.preventDefault();
        focusable[nextIndex]?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (dialog?.open) dialog.close();
      returnFocusRef.current?.focus();
    };
  }, [onClose]);

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
    <dialog className="pwa-session-backdrop" ref={dialogRef} onCancel={(event) => { event.preventDefault(); onClose(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} aria-labelledby="pwa-session-sheet-title">
      <div className="pwa-session-sheet">
        <div className="pwa-session-sheet-head">
          <div><span className="pwa-kicker">Pairing records · {peers.length}</span><h2 id="pwa-session-sheet-title">Sessions</h2><p className="pwa-sheet-summary"><span className="pwa-summary-online">{onlinePairingCount} ONLINE</span><span>·</span><span>{offlinePairingCount} OFFLINE</span>{checkingPairingCount ? <><span>·</span><span>{checkingPairingCount} CHECKING</span></> : null}<small>{onlineSessionCount} of {totalSessionCount} sessions online</small></p></div>
          <button className="pwa-icon-button" ref={closeButtonRef} type="button" onClick={onClose} aria-label="Close sessions" title="Close sessions"><X size={19} /></button>
        </div>
        <div className="pwa-session-sheet-body">
          <div className="pwa-sheet-section-head"><span>Pairing records</span><button className="pwa-secondary-button" type="button" onClick={() => { onPair(); onClose(); }}><Plus size={15} /> Pair a Pi</button></div>
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
                  <span className="pwa-peer-copy"><strong>{displayPeer(peer)}</strong><small className="pwa-peer-technical">Pi key {peer.remoteEpk.slice(0, 8)}…</small><span className="pwa-peer-presence"><span className={`pwa-presence-label ${status}`}>{pairingStatusLabel(status)}</span><span>{onlineSessions}/{totalSessions} SESSIONS</span></span></span>
                  {active ? <span className="pwa-current-label">CURRENT</span> : null}
                </button>
                <button className="pwa-peer-action" type="button" onClick={() => onRename(peer)} aria-label={`Rename ${displayPeer(peer)}`} title="Rename pairing"><Pencil size={16} /></button>
                <button className="pwa-peer-remove" type="button" onClick={() => onRemove(peer)} aria-label={`Delete ${displayPeer(peer)}`} title="Delete pairing"><Trash2 size={16} /></button>
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
                  return <button className={`pwa-sheet-room ${active ? "active" : ""} ${!selectable ? "disabled" : ""}`} key={session.id} type="button" disabled={!selectable} aria-disabled={!selectable} title={active ? "Current session is read-only here" : checking ? "Checking session status" : online ? undefined : "This session is offline"} onClick={() => chooseSession(session.roomId)}><span className="pwa-sheet-session-copy"><strong>{sessionLabel(session)}</strong><small><span className={`pwa-presence-label ${status}`}>{status.toUpperCase()}</span>{session.cwd ? <span className="pwa-sheet-session-cwd">{session.cwd}</span> : null}<code>session ID {session.roomId}</code></small></span>{active ? <span className="pwa-current-label">CURRENT</span> : null}</button>;
                })}
              </>}
            </div>
          ) : null}
        </div>
      </div>
    </dialog>
  );
}
