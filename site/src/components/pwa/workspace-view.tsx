"use client";

import { Button, IconButton } from "@/components/ui";
import { Link2, Plus, Radio } from "lucide-react";
import { PairingRecordCard } from "@/components/pwa/pairing-record-card";
import { countOnlinePairings, selectPairingRecord, type PairingPresence } from "@/components/pwa/pwa-view-model";
import type { PwaPeerRecord } from "@/lib/pwa/db";

export type { PairingPresence, PairingStatus } from "@/components/pwa/pwa-view-model";
export { displayPeer } from "@/components/pwa/pwa-view-model";

export type ConnectionViewState = "offline" | "connecting" | "online" | "retrying" | "no_network";

export function ConnectionStatus({ state, retryAttempt = 0 }: { state: ConnectionViewState; retryAttempt?: number }) {
  const label = state === "online" ? "Connected" : state === "connecting" ? "Connecting" : state === "retrying" ? `Retrying ${retryAttempt}/5` : state === "no_network" ? "No network" : "Offline";
  return <span className={`pwa-connection ${state}`} title={label} aria-label={label}><span className="pwa-status-dot" />{label}</span>;
}

export function DesktopSidebar({ peers, activePeerId, pairingPresence = {}, onPair, onSelect, onRename, onRemove, onClearData }: {
  peers: PwaPeerRecord[];
  activePeerId: string | null;
  pairingPresence?: Record<string, PairingPresence>;
  onPair: () => void;
  onSelect: (peerId: string) => void;
  onRename: (peer: PwaPeerRecord) => void;
  onRemove: (peer: PwaPeerRecord) => void;
  onClearData: () => Promise<void>;
}) {
  return (
    <aside className="pwa-sidebar">
      <div className="pwa-sidebar-head"><div><span className="pwa-kicker">Workspace</span><h1>Pairing records</h1></div><IconButton className="pwa-round-button" type="button" radius="xl" onClick={onPair} aria-label="Pair a Pi" title="Pair a Pi"><Plus size={18} /></IconButton></div>
      <div className="pwa-peer-list">
        {peers.length > 0 ? <div className="pwa-sidebar-summary"><span>Pairing records · {peers.length}</span><span>{countOnlinePairings(pairingPresence)} online</span></div> : null}
        {peers.length === 0 ? <div className="pwa-empty"><Radio size={22} /><strong>No Pi paired yet</strong><span>Open <code>/remote-pi pair</code> in Pi and scan its QR.</span><Button tone="primary" type="button" onClick={onPair} leftSection={<Link2 size={16} />}>Pair a Pi</Button></div> : peers.map((peer) => <PairingRecordCard key={peer.id} viewModel={selectPairingRecord(peer, peer.id === activePeerId, pairingPresence[peer.id])} surface="desktop" onSelect={() => onSelect(peer.id)} onRename={() => onRename(peer)} onRemove={() => onRemove(peer)} />)}
      </div>
      <div className="pwa-sidebar-foot"><span><span className="pwa-local-dot" /> Local workspace</span><Button tone="text" type="button" onClick={() => void onClearData()}>Clear data</Button></div>
    </aside>
  );
}

export function EmptyWorkspace({ onPair }: { onPair: () => void }) {
  return <div className="pwa-zero"><div className="pwa-zero-mark">π</div><span className="pwa-kicker">Remote Pi / browser workspace</span><h2>Your agents, within reach.</h2><p>Pair a running Pi coding agent to start a live session. Everything in this browser stays local.</p><Button tone="primary" type="button" onClick={onPair} leftSection={<Link2 size={16} />}>Pair a Pi</Button></div>;
}
