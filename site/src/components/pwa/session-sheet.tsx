"use client";

import { useRef } from "react";
import { Drawer } from "@mantine/core";
import { Badge, Button, IconButton } from "@/components/ui";
import { MessageSquare, Pencil, Plus, Trash2 } from "lucide-react";
import { displayDevice, type PairingPresence, type PairingStatus } from "@/components/pwa/workspace-view";
import type { PwaDeviceRecord, PwaEndpointRecord } from "@/lib/pwa/db";

type SessionSheetProps = {
  devices: PwaDeviceRecord[];
  endpoints: PwaEndpointRecord[];
  activeDeviceId: string | null;
  activeEndpointId: string | null;
  pairingPresence?: Record<string, PairingPresence>;
  onSelectDevice: (deviceId: string) => void;
  onSelectEndpoint: (endpointId: string) => void;
  onPair: () => void;
  onRename: (device: PwaDeviceRecord) => void;
  onRemove: (device: PwaDeviceRecord) => void;
  onClose: () => void;
  focusOrigin?: HTMLElement | null;
  withinPortal?: boolean;
};
function statusLabel(status: PairingStatus): string { return status.toUpperCase(); }
function endpointLabel(endpoint: PwaEndpointRecord): string { return endpoint.name || `${endpoint.kind === "daemon" ? "Daemon" : "Interactive"} endpoint`; }

export function SessionSheet({ devices, endpoints, activeDeviceId, activeEndpointId, pairingPresence = {}, onSelectDevice, onSelectEndpoint, onPair, onRename, onRemove, onClose, focusOrigin = null, withinPortal = true }: SessionSheetProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const activeDevice = devices.find((device) => device.id === activeDeviceId);
  const activeEndpoints = activeDevice ? endpoints.filter((endpoint) => endpoint.deviceId === activeDevice.deviceId).sort((a, b) => (a.name || a.cwd || a.endpointId).localeCompare(b.name || b.cwd || b.endpointId)) : [];
  const presences = Object.values(pairingPresence);
  const onlineEndpoints = presences.reduce((count, presence) => count + presence.onlineEndpoints, 0);
  const totalEndpoints = presences.reduce((count, presence) => count + presence.totalEndpoints, 0);
  const onlineDeviceCount = presences.filter((presence) => presence.status === "online" || presence.status === "partial").length;
  const offlineDeviceCount = presences.filter((presence) => presence.status === "offline").length;
  const checkingDeviceCount = presences.filter((presence) => presence.status === "checking").length;
  const closeDrawer = () => {
    const content = contentRef.current;
    onClose();
    requestAnimationFrame(() => {
      if (content?.isConnected) return;
      const activeElement = document.activeElement;
      const canRestore = focusOrigin?.isConnected && !focusOrigin.matches(":disabled") && focusOrigin.getClientRects().length > 0 && !focusOrigin.closest('[aria-hidden="true"]');
      if (!(activeElement instanceof HTMLElement) || activeElement === document.body || !activeElement.isConnected) if (canRestore) focusOrigin.focus({ preventScroll: true });
    });
  };
  return <Drawer.Root opened onClose={closeDrawer} position="left" size="min(420px, 100vw)" withinPortal={withinPortal} portalProps={{ target: ".pwa-root" }} zIndex={30} padding={0} classNames={{ content: "pwa-session-sheet", header: "pwa-session-sheet-head", body: "pwa-session-sheet-body", close: "pwa-icon-button" }} styles={{ content: { height: "100%", maxHeight: "100%", borderRadius: 0 }, header: { paddingTop: "calc(20px + var(--pwa-safe-top))" } }}>
    <Drawer.Overlay backgroundOpacity={0.7} blur={7} />
    <Drawer.Content ref={contentRef} role="dialog" aria-modal="true" aria-labelledby="pwa-session-sheet-title"><Drawer.Header><div><span className="pwa-kicker">Paired devices · {devices.length}</span><Drawer.Title id="pwa-session-sheet-title">Endpoints</Drawer.Title><p className="pwa-sheet-summary"><span className="pwa-summary-online">{onlineDeviceCount} ONLINE</span><span>·</span><span>{offlineDeviceCount} OFFLINE</span>{checkingDeviceCount ? <><span>·</span><span>{checkingDeviceCount} CHECKING</span></> : null}<small>{onlineEndpoints} of {totalEndpoints} endpoints online</small></p></div><Drawer.CloseButton aria-label="Close endpoints" title="Close endpoints" /></Drawer.Header>
      <Drawer.Body><div className="pwa-sheet-section-head"><span>Paired devices</span><Button tone="secondary" type="button" onClick={() => { onPair(); onClose(); }} leftSection={<Plus size={15} />}>Pair a Pi</Button></div>
        {devices.length ? devices.map((device) => { const active = device.id === activeDeviceId; const presence = pairingPresence[device.id]; const status = presence?.status ?? "checking"; return <div className={`pwa-sheet-peer ${active ? "active" : ""}`} key={device.id}><button className="pwa-sheet-peer-select" type="button" onClick={() => { onSelectDevice(device.id); onClose(); }}><span className={`pwa-peer-icon ${status === "online" ? "online" : ""}`}><MessageSquare size={17} /></span><span className="pwa-peer-copy"><strong>{displayDevice(device)}</strong><small className="pwa-peer-technical">Device key {device.deviceId.slice(0, 8)}…</small><span className="pwa-peer-presence"><Badge tone={status} className={`pwa-presence-label ${status}`}>{statusLabel(status)}</Badge><span>{presence?.onlineEndpoints ?? 0}/{presence?.totalEndpoints ?? 0} ENDPOINTS</span></span></span>{active ? <Badge tone="current" className="pwa-current-label">CURRENT</Badge> : null}</button><IconButton className="pwa-peer-action" type="button" onClick={() => onRename(device)} aria-label={`Rename ${displayDevice(device)}`} title="Rename pairing"><Pencil size={16} /></IconButton><IconButton className="pwa-peer-remove" type="button" onClick={() => onRemove(device)} aria-label={`Delete ${displayDevice(device)}`} title="Delete pairing"><Trash2 size={16} /></IconButton></div>; }) : <p className="pwa-muted">No paired devices yet.</p>}
        {activeDevice ? <div className="pwa-sheet-rooms"><div className="pwa-sheet-section-head"><span>Endpoints on {displayDevice(activeDevice)}</span></div>{activeEndpoints.length === 0 ? <p className="pwa-muted pwa-sheet-empty">No endpoints have been discovered for this device.</p> : activeEndpoints.map((endpoint) => { const active = activeEndpointId === endpoint.endpointId; const online = endpoint.online === true; const checking = endpoint.online === undefined; const selectable = online && !active; const status = checking ? "checking" : online ? "online" : "offline"; return <button className={`pwa-sheet-room ${active ? "active" : ""} ${!selectable ? "disabled" : ""}`} key={endpoint.id} type="button" disabled={!selectable} aria-disabled={!selectable} title={active ? "Current endpoint" : checking ? "Checking endpoint status" : online ? undefined : "This endpoint is offline"} onClick={() => { onSelectEndpoint(endpoint.endpointId); onClose(); }}><span className="pwa-sheet-session-copy"><strong>{endpointLabel(endpoint)}</strong><small><Badge tone={status} className={`pwa-presence-label ${status}`}>{status.toUpperCase()}</Badge><span>{endpoint.kind === "daemon" ? "Daemon" : "Interactive"}</span>{endpoint.cwd ? <span className="pwa-sheet-session-cwd">{endpoint.cwd}</span> : null}<code>endpoint ID {endpoint.endpointId}</code></small></span>{active ? <Badge tone="current" className="pwa-current-label">CURRENT</Badge> : null}</button>; })}</div> : null}
      </Drawer.Body></Drawer.Content>
  </Drawer.Root>;
}
