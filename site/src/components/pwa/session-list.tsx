"use client";

import { Badge } from "@/components/ui";
import type { SessionRowViewModel } from "./pwa-view-model";

type SessionListProps = {
  sessions: SessionRowViewModel[];
  onSelect: (roomId: string) => void;
};

export function SessionList({ sessions, onSelect }: SessionListProps) {
  return <>{sessions.map((session) => <SessionRow key={session.id} session={session} onSelect={onSelect} />)}</>;
}

type SessionRowProps = {
  session: SessionRowViewModel;
  onSelect: (roomId: string) => void;
};

export function SessionRow({ session, onSelect }: SessionRowProps) {
  return <button className={`pwa-sheet-room ${session.active ? "active" : ""} ${!session.selectable ? "disabled" : ""}`} type="button" disabled={!session.selectable} aria-disabled={!session.selectable} title={session.title} onClick={() => onSelect(session.roomId)}>
    <span className="pwa-sheet-session-copy"><strong>{session.label}</strong><small><Badge tone={session.status} className={`pwa-presence-label ${session.status}`}>{session.status.toUpperCase()}</Badge>{session.cwd ? <span className="pwa-sheet-session-cwd">{session.cwd}</span> : null}<code>session ID {session.roomId}</code></small></span>
    {session.active ? <Badge tone="current" className="pwa-current-label">CURRENT</Badge> : null}
  </button>;
}
