"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { describeStartupFailure, type StartupError } from "@/components/pwa/startup-error";
import { generateOwnerKeyPair } from "@/lib/remote-pi/crypto";
import { normalizePeerId } from "@/lib/remote-pi/encoding";
import type { OwnerKeyPair } from "@/lib/remote-pi/types";
import {
  getPwaDatabase,
  listPwaPeers,
  makePwaPeerId,
  openPwaDatabase,
  type PwaPeerRecord,
} from "@/lib/pwa/db";
import { assertBrowserCapabilities, fromStoredKey, migrateLegacyDefaultRelay, toStoredKey } from "@/lib/pwa/runtime";

const LEGACY_DEFAULT_RELAY = "https://relay-rp1.jacobmoura.work";
export const DEFAULT_RELAY = "https://relay-pi.yefengr.cn";
const ACTIVE_PEER_SETTING = "active_peer";
const RELAY_SETTING = "relay_url";

type StartupState = "loading" | "ready" | "error";

type NormalizedStartupPeers = {
  peers: PwaPeerRecord[];
  changed: boolean;
};

export function normalizeStartupPeers(storedPeers: PwaPeerRecord[]): NormalizedStartupPeers {
  const peers = storedPeers.map((peer) => {
    const remoteEpk = normalizePeerId(peer.remoteEpk);
    const roomId = peer.roomId || "main";
    const relayUrl = migrateLegacyDefaultRelay(peer.relayUrl, LEGACY_DEFAULT_RELAY, DEFAULT_RELAY);
    return { ...peer, id: peer.id || makePwaPeerId(remoteEpk, roomId), remoteEpk, roomId, relayUrl };
  });
  const changed = peers.some((peer, index) => peer.id !== storedPeers[index]?.id || peer.remoteEpk !== storedPeers[index]?.remoteEpk || peer.roomId !== storedPeers[index]?.roomId || peer.relayUrl !== storedPeers[index]?.relayUrl);
  return { peers, changed };
}

export function selectStartupPeerId(peers: PwaPeerRecord[], storedActiveId: string | undefined): string | null {
  if (storedActiveId) {
    const peerById = peers.find((peer) => peer.id === storedActiveId);
    if (peerById) return peerById.id;
    const peerByRemoteEpk = peers.find((peer) => peer.remoteEpk === normalizePeerId(storedActiveId));
    if (peerByRemoteEpk) return peerByRemoteEpk.id;
  }
  return peers[0]?.id || null;
}

export type PwaStartup = {
  identity: OwnerKeyPair | null;
  peers: PwaPeerRecord[];
  activePeerId: string | null;
  relayUrl: string;
  startupState: StartupState;
  startupError: StartupError | null;
  setPeers: Dispatch<SetStateAction<PwaPeerRecord[]>>;
  setActivePeerId: Dispatch<SetStateAction<string | null>>;
  setRelayUrl: Dispatch<SetStateAction<string>>;
};

export function usePwaStartup(): PwaStartup {
  const [identity, setIdentity] = useState<OwnerKeyPair | null>(null);
  const [peers, setPeers] = useState<PwaPeerRecord[]>([]);
  const [activePeerId, setActivePeerId] = useState<string | null>(null);
  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY);
  const [startupState, setStartupState] = useState<StartupState>("loading");
  const [startupError, setStartupError] = useState<StartupError | null>(null);

  useEffect(() => {
    let cancelled = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const database = getPwaDatabase();
    const removeDatabaseFailure = database.onOpenFailure((databaseFailure) => {
      if (cancelled) return;
      setStartupError(describeStartupFailure(databaseFailure));
      setStartupState("error");
    });
    const startup = (async () => {
      assertBrowserCapabilities();
      const database = await openPwaDatabase();
      const storedIdentity = await database.identities.get("owner");
      const nextIdentity = storedIdentity ? { privateKey: fromStoredKey(storedIdentity.secretKey), publicKey: fromStoredKey(storedIdentity.publicKey) } : await generateOwnerKeyPair();
      if (!storedIdentity) await database.identities.put({ id: "owner", publicKey: toStoredKey(nextIdentity.publicKey), secretKey: toStoredKey(nextIdentity.privateKey), createdAt: Date.now() });
      const [storedPeers, storedRelay, storedActive] = await Promise.all([listPwaPeers(), database.settings.get(RELAY_SETTING), database.settings.get(ACTIVE_PEER_SETTING)]);
      const { peers: normalizedPeers, changed } = normalizeStartupPeers(storedPeers);
      if (changed) await database.pairings.bulkPut(normalizedPeers);
      const relayValue = migrateLegacyDefaultRelay(storedRelay?.value, LEGACY_DEFAULT_RELAY, DEFAULT_RELAY);
      if (storedRelay?.value === LEGACY_DEFAULT_RELAY) await database.settings.put({ key: RELAY_SETTING, value: relayValue });
      return { nextIdentity, normalizedPeers, relayValue, activePeerId: selectStartupPeerId(normalizedPeers, storedActive?.value) };
    })();
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => {
        reject(new Error("startup_timeout"));
      }, 10000);
    });
    void Promise.race([startup, deadline]).then((result) => {
      if (cancelled) return;
      setIdentity(result.nextIdentity);
      setPeers(result.normalizedPeers);
      setRelayUrl(result.relayValue);
      setActivePeerId(result.activePeerId);
      setStartupState("ready");
    }).catch((startupFailure: unknown) => {
      if (cancelled) return;
      setStartupError(describeStartupFailure(startupFailure));
      setStartupState("error");
    }).finally(() => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineTimer = null;
    });
    return () => {
      cancelled = true;
      removeDatabaseFailure();
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineTimer = null;
    };
  }, []);

  return { identity, peers, activePeerId, relayUrl, startupState, startupError, setPeers, setActivePeerId, setRelayUrl };
}
