"use client";

import { useEffect, useRef } from "react";
import { Check, MessageSquare, Pencil, Plus, Trash2, X } from "lucide-react";
import { displayPeer, type ConnectionViewState } from "@/components/pwa/workspace-view";
import type { PwaPeerRecord, PwaRoomRecord } from "@/lib/pwa/db";

type SessionSheetProps = {
  peers: PwaPeerRecord[];
  rooms: PwaRoomRecord[];
  activePeerId: string | null;
  activeRoomId: string;
  connection: ConnectionViewState;
  onSelectPeer: (peerId: string) => void;
  onSelectRoom: (roomId: string) => void;
  onPair: () => void;
  onRename: (peer: PwaPeerRecord) => void;
  onRemove: (peer: PwaPeerRecord) => void;
  onClose: () => void;
};

export function SessionSheet({ peers, rooms, activePeerId, activeRoomId, connection, onSelectPeer, onSelectRoom, onPair, onRename, onRemove, onClose }: SessionSheetProps) {
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
  const activeRooms = activePeer ? rooms.filter((room) => room.peerEpk === activePeer.remoteEpk).sort((a, b) => (a.name || a.cwd || a.roomId).localeCompare(b.name || b.cwd || b.roomId)) : [];
  const defaultRoomId = activePeer?.roomId || "main";
  const roomOptions = (() => {
    if (!activePeer) return [];
    const options = new Map<string, { roomId: string; label: string; detail: string }>();
    options.set(defaultRoomId, { roomId: defaultRoomId, label: defaultRoomId, detail: "default" });
    if (activeRoomId !== defaultRoomId) {
      const currentRoom = activeRooms.find((room) => room.roomId === activeRoomId);
      options.set(activeRoomId, { roomId: activeRoomId, label: currentRoom?.name || currentRoom?.cwd || activeRoomId, detail: "current" });
    }
    for (const room of activeRooms.filter((candidate) => candidate.online)) {
      options.set(room.roomId, { roomId: room.roomId, label: room.name || room.cwd || room.roomId, detail: room.roomId });
    }
    return Array.from(options.values());
  })();
  const choosePeer = (peerId: string) => {
    onSelectPeer(peerId);
    onClose();
  };
  const chooseRoom = (nextRoomId: string) => {
    onSelectRoom(nextRoomId);
    onClose();
  };

  return (
    <dialog className="pwa-session-backdrop" ref={dialogRef} onCancel={(event) => { event.preventDefault(); onClose(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} aria-labelledby="pwa-session-sheet-title">
      <div className="pwa-session-sheet">
        <div className="pwa-session-sheet-head">
          <div><span className="pwa-kicker">Workspace</span><h2 id="pwa-session-sheet-title">Sessions</h2></div>
          <button className="pwa-icon-button" ref={closeButtonRef} type="button" onClick={onClose} aria-label="Close sessions" title="Close sessions"><X size={19} /></button>
        </div>
        <div className="pwa-session-sheet-body">
          <div className="pwa-sheet-section-head"><span>Pairings</span><button className="pwa-secondary-button" type="button" onClick={() => { onPair(); onClose(); }}><Plus size={15} /> Pair a Pi</button></div>
          {peers.length ? peers.map((peer) => {
            const active = peer.id === activePeerId;
            const online = active && connection === "online";
            return (
              <div className={`pwa-sheet-peer ${active ? "active" : ""}`} key={peer.id}>
                <button className="pwa-sheet-peer-select" type="button" onClick={() => choosePeer(peer.id)}>
                  <span className={`pwa-peer-icon ${online ? "online" : ""}`}><MessageSquare size={17} /></span>
                  <span className="pwa-peer-copy"><strong>{displayPeer(peer)}</strong><small>{peer.roomId || "main"} <span>/</span> {online ? "online" : "offline"}</small></span>
                  {active ? <Check size={17} className="pwa-sheet-check" /> : null}
                </button>
                <button className="pwa-peer-action" type="button" onClick={() => onRename(peer)} aria-label={`Rename ${displayPeer(peer)}`} title="Rename pairing"><Pencil size={16} /></button>
                <button className="pwa-peer-remove" type="button" onClick={() => onRemove(peer)} aria-label={`Delete ${displayPeer(peer)}`} title="Delete pairing"><Trash2 size={16} /></button>
              </div>
            );
          }) : <p className="pwa-muted">No Pi paired yet.</p>}
          {activePeer ? (
            <div className="pwa-sheet-rooms">
              <div className="pwa-sheet-section-head"><span>Rooms in {displayPeer(activePeer)}</span></div>
              {roomOptions.map((room) => <button className={`pwa-sheet-room ${activeRoomId === room.roomId ? "active" : ""}`} key={room.roomId} type="button" onClick={() => chooseRoom(room.roomId)}><span>{room.label}</span><small>{room.detail}</small></button>)}
            </div>
          ) : null}
        </div>
      </div>
    </dialog>
  );
}
