"use client";

import { ActionIcon, Badge, Button } from "@mantine/core";
import { Circle, Link2, MessageSquare, Pencil, Plus, Radio, Trash2 } from "lucide-react";
import type { PwaPeerRecord } from "@/lib/pwa/db";

export type ConnectionViewState = "offline" | "connecting" | "online" | "retrying" | "no_network";
export type PairingStatus = "online" | "checking" | "offline" | "partial";
export type PairingPresence = {
  status: PairingStatus;
  onlineSessions: number;
  totalSessions: number;
  lastSeenAt?: number;
};

export function displayPeer(peer: PwaPeerRecord): string {
  const nickname = peer.nickname?.trim();
  if (nickname) return nickname;

  const hostname = peer.hostname?.trim();
  if (hostname) return `Pi on ${hostname}`;

  return `Remote Pi · ${peer.remoteEpk.slice(0, 8)}`;
}

function pairingStatusLabel(status: PairingStatus): string {
  return status.toUpperCase();
}

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
      <div className="pwa-sidebar-head"><div><span className="pwa-kicker">Workspace</span><h1>Pairing records</h1></div><ActionIcon className="pwa-round-button" type="button" size={44} variant="transparent" radius="xl" onClick={onPair} aria-label="Pair a Pi" title="Pair a Pi"><Plus size={18} /></ActionIcon></div>
      <div className="pwa-peer-list">
        {peers.length > 0 ? <div className="pwa-sidebar-summary"><span>Pairing records · {peers.length}</span><span>{Object.values(pairingPresence).filter((presence) => presence.status === "online" || presence.status === "partial").length} online</span></div> : null}
        {peers.length === 0 ? <div className="pwa-empty"><Radio size={22} /><strong>No Pi paired yet</strong><span>Open <code>/remote-pi pair</code> in Pi and scan its QR.</span><Button className="pwa-primary-button" type="button" onClick={onPair} leftSection={<Link2 size={16} />}>Pair a Pi</Button></div> : peers.map((peer) => <PeerCard key={peer.id} peer={peer} active={peer.id === activePeerId} presence={pairingPresence[peer.id]} onSelect={() => onSelect(peer.id)} onRename={() => onRename(peer)} onRemove={() => onRemove(peer)} />)}
      </div>
      <div className="pwa-sidebar-foot"><span><span className="pwa-local-dot" /> Local workspace</span><Button className="pwa-text-button" type="button" variant="transparent" onClick={() => void onClearData()}>Clear data</Button></div>
    </aside>
  );
}

function PeerCard({ peer, active, presence, onSelect, onRename, onRemove }: { peer: PwaPeerRecord; active: boolean; presence?: PairingPresence; onSelect: () => void; onRename: () => void; onRemove: () => void }) {
  const status = presence?.status ?? "checking";
  const onlineSessions = presence?.onlineSessions ?? 0;
  const totalSessions = presence?.totalSessions ?? 0;
  const sessionSummary = status === "checking" ? "Checking sessions" : `${onlineSessions}/${totalSessions} sessions`;

  return <div className={`pwa-peer-card ${active ? "active" : ""}`}><button className="pwa-peer-select" type="button" onClick={onSelect}><span className={`pwa-peer-icon ${status === "online" ? "online" : ""}`}><MessageSquare size={17} /></span><span className="pwa-peer-copy"><strong>{displayPeer(peer)}</strong><small className="pwa-peer-technical">Pi key {peer.remoteEpk.slice(0, 8)}…</small><span className="pwa-peer-presence"><Badge className={`pwa-presence-label ${status}`} variant="light">{pairingStatusLabel(status)}</Badge><span>{sessionSummary}</span></span></span>{active ? <Badge className="pwa-current-label" variant="light">CURRENT</Badge> : null}<span className={`pwa-peer-state ${status}`} aria-label={pairingStatusLabel(status)}><Circle size={8} fill="currentColor" /></span></button><ActionIcon className="pwa-peer-action" type="button" size={44} variant="subtle" onClick={onRename} aria-label={`Rename ${displayPeer(peer)}`} title="Rename pairing"><Pencil size={14} /></ActionIcon><ActionIcon className="pwa-peer-remove" type="button" size={44} variant="subtle" onClick={onRemove} aria-label={`Remove ${displayPeer(peer)}`} title="Remove pairing"><Trash2 size={14} /></ActionIcon></div>;
}

export function EmptyWorkspace({ onPair }: { onPair: () => void }) {
  return <div className="pwa-zero"><div className="pwa-zero-mark">π</div><span className="pwa-kicker">Remote Pi / browser workspace</span><h2>Your agents, within reach.</h2><p>Pair a running Pi coding agent to start a live session. Everything in this browser stays local.</p><Button className="pwa-primary-button" type="button" onClick={onPair} leftSection={<Link2 size={16} />}>Pair a Pi</Button></div>;
}
