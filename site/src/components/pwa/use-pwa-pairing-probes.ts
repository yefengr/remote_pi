"use client";

import { useEffect, useRef, useState } from "react";
import { normalizePeerId } from "@/lib/remote-pi/encoding";
import { RelayClient } from "@/lib/remote-pi/relay-client";
import type { PwaPeerRecord } from "@/lib/pwa/db";
import type { PairingPresence } from "@/components/pwa/workspace-view";

const PROBE_RETRY_DELAYS_MS = [1000, 2000] as const;

type PairingProbe = {
  relay: RelayClient;
  dispose: () => void;
};

type PwaPairingProbesOptions = {
  activePeerEpk: string | undefined;
  identity: ConstructorParameters<typeof RelayClient>[0]["identity"] | null;
  peers: PwaPeerRecord[];
  relayUrl: string;
};

export function selectPairingProbePeers(peers: PwaPeerRecord[], activePeerEpk: string | undefined): PwaPeerRecord[] {
  const probePeers = new Map<string, PwaPeerRecord>();
  for (const peer of peers) {
    if (peer.remoteEpk !== activePeerEpk && !probePeers.has(peer.remoteEpk)) probePeers.set(peer.remoteEpk, peer);
  }
  return [...probePeers.values()];
}

export function usePwaPairingProbes({ activePeerEpk, identity, peers, relayUrl }: PwaPairingProbesOptions): Record<string, PairingPresence> {
  const [pairingProbePresence, setPairingProbePresence] = useState<Record<string, PairingPresence>>({});
  const pairingProbesRef = useRef(new Map<string, PairingProbe>());

  useEffect(() => {
    const probes = new Map<string, PairingProbe>();
    const previousProbes = pairingProbesRef.current;
    pairingProbesRef.current = probes;
    for (const probe of previousProbes.values()) probe.dispose();
    previousProbes.clear();
    if (!identity) return;

    for (const peer of selectPairingProbePeers(peers, activePeerEpk)) {
      const remoteEpk = peer.remoteEpk;
      const relay = new RelayClient({ relayUrl: peer.relayUrl || relayUrl, identity });
      const sessionIds = new Set<string>();
      let snapshotReceived = false;
      let disposed = false;
      let retryAttempt = 0;
      let retryTimer: ReturnType<typeof setTimeout> | null = null;
      const probe: PairingProbe = { relay, dispose: () => {} };
      // Ignore callbacks from probes replaced by a later effect run.
      const isCurrent = () => !disposed && pairingProbesRef.current.get(remoteEpk) === probe;
      const updatePresence = (status: PairingPresence["status"]) => {
        if (!isCurrent()) return;
        const onlineSessions = sessionIds.size;
        const next: PairingPresence = { status, onlineSessions, totalSessions: onlineSessions, lastSeenAt: onlineSessions ? Date.now() : undefined };
        setPairingProbePresence((current) => {
          if (!isCurrent()) return current;
          const previous = current[peer.id];
          if (previous?.status === next.status && previous.onlineSessions === next.onlineSessions && previous.totalSessions === next.totalSessions) return current;
          return { ...current, [peer.id]: next };
        });
      };
      const markSnapshotPresence = () => updatePresence(sessionIds.size ? "online" : "offline");
      const scheduleRetry = () => {
        if (!isCurrent() || retryTimer || retryAttempt >= PROBE_RETRY_DELAYS_MS.length) return;
        const delay = PROBE_RETRY_DELAYS_MS[retryAttempt++];
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (!isCurrent()) return;
          snapshotReceived = false;
          sessionIds.clear();
          updatePresence("checking");
          void relay.connect().then(() => {
            if (!isCurrent()) return;
            relay.subscribeRooms([remoteEpk]);
            relay.checkRooms();
          }).catch(() => {
            if (!isCurrent()) return;
            updatePresence("offline");
            scheduleRetry();
          });
        }, delay);
      };
      const removeState = relay.on("state", (state) => {
        if (!isCurrent()) return;
        if (state === "connecting" || state === "authenticating" || state === "open") {
          if (!snapshotReceived) updatePresence("checking");
          return;
        }
        if (state === "closed") {
          updatePresence("offline");
          scheduleRetry();
        }
      });
      const removeError = relay.on("error", () => {
        if (!isCurrent()) return;
        updatePresence("offline");
        scheduleRetry();
      });
      const removeControl = relay.on("control", (frame) => {
        if (!isCurrent() || (frame.type !== "rooms" && frame.type !== "room_announced" && frame.type !== "room_ended")) return;
        let framePeer: string;
        try { framePeer = normalizePeerId(frame.peer); } catch { return; }
        if (!isCurrent() || framePeer !== remoteEpk) return;
        if (frame.type === "rooms") {
          snapshotReceived = true;
          sessionIds.clear();
          for (const room of frame.rooms) sessionIds.add(room.room_id);
          markSnapshotPresence();
          return;
        }
        if (frame.type === "room_announced") sessionIds.add(frame.room_id);
        else sessionIds.delete(frame.room_id);
        if (snapshotReceived) markSnapshotPresence();
      });
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
        removeState();
        removeError();
        removeControl();
        relay.close();
      };
      probe.dispose = dispose;
      probes.set(remoteEpk, probe);
      updatePresence("checking");
      void relay.connect().then(() => {
        if (!isCurrent()) return;
        relay.subscribeRooms([remoteEpk]);
        relay.checkRooms();
      }).catch(() => {
        if (!isCurrent()) return;
        updatePresence("offline");
        scheduleRetry();
      });
    }
    return () => {
      for (const probe of probes.values()) probe.dispose();
      if (pairingProbesRef.current === probes) pairingProbesRef.current.clear();
    };
  }, [activePeerEpk, identity, peers, relayUrl]);

  return pairingProbePresence;
}
