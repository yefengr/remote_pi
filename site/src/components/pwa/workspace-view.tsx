"use client";

import { Circle, Link2, MessageSquare, Pencil, Plus, Radio, Trash2 } from "lucide-react";
import type { PwaPeerRecord } from "@/lib/pwa/db";

export type ConnectionViewState = "offline" | "connecting" | "online" | "retrying";

export function displayPeer(peer: PwaPeerRecord): string {
  return peer.nickname?.trim() || peer.sessionName || "Remote Pi";
}

export function ConnectionStatus({ state }: { state: ConnectionViewState }) {
  const label = state === "online" ? "Connected" : state === "connecting" ? "Connecting" : state === "retrying" ? "Retrying" : "Offline";
  return <span className={`pwa-connection ${state}`} title={label} aria-label={label}><span className="pwa-status-dot" />{label}</span>;
}

export function DesktopSidebar({ peers, activePeerId, connection, onPair, onSelect, onRename, onRemove, onClearData }: {
  peers: PwaPeerRecord[];
  activePeerId: string | null;
  connection: ConnectionViewState;
  onPair: () => void;
  onSelect: (peerId: string) => void;
  onRename: (peer: PwaPeerRecord) => void;
  onRemove: (peer: PwaPeerRecord) => void;
  onClearData: () => Promise<void>;
}) {
  return (
    <aside className="pwa-sidebar">
      <div className="pwa-sidebar-head"><div><span className="pwa-kicker">Workspace</span><h1>Paired Pis</h1></div><button className="pwa-round-button" type="button" onClick={onPair} aria-label="Pair a Pi" title="Pair a Pi"><Plus size={18} /></button></div>
      <div className="pwa-peer-list">
        {peers.length === 0 ? <div className="pwa-empty"><Radio size={22} /><strong>No Pi paired yet</strong><span>Open <code>/remote-pi pair</code> in Pi and scan its QR.</span><button className="pwa-primary-button" type="button" onClick={onPair}><Link2 size={16} /> Pair a Pi</button></div> : peers.map((peer) => <PeerCard key={peer.id} peer={peer} active={peer.id === activePeerId} online={peer.id === activePeerId && connection === "online"} onSelect={() => onSelect(peer.id)} onRename={() => onRename(peer)} onRemove={() => onRemove(peer)} />)}
      </div>
      <div className="pwa-sidebar-foot"><span><span className="pwa-local-dot" /> Local workspace</span><button className="pwa-text-button" type="button" onClick={() => void onClearData()}>Clear data</button></div>
    </aside>
  );
}

function PeerCard({ peer, active, online, onSelect, onRename, onRemove }: { peer: PwaPeerRecord; active: boolean; online: boolean; onSelect: () => void; onRename: () => void; onRemove: () => void }) {
  return <div className={`pwa-peer-card ${active ? "active" : ""}`}><button className="pwa-peer-select" type="button" onClick={onSelect}><span className={`pwa-peer-icon ${online ? "online" : ""}`}><MessageSquare size={17} /></span><span className="pwa-peer-copy"><strong>{displayPeer(peer)}</strong><small>{peer.roomId || "main"} <span>/</span> {online ? "live" : "offline"}</small></span><span className="pwa-peer-state"><Circle size={8} fill="currentColor" /></span></button><button className="pwa-peer-action" type="button" onClick={onRename} aria-label={`Rename ${displayPeer(peer)}`} title="Rename pairing"><Pencil size={14} /></button><button className="pwa-peer-remove" type="button" onClick={onRemove} aria-label={`Remove ${displayPeer(peer)}`} title="Remove pairing"><Trash2 size={14} /></button></div>;
}

export function EmptyWorkspace({ onPair }: { onPair: () => void }) {
  return <div className="pwa-zero"><div className="pwa-zero-mark">π</div><span className="pwa-kicker">Remote Pi / browser workspace</span><h2>Your agents, within reach.</h2><p>Pair a running Pi coding agent to start a live session. Everything in this browser stays local.</p><button className="pwa-primary-button" type="button" onClick={onPair}><Link2 size={16} /> Pair a Pi</button></div>;
}
