"use client";

import { Badge, Button, IconButton } from "@/components/ui";
import { Circle, Link2, MessageSquare, Pencil, Plus, Radio, Trash2 } from "lucide-react";
import type { PwaDeviceRecord } from "@/lib/pwa/db";
import type { PairingPresence, PairingStatus } from "@/lib/pwa/pwa-view-model";

export type { PairingPresence, PairingStatus } from "@/lib/pwa/pwa-view-model";
export type ConnectionViewState = "offline" | "connecting" | "online" | "retrying" | "no_network";

export function displayDevice(device: PwaDeviceRecord): string {
  const nickname = device.nickname?.trim();
  if (nickname) return nickname;
  const hostname = device.hostname?.trim();
  if (hostname) return `Pi on ${hostname}`;
  return `Remote Pi · ${device.deviceId.slice(0, 8)}`;
}
function statusLabel(status: PairingStatus): string { return status.toUpperCase(); }

export function ConnectionStatus({ state, retryAttempt = 0 }: { state: ConnectionViewState; retryAttempt?: number }) {
  const label = state === "online" ? "Connected" : state === "connecting" ? "Connecting" : state === "retrying" ? `Retrying ${retryAttempt}/5` : state === "no_network" ? "No network" : "Offline";
  return <span className={`pwa-connection ${state}`} title={label} aria-label={label}><span className="pwa-status-dot" />{label}</span>;
}

export function DesktopSidebar({ devices, activeDeviceId, pairingPresence = {}, onPair, onSelect, onRename, onRemove, onClearData }: {
  devices: PwaDeviceRecord[];
  activeDeviceId: string | null;
  pairingPresence?: Record<string, PairingPresence>;
  onPair: () => void;
  onSelect: (deviceId: string) => void;
  onRename: (device: PwaDeviceRecord) => void;
  onRemove: (device: PwaDeviceRecord) => void;
  onClearData: () => Promise<void>;
}) {
  return <aside className="pwa-sidebar">
    <div className="pwa-sidebar-head"><div><span className="pwa-kicker">Workspace</span><h1>Paired devices</h1></div><IconButton className="pwa-round-button" type="button" radius="xl" onClick={onPair} aria-label="Pair a Pi" title="Pair a Pi"><Plus size={18} /></IconButton></div>
    <div className="pwa-peer-list">
      {devices.length > 0 ? <div className="pwa-sidebar-summary"><span>Paired devices · {devices.length}</span><span>{Object.values(pairingPresence).filter((presence) => presence.status === "online" || presence.status === "partial").length} online</span></div> : null}
      {devices.length === 0 ? <div className="pwa-empty"><Radio size={22} /><strong>No Pi paired yet</strong><span>Open <code>/remote-pi pair</code> in Pi and scan its QR.</span><Button tone="primary" type="button" onClick={onPair} leftSection={<Link2 size={16} />}>Pair a Pi</Button></div> : devices.map((device) => <DeviceCard key={device.id} device={device} active={device.id === activeDeviceId} presence={pairingPresence[device.id]} onSelect={() => onSelect(device.id)} onRename={() => onRename(device)} onRemove={() => onRemove(device)} />)}
    </div>
    <div className="pwa-sidebar-foot"><span><span className="pwa-local-dot" /> Local workspace</span><Button tone="text" type="button" onClick={() => void onClearData()}>Clear data</Button></div>
  </aside>;
}

function DeviceCard({ device, active, presence, onSelect, onRename, onRemove }: { device: PwaDeviceRecord; active: boolean; presence?: PairingPresence; onSelect: () => void; onRename: () => void; onRemove: () => void }) {
  const status = presence?.status ?? "checking";
  const onlineEndpoints = presence?.onlineEndpoints ?? 0;
  const totalEndpoints = presence?.totalEndpoints ?? 0;
  const endpointSummary = status === "checking" ? "Checking endpoints" : `${onlineEndpoints}/${totalEndpoints} endpoints`;
  return <div className={`pwa-peer-card ${active ? "active" : ""}`}><button className="pwa-peer-select" type="button" onClick={onSelect}><span className={`pwa-peer-icon ${status === "online" ? "online" : ""}`}><MessageSquare size={17} /></span><span className="pwa-peer-copy"><strong>{displayDevice(device)}</strong><small className="pwa-peer-technical">Device key {device.deviceId.slice(0, 8)}…</small><span className="pwa-peer-presence"><Badge tone={status} className={`pwa-presence-label ${status}`}>{statusLabel(status)}</Badge><span>{endpointSummary}</span></span></span>{active ? <Badge tone="current" className="pwa-current-label">CURRENT</Badge> : null}<span className={`pwa-peer-state ${status}`} aria-label={statusLabel(status)}><Circle size={8} fill="currentColor" /></span></button><IconButton className="pwa-peer-action" type="button" onClick={onRename} aria-label={`Rename ${displayDevice(device)}`} title="Rename pairing"><Pencil size={14} /></IconButton><IconButton className="pwa-peer-remove" type="button" onClick={onRemove} aria-label={`Remove ${displayDevice(device)}`} title="Remove pairing"><Trash2 size={14} /></IconButton></div>;
}

export function EmptyWorkspace({ onPair }: { onPair: () => void }) {
  return <div className="pwa-zero"><div className="pwa-zero-mark">π</div><span className="pwa-kicker">Remote Pi / browser workspace</span><h2>Your endpoints, within reach.</h2><p>Pair a Remote Pi device to choose a live endpoint. Everything in this browser stays local.</p><Button tone="primary" type="button" onClick={onPair} leftSection={<Link2 size={16} />}>Pair a Pi</Button></div>;
}
