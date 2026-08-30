import type { PwaPeerRecord, PwaRoomRecord } from "@/lib/pwa/db";

export type PairingStatus = "online" | "checking" | "offline" | "partial";

export type PairingPresence = {
  status: PairingStatus;
  onlineSessions: number;
  totalSessions: number;
  lastSeenAt?: number;
};

export type PairingRecordViewModel = {
  id: string;
  label: string;
  keyLabel: string;
  active: boolean;
  status: PairingStatus;
  statusLabel: string;
  onlineSessions: number;
  totalSessions: number;
  desktopSessionSummary: string;
  sheetSessionSummary: string;
};

export type SessionRowViewModel = {
  id: string;
  roomId: string;
  label: string;
  cwd?: string;
  active: boolean;
  status: "online" | "checking" | "offline";
  selectable: boolean;
  title?: string;
};

export type PairingSummary = {
  onlinePairingCount: number;
  offlinePairingCount: number;
  checkingPairingCount: number;
  onlineSessionCount: number;
  totalSessionCount: number;
};

export function displayPeer(peer: PwaPeerRecord): string {
  const nickname = peer.nickname?.trim();
  if (nickname) return nickname;

  const hostname = peer.hostname?.trim();
  if (hostname) return `Pi on ${hostname}`;

  return `Remote Pi · ${peer.remoteEpk.slice(0, 8)}`;
}

export function selectPairingRecord(peer: PwaPeerRecord, active: boolean, presence?: PairingPresence): PairingRecordViewModel {
  const status = presence?.status ?? "checking";
  const onlineSessions = presence?.onlineSessions ?? 0;
  const totalSessions = presence?.totalSessions ?? 0;

  return {
    id: peer.id,
    label: displayPeer(peer),
    keyLabel: `Pi key ${peer.remoteEpk.slice(0, 8)}…`,
    active,
    status,
    statusLabel: status.toUpperCase(),
    onlineSessions,
    totalSessions,
    desktopSessionSummary: status === "checking" ? "Checking sessions" : `${onlineSessions}/${totalSessions} sessions`,
    sheetSessionSummary: `${onlineSessions}/${totalSessions} SESSIONS`,
  };
}

export function countOnlinePairings(pairingPresence: Record<string, PairingPresence>): number {
  return Object.values(pairingPresence).filter((presence) => presence.status === "online" || presence.status === "partial").length;
}

export function selectPairingSummary(peers: PwaPeerRecord[], pairingPresence: Record<string, PairingPresence>): PairingSummary {
  const distinctPresence = new Map<string, PairingPresence>();
  for (const peer of peers) {
    const presence = pairingPresence[peer.id];
    if (presence && !distinctPresence.has(peer.remoteEpk)) distinctPresence.set(peer.remoteEpk, presence);
  }
  const presenceValues = [...distinctPresence.values()];

  return {
    onlinePairingCount: presenceValues.filter((presence) => presence.status === "online" || presence.status === "partial").length,
    offlinePairingCount: presenceValues.filter((presence) => presence.status === "offline").length,
    checkingPairingCount: presenceValues.filter((presence) => presence.status === "checking").length,
    onlineSessionCount: presenceValues.reduce((count, presence) => count + presence.onlineSessions, 0),
    totalSessionCount: presenceValues.reduce((count, presence) => count + presence.totalSessions, 0),
  };
}

export function sessionLabel(session: PwaRoomRecord): string {
  const cwd = session.cwd?.replace(/[\\/]$/, "");
  const folder = cwd?.split(/[\\/]/).filter(Boolean).pop();
  return folder ? `Session · ${folder}` : "Session";
}

export function selectActiveSessionRows(rooms: PwaRoomRecord[], activePeerEpk: string | undefined, activeRoomId: string): SessionRowViewModel[] {
  if (!activePeerEpk) return [];

  return rooms
    .filter((session) => session.peerEpk === activePeerEpk)
    .sort((a, b) => (a.name || a.cwd || a.roomId).localeCompare(b.name || b.cwd || b.roomId))
    .map((session) => {
      const active = activeRoomId === session.roomId;
      const online = session.online === true;
      const checking = session.online === undefined;
      const selectable = online && !active;
      const status = checking ? "checking" : online ? "online" : "offline";
      const title = active
        ? "Current session is read-only here"
        : checking
          ? "Checking session status"
          : online
            ? undefined
            : "This session is offline";

      return { id: session.id, roomId: session.roomId, label: sessionLabel(session), cwd: session.cwd, active, status, selectable, title };
    });
}
