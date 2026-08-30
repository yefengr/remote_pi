"use client";

import { Badge, IconButton } from "@/components/ui";
import { Circle, MessageSquare, Pencil, Trash2 } from "lucide-react";
import type { PairingRecordViewModel } from "./pwa-view-model";

type PairingRecordSurface = "desktop" | "sheet";

type PairingRecordCardProps = {
  viewModel: PairingRecordViewModel;
  surface: PairingRecordSurface;
  onSelect: () => void;
  onRename: () => void;
  onRemove: () => void;
};

export function PairingRecordCard({ viewModel, surface, onSelect, onRename, onRemove }: PairingRecordCardProps) {
  const isDesktop = surface === "desktop";
  const containerClass = isDesktop ? "pwa-peer-card" : "pwa-sheet-peer";
  const selectClass = isDesktop ? "pwa-peer-select" : "pwa-sheet-peer-select";
  const removeVerb = isDesktop ? "Remove" : "Delete";
  const removeTitle = isDesktop ? "Remove pairing" : "Delete pairing";
  const sessionSummary = isDesktop ? viewModel.desktopSessionSummary : viewModel.sheetSessionSummary;

  return <div className={`${containerClass} ${viewModel.active ? "active" : ""}`}>
    <button className={selectClass} type="button" onClick={onSelect}>
      <span className={`pwa-peer-icon ${viewModel.status === "online" ? "online" : ""}`}><MessageSquare size={17} /></span>
      <span className="pwa-peer-copy"><strong>{viewModel.label}</strong><small className="pwa-peer-technical">{viewModel.keyLabel}</small><span className="pwa-peer-presence"><Badge tone={viewModel.status} className={`pwa-presence-label ${viewModel.status}`}>{viewModel.statusLabel}</Badge><span>{sessionSummary}</span></span></span>
      {viewModel.active ? <Badge tone="current" className="pwa-current-label">CURRENT</Badge> : null}
      {isDesktop ? <span className={`pwa-peer-state ${viewModel.status}`} aria-label={viewModel.statusLabel}><Circle size={8} fill="currentColor" /></span> : null}
    </button>
    <IconButton className="pwa-peer-action" type="button" onClick={onRename} aria-label={`Rename ${viewModel.label}`} title="Rename pairing"><Pencil size={isDesktop ? 14 : 16} /></IconButton>
    <IconButton className="pwa-peer-remove" type="button" onClick={onRemove} aria-label={`${removeVerb} ${viewModel.label}`} title={removeTitle}><Trash2 size={isDesktop ? 14 : 16} /></IconButton>
  </div>;
}
