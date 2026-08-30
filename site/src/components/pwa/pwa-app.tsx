"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PwaAppView, type PwaAppViewActions, type PwaAppViewModel, type PwaAppViewRefs } from "@/components/pwa/pwa-app-view";
import { COMPOSER_THINKING_LEVELS, type ComposerCommandAction } from "@/components/pwa/composer-command-menu";
import { describeStartupFailure, type StartupError } from "@/components/pwa/pwa-startup";
import { displayPeer, type ConnectionViewState, type PairingPresence } from "@/components/pwa/workspace-view";
import { createPairRequest, parsePairUri, relayMismatch } from "@/lib/remote-pi/pairing";
import { PeerChannel } from "@/lib/remote-pi/peer-channel";
import { RelayClient } from "@/lib/remote-pi/relay-client";
import { normalizePeerId } from "@/lib/remote-pi/encoding";
import { generateOwnerKeyPair } from "@/lib/remote-pi/crypto";
import { assertBrowserCapabilities, browserName, fromStoredKey, mergeRooms, migrateLegacyDefaultRelay, toStoredKey, type ConnectionContext } from "@/lib/pwa/runtime";
import { TimelineRuntime, type TimelineScope, type TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { StreamDisplayBuffer } from "@/lib/pwa/stream-display-buffer";
import { getImageOutputMime, prepareImageAttachment } from "@/lib/pwa/image-upload";
import { recoverServerFrame } from "@/lib/pwa/server-frame-recovery";
import { ReconnectState, type ReconnectTrigger } from "@/lib/pwa/reconnect-state";
import { HistoryWindowAssembler, TimelineEventFragmentAssembler } from "@/lib/pwa/timeline-transfer";
import { commitRealtime, loadRecent, replaceRecentWindow, TimelineStoreConflictError } from "@/lib/pwa/timeline-store";
import type { TimelineEvent } from "@/lib/remote-pi/protocol-v2/schema";
import { refreshPwaApp } from "@/lib/pwa/service-worker-update";
import type { ControlFrame, OwnerKeyPair, ThinkingLevel, WireImage, WireModel } from "@/lib/remote-pi/types";
import type { ClientFrame, ServerFrame } from "@/lib/remote-pi/protocol-v2/frames";
import {
  clearPwaData,
  getPwaDatabase,
  openPwaDatabase,
  listPwaPeers,
  listPwaRooms,
  makePwaPeerId,
  removePwaPairingData,
  type PwaPeerRecord,
  type PwaRoomRecord,
} from "@/lib/pwa/db";

const LEGACY_DEFAULT_RELAY = "https://relay-rp1.jacobmoura.work";
const DEFAULT_RELAY = "https://relay-pi.yefengr.cn";
const ACTIVE_PEER_SETTING = "active_peer";
const RELAY_SETTING = "relay_url";
const ACTIVE_ROOM_SETTING = "active_room:";
const BOTTOM_DISTANCE_PX = 72;
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000] as const;
const MAX_RETRY_ATTEMPTS = RETRY_DELAYS_MS.length;
const STREAM_DISPLAY_CADENCE_MS = 36;
type PairState = "idle" | "scanning" | "pairing";
type StartupState = "loading" | "ready" | "error";
type ImageAttachment = { source: Blob; previewUrl: string; label: string };
type ComposerCommandRequest =
  | { action: "session_new" | "session_compact" }
  | { action: "model_set"; provider: string; modelId: string }
  | { action: "thinking_set"; level: ThinkingLevel };
export type ConfirmActionRequest =
  | { kind: "new-session" }
  | { kind: "remove-pairing"; label: string; peer: PwaPeerRecord }
  | { kind: "clear-local-data" };

type ConfirmActionEffects = {
  startNewSession: () => boolean;
  removePairing: (peer: PwaPeerRecord) => Promise<void>;
  invalidateConnection: () => void;
  clearLocalData: () => Promise<void>;
  reload: () => void;
};

type ConfirmActionState = {
  pendingRef: { current: boolean };
  setPending: (pending: boolean) => void;
  setError: (error: string | null) => void;
  onSuccess: () => void;
};

export async function runConfirmAction(action: ConfirmActionRequest, effects: ConfirmActionEffects, state: ConfirmActionState): Promise<"completed" | "failed" | "ignored"> {
  if (state.pendingRef.current) return "ignored";
  state.pendingRef.current = true;
  state.setPending(true);
  state.setError(null);
  try {
    switch (action.kind) {
      case "new-session":
        if (!effects.startNewSession()) throw new Error("Could not start a fresh session. Check the connection and try again.");
        state.onSuccess();
        break;
      case "remove-pairing":
        await effects.removePairing(action.peer);
        state.onSuccess();
        break;
      case "clear-local-data":
        effects.invalidateConnection();
        await effects.clearLocalData();
        effects.reload();
        break;
    }
    return "completed";
  } catch (error) {
    state.setError(error instanceof Error ? error.message : "Could not complete this action. Try again.");
    return "failed";
  } finally {
    state.pendingRef.current = false;
    state.setPending(false);
  }
}

export function pickConfirmationFocusFallback<T>(
  activeElement: T | null,
  candidates: readonly (T | null)[],
  shouldKeepActive: (element: T) => boolean,
  canFocus: (element: T) => boolean,
): T | null {
  if (activeElement !== null && shouldKeepActive(activeElement)) return null;
  return candidates.find((candidate): candidate is T => candidate !== null && canFocus(candidate)) ?? null;
}

export function canCloseBackgroundOverlay(confirmOpen: boolean, confirmPending: boolean): boolean {
  return !confirmOpen && !confirmPending;
}

type RenamePairingRequest = {
  peer: PwaPeerRecord;
  focusOrigin: HTMLElement | null;
  focusFallbackSelectors: readonly string[];
};

type SessionSheetRequest = {
  focusOrigin: HTMLElement | null;
};

type SettingsRequest = {
  focusOrigin: HTMLElement | null;
  focusFallbackSelectors: readonly string[];
};

type PairingProbe = {
  relay: RelayClient;
  dispose: () => void;
};
type ProbePresence = PairingPresence & { sessionIds: Set<string> };
function id(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatSyncTime(timestamp: number | undefined): string {
  return timestamp ? new Date(timestamp).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "never";
}

function safeThinkingLevel(value: unknown): ThinkingLevel {
  return typeof value === "string" && COMPOSER_THINKING_LEVELS.includes(value as ThinkingLevel) ? value as ThinkingLevel : "off";
}

export function PwaApp() {
  const [identity, setIdentity] = useState<OwnerKeyPair | null>(null);
  const [peers, setPeers] = useState<PwaPeerRecord[]>([]);
  const [rooms, setRooms] = useState<PwaRoomRecord[]>([]);
  const [activePeerId, setActivePeerId] = useState<string | null>(null);
  const [roomId, setRoomId] = useState("main");
  const [timelineItems, setTimelineItems] = useState<TimelineViewItem[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | undefined>();
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [connection, setConnection] = useState<ConnectionViewState>("offline");
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY);
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<ImageAttachment | null>(null);
  const [sendingImage, setSendingImage] = useState(false);
  const [stopRequestId, setStopRequestId] = useState<string | null>(null);
  const [visionAvailable, setVisionAvailable] = useState<boolean | null>(null);
  const [models, setModels] = useState<WireModel[]>([]);
  const [currentModel, setCurrentModel] = useState<WireModel | null>(null);
  const [pendingAction, setPendingAction] = useState<{ id: string; action: ComposerCommandAction } | null>(null);
  const [pairState, setPairState] = useState<PairState>("idle");
  const [settingsRequest, setSettingsRequest] = useState<SettingsRequest | null>(null);
  const [sessionSheetRequest, setSessionSheetRequest] = useState<SessionSheetRequest | null>(null);
  const [renameRequest, setRenameRequest] = useState<RenamePairingRequest | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmActionRequest | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const confirmPendingRef = useRef(false);
  const confirmOpenRef = useRef(false);
  const confirmFocusOriginRef = useRef<HTMLElement | null>(null);
  const confirmFocusFallbackSelectorsRef = useRef<readonly string[]>([]);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [selectionReady, setSelectionReady] = useState(false);
  const [followingOutput, setFollowingOutput] = useState(true);
  const [unreadOutput, setUnreadOutput] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [startupState, setStartupState] = useState<StartupState>("loading");
  const [startupError, setStartupError] = useState<StartupError | null>(null);
  const [pairingProbePresence, setPairingProbePresence] = useState<Record<string, ProbePresence>>({});
  const [activeRoomsSnapshotReceived, setActiveRoomsSnapshotReceived] = useState(false);
  const channelRef = useRef<PeerChannel | null>(null);
  const relayRef = useRef<RelayClient | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionDisposeRef = useRef<(() => void) | null>(null);
  const suppressRoomPersistenceRef = useRef(new Set<string>());
  const retryAttemptRef = useRef(0);
  const scheduleReconnectRef = useRef<(() => void) | null>(null);
  const reconnectStateRef = useRef(new ReconnectState());
  const requestReconnect = useCallback((trigger: ReconnectTrigger, token?: number) => {
    reconnectStateRef.current.request(trigger, () => scheduleReconnectRef.current?.(), token);
  }, []);
  const selectionGenerationRef = useRef(0);
  const roomRevisionRef = useRef(0);
  const activeRoomSnapshotRef = useRef<Set<string> | null>(null);
  const activeRoomsSnapshotReceivedRef = useRef(false);
  const activePeerIdRef = useRef<string | null>(null);
  const activePeerRef = useRef<PwaPeerRecord | null>(null);
  const connectionRef = useRef(connection);
  // Stream handlers update this synchronously; React state only mirrors it for rendering.
  const timelineItemsRef = useRef<TimelineViewItem[]>([]);
  const streamDisplayBufferRef = useRef(new StreamDisplayBuffer());
  const streamDisplayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamDisplayRafRef = useRef<number | null>(null);
  const scheduleStreamDisplayRef = useRef<() => void>(() => {});
  const timelineRuntimeRef = useRef(new TimelineRuntime());
  const historyAssemblerRef = useRef<HistoryWindowAssembler | null>(null);
  const historyModeRef = useRef<"recent" | "earlier">("recent");
  const fragmentAssemblerRef = useRef<TimelineEventFragmentAssembler | null>(null);
  const realtimeJournalRef = useRef(new Map<string, TimelineEvent>());
  const helloRequestRef = useRef<string | null>(null);
  const sessionEpochRef = useRef(0);
  const networkSnapshotAppliedEpochRef = useRef(0);
  const roomsRef = useRef(rooms);
  const pendingWritesRef = useRef(new Set<Promise<unknown>>());
  const roomIdRef = useRef(roomId);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const followOutputRef = useRef(true);
  const scrollOnNextMessagesRef = useRef(false);
  const modelRequestRef = useRef<string | null>(null);
  const stopRequestIdRef = useRef<string | null>(null);
  const pendingActionRef = useRef<{ id: string; action: ComposerCommandAction } | null>(null);
  const pairingProbesRef = useRef(new Map<string, PairingProbe>());

  useEffect(() => { roomsRef.current = rooms; }, [rooms]);
  useEffect(() => { roomIdRef.current = roomId; }, [roomId]);
  useEffect(() => { connectionRef.current = connection; }, [connection]);
  const activePeer = useMemo(() => peers.find((peer) => peer.id === activePeerId) ?? null, [activePeerId, peers]);
  const canAttachImage = connection === "online" && visionAvailable === true && !sendingImage;
  useEffect(() => {
    activePeerRef.current = activePeer;
    activePeerIdRef.current = activePeerId;
  }, [activePeer, activePeerId]);
  useEffect(() => () => {
    if (attachment) URL.revokeObjectURL(attachment.previewUrl);
  }, [attachment]);
  const activeRooms = useMemo(
    () => rooms.filter((room) => room.peerEpk === activePeer?.remoteEpk).sort((a, b) => (a.name || a.cwd || a.roomId).localeCompare(b.name || b.cwd || b.roomId)),
    [activePeer?.remoteEpk, rooms],
  );
  const activeRoom = useMemo(
    () => activeRooms.find((room) => room.roomId === roomId) ?? null,
    [activeRooms, roomId],
  );
  const activeThinking = useMemo(() => safeThinkingLevel(activeRoom?.thinking), [activeRoom?.thinking]);
  const pairingPresence = useMemo<Record<string, PairingPresence>>(() => {
    const presence: Record<string, PairingPresence> = {};
    const totalSessions = activeRooms.length;
    const onlineSessions = activeRooms.filter((room) => room.online).length;
    const activePresence: PairingPresence | null = activePeer
      ? {
        status: connection === "connecting" || connection === "retrying" || connection === "no_network"
          ? "checking"
          : connection === "offline"
            ? "offline"
            : !activeRoomsSnapshotReceived
              ? "checking"
              : onlineSessions === 0
                ? "offline"
                : onlineSessions < totalSessions
                  ? "partial"
                  : "online",
        onlineSessions,
        totalSessions,
        lastSeenAt: activeRooms.find((room) => room.online)?.updatedAt,
      }
      : null;
    const representativePeerByEpk = new Map<string, string>();
    for (const peer of peers) {
      if (!representativePeerByEpk.has(peer.remoteEpk)) representativePeerByEpk.set(peer.remoteEpk, peer.id);
    }
    for (const peer of peers) {
      if (activePresence && peer.remoteEpk === activePeer?.remoteEpk) {
        presence[peer.id] = activePresence;
        continue;
      }
      const representativeId = representativePeerByEpk.get(peer.remoteEpk);
      const source = representativeId ? pairingProbePresence[representativeId] : undefined;
      presence[peer.id] = source ?? { status: "checking", onlineSessions: 0, totalSessions: 0 };
    }
    return presence;
  }, [activePeer, activeRooms, activeRoomsSnapshotReceived, connection, pairingProbePresence, peers]);
  const clearStopRequest = useCallback((requestId?: string) => {
    if (requestId && stopRequestIdRef.current !== requestId) return;
    stopRequestIdRef.current = null;
    setStopRequestId(null);
  }, []);
  const clearPendingAction = useCallback((requestId?: string) => {
    if (requestId && pendingActionRef.current?.id !== requestId) return;
    pendingActionRef.current = null;
    setPendingAction(null);
  }, []);
  useEffect(() => {
    if (connection !== "online" || activeRoom?.working !== true) clearStopRequest();
  }, [activePeerId, activeRoom?.working, clearStopRequest, connection, roomId]);
  const isCurrentSelection = useCallback((generation: number, peerId: string, peerEpk: string, selectedRoom: string, channel?: PeerChannel, relay?: RelayClient) => {
    return selectionGenerationRef.current === generation
      && activePeerIdRef.current === peerId
      && activePeerRef.current?.remoteEpk === peerEpk
      && roomIdRef.current === selectedRoom
      && (!channel || channelRef.current === channel)
      && (!relay || relayRef.current === relay);
  }, []);
  const trackWrite = useCallback((write: Promise<unknown>): Promise<unknown> => {
    const tracked = write.then(
      (value) => { pendingWritesRef.current.delete(tracked); return value; },
      (writeError) => { pendingWritesRef.current.delete(tracked); throw writeError; },
    );
    pendingWritesRef.current.add(tracked);
    return tracked;
  }, []);

  const flushLocalWrites = useCallback(async () => {
    while (pendingWritesRef.current.size) await Promise.allSettled(Array.from(pendingWritesRef.current));
  }, []);

  const clearStreamDisplaySchedule = useCallback(() => {
    if (streamDisplayTimerRef.current) clearTimeout(streamDisplayTimerRef.current);
    if (streamDisplayRafRef.current !== null) cancelAnimationFrame(streamDisplayRafRef.current);
    streamDisplayTimerRef.current = null;
    streamDisplayRafRef.current = null;
  }, []);

  const renderStreamSnapshot = useCallback((items: TimelineViewItem[]) => {
    setTimelineItems(items);
  }, []);

  const scheduleStreamDisplay = useCallback(() => {
    if (streamDisplayTimerRef.current || streamDisplayRafRef.current !== null || typeof document !== "undefined" && document.hidden) return;
    streamDisplayTimerRef.current = setTimeout(() => {
      streamDisplayTimerRef.current = null;
      streamDisplayRafRef.current = requestAnimationFrame(() => {
        streamDisplayRafRef.current = null;
        const change = streamDisplayBufferRef.current.advance();
        if (change.shouldRender) renderStreamSnapshot(change.items);
        if (change.hasPending) scheduleStreamDisplayRef.current();
      });
    }, STREAM_DISPLAY_CADENCE_MS);
  }, [renderStreamSnapshot]);

  useEffect(() => {
    scheduleStreamDisplayRef.current = scheduleStreamDisplay;
    return () => {
      if (scheduleStreamDisplayRef.current === scheduleStreamDisplay) scheduleStreamDisplayRef.current = () => {};
    };
  }, [scheduleStreamDisplay]);

  const applyTimelineChange = useCallback((change: ReturnType<TimelineRuntime["receive"]>) => {
    timelineItemsRef.current = change.items;
    const displayChange = streamDisplayBufferRef.current.ingest(change.items);
    if (displayChange.shouldRender) renderStreamSnapshot(displayChange.items);
    if (displayChange.hasPending) scheduleStreamDisplay();
    const channel = channelRef.current;
    for (const frame of change.observed) channel?.send(frame);
  }, [renderStreamSnapshot, scheduleStreamDisplay]);

  useEffect(() => {
    const resetForVisibility = () => {
      clearStreamDisplaySchedule();
      const change = streamDisplayBufferRef.current.reset(timelineItemsRef.current);
      renderStreamSnapshot(change.items);
    };
    document.addEventListener("visibilitychange", resetForVisibility);
    return () => {
      document.removeEventListener("visibilitychange", resetForVisibility);
      clearStreamDisplaySchedule();
    };
  }, [clearStreamDisplaySchedule, renderStreamSnapshot]);

  const reportTimelineWrite = useCallback((write: Promise<unknown>) => {
    void trackWrite(write).catch((writeError) => {
      setError(writeError instanceof TimelineStoreConflictError ? "Local timeline changed unexpectedly. Resyncing…" : "Could not update local history.");
      if (writeError instanceof TimelineStoreConflictError) requestReconnect("error");
    });
  }, [requestReconnect, trackWrite]);

  const interruptStreamingOutput = useCallback(() => {
    historyAssemblerRef.current = null;
    fragmentAssemblerRef.current?.reset();
    fragmentAssemblerRef.current = null;
    realtimeJournalRef.current.clear();
    modelRequestRef.current = null;
    clearPendingAction();
    setVisionAvailable(null);
    setNextBefore(null);
    setLoadingEarlier(false);
    applyTimelineChange(timelineRuntimeRef.current.markDisconnected());
  }, [applyTimelineChange, clearPendingAction]);

  const markPeerRoomsOffline = useCallback((peerEpk: string) => {
    const now = Date.now();
    const updated = roomsRef.current.map((room) => room.peerEpk === peerEpk && room.online ? { ...room, online: false, updatedAt: now } : room);
    if (updated.every((room, index) => room === roomsRef.current[index])) return;
    roomsRef.current = updated;
    if (activePeerRef.current?.remoteEpk === peerEpk) setRooms(updated);
  }, []);


  const upsertRooms = useCallback(async (peerEpk: string, nextRooms: PwaRoomRecord[], generation: number) => {
    roomRevisionRef.current += 1;
    if (selectionGenerationRef.current === generation && activePeerRef.current?.remoteEpk === peerEpk) {
      const updated = mergeRooms(roomsRef.current.filter((room) => room.peerEpk !== peerEpk), nextRooms);
      roomsRef.current = updated;
      setRooms(updated);
    }
    await trackWrite(getPwaDatabase().rooms.bulkPut(nextRooms.map((room) => {
      const storedRoom = { ...room };
      delete storedRoom.online;
      return storedRoom;
    })));
  }, [trackWrite]);

  const scrollToLatest = useCallback((smooth = false) => {
    const list = messageListRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  const resumeFollowingOutput = useCallback(() => {
    followOutputRef.current = true;
    setFollowingOutput(true);
    setUnreadOutput(0);
  }, []);

  const scheduleScrollToLatest = useCallback(() => {
    scrollOnNextMessagesRef.current = true;
    resumeFollowingOutput();
  }, [resumeFollowingOutput]);

  const handleMessageListScroll = useCallback(() => {
    const list = messageListRef.current;
    if (!list) return;
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (distance <= BOTTOM_DISTANCE_PX) {
      resumeFollowingOutput();
    } else {
      followOutputRef.current = false;
      setFollowingOutput(false);
    }
  }, [resumeFollowingOutput]);

  const noteIncomingOutput = useCallback(() => {
    if (!followOutputRef.current) setUnreadOutput((count) => Math.min(count + 1, 99));
  }, []);

  useEffect(() => {
    if (scrollOnNextMessagesRef.current) {
      scrollOnNextMessagesRef.current = false;
      scrollToLatest(false);
      return;
    }
    if (followOutputRef.current) scrollToLatest(false);
  }, [scrollToLatest, timelineItems]);

  const refreshModels = useCallback(() => {
    const peer = activePeerRef.current;
    const channel = channelRef.current;
    const generation = selectionGenerationRef.current;
    const selectedRoom = roomIdRef.current;
    const scope = timelineRuntimeRef.current.currentScope;
    if (!peer || !channel || !scope || connectionRef.current !== "online" || !isCurrentSelection(generation, peer.id, peer.remoteEpk, selectedRoom, channel, relayRef.current || undefined)) return;
    const requestId = id();
    modelRequestRef.current = requestId;
    if (!channel.send({ protocol_version: 2, type: "list_models", id: requestId, channel_id: scope.channelId, history_generation: scope.historyGeneration })) {
      if (modelRequestRef.current === requestId) modelRequestRef.current = null;
      setError("Relay is not connected.");
    }
  }, [isCurrentSelection]);

  const handleServerFrame = useCallback((frame: ServerFrame, context: ConnectionContext) => {
    if (!isCurrentSelection(context.generation, context.peerId, context.peerEpk, context.roomId, context.channel, context.relay)) return;
    if (frame.type === "models_list") {
      if (frame.in_reply_to !== modelRequestRef.current) return;
      modelRequestRef.current = null;
      setModels(frame.models);
      setCurrentModel(frame.current ?? null);
      setVisionAvailable(frame.current?.vision ?? null);
      return;
    }
    if (frame.type === "action_ok" || frame.type === "action_error") {
      const pending = pendingActionRef.current;
      if (!pending || pending.id !== frame.in_reply_to || pending.action !== frame.action) return;
      clearPendingAction(frame.in_reply_to);
      if (frame.type === "action_error") {
        setError(frame.error);
      } else if (frame.action === "model_set") {
        refreshModels();
      }
      return;
    }
    if (frame.type === "cancelled") {
      clearStopRequest(frame.in_reply_to);
      return;
    }
    if (frame.type === "protocol_error") {
      if (frame.in_reply_to === stopRequestIdRef.current) clearStopRequest(frame.in_reply_to);
      if (frame.in_reply_to === pendingActionRef.current?.id) clearPendingAction(frame.in_reply_to);
    }
    if (frame.type === "session_ready") {
      if (frame.in_reply_to !== helloRequestRef.current) return;
      helloRequestRef.current = null;
      clearPendingAction();
      const scope: TimelineScope = { peerEpk: context.peerEpk, roomId: context.roomId, sessionId: frame.session_id, historyGeneration: frame.history_generation, selfSenderRef: frame.self_sender_ref, channelId: context.channel.channelId };
      applyTimelineChange(timelineRuntimeRef.current.setScope(scope));
      realtimeJournalRef.current.clear();
      sessionEpochRef.current += 1;
      networkSnapshotAppliedEpochRef.current = 0;
      fragmentAssemblerRef.current = new TimelineEventFragmentAssembler({ session_id: scope.sessionId, history_generation: scope.historyGeneration });
      setNextBefore(null);
      const requestId = id();
      historyModeRef.current = "recent";
      historyAssemblerRef.current = new HistoryWindowAssembler(requestId, { session_id: scope.sessionId, history_generation: scope.historyGeneration });
      const cacheEpoch = sessionEpochRef.current;
      void loadRecent(scope).then((cached) => {
        if (cacheEpoch === sessionEpochRef.current && networkSnapshotAppliedEpochRef.current !== cacheEpoch && timelineRuntimeRef.current.currentScope?.sessionId === scope.sessionId && timelineRuntimeRef.current.currentScope.historyGeneration === scope.historyGeneration) applyTimelineChange(timelineRuntimeRef.current.replaceHistory(cached));
      }).catch(() => setError("Could not read local history."));
      context.channel.send({ protocol_version: 2, type: "session_sync", id: requestId, channel_id: context.channel.channelId, history_generation: frame.history_generation, before: null, limit: 5 });
      setVisionAvailable(null);
      setModels([]);
      setCurrentModel(null);
      const modelRequestId = id();
      modelRequestRef.current = modelRequestId;
      context.channel.send({ protocol_version: 2, type: "list_models", id: modelRequestId, channel_id: context.channel.channelId, history_generation: frame.history_generation });
      setConnection("online");
      return;
    }
    const recoveryAction = recoverServerFrame(frame, {
      invalidateScope: () => {
        historyAssemblerRef.current = null;
        fragmentAssemblerRef.current?.reset();
        fragmentAssemblerRef.current = null;
        realtimeJournalRef.current.clear();
        setNextBefore(null);
        setLoadingEarlier(false);
        applyTimelineChange(timelineRuntimeRef.current.invalidateScope());
        sessionEpochRef.current += 1;
        networkSnapshotAppliedEpochRef.current = 0;
        helloRequestRef.current = null;
        clearStopRequest();
        clearPendingAction();
      },
      rehello: () => {
        setConnection("connecting");
        const helloId = id();
        helloRequestRef.current = helloId;
        context.channel.send({ protocol_version: 2, type: "session_hello", id: helloId, channel_id: context.channel.channelId });
      },
      reconnect: () => {
        reconnectStateRef.current.replacementBye();
        context.channel.close();
        context.relay.close();
      },
      disconnect: () => {
        reconnectStateRef.current.terminalBye();
        if (reconnectRef.current) {
          clearTimeout(reconnectRef.current);
          reconnectRef.current = null;
        }
        retryAttemptRef.current = 0;
        setRetryAttempt(0);
        setConnection("offline");
        context.channel.close();
        context.relay.close();
      },
    });
    if (recoveryAction !== "ignore") return;
    const changed = timelineRuntimeRef.current.receive(frame);
    if (frame.type === "protocol_error") setError(frame.message);
    if (frame.type === "timeline_event_fragment") {
      const scope = timelineRuntimeRef.current.currentScope;
      if (!scope) return;
      fragmentAssemblerRef.current ??= new TimelineEventFragmentAssembler({ session_id: scope.sessionId, history_generation: scope.historyGeneration });
      const result = fragmentAssemblerRef.current.accept(frame);
      if (result.status === "complete") {
        realtimeJournalRef.current.set(result.event.event_id, result.event);
        applyTimelineChange(timelineRuntimeRef.current.commit(result.event));
        reportTimelineWrite(commitRealtime(scope, [result.event]));
      }
      return;
    }
    if (frame.type === "timeline_event") {
      noteIncomingOutput();
      const scope = timelineRuntimeRef.current.currentScope;
      if (scope) {
        realtimeJournalRef.current.set(frame.event.event_id, frame.event);
        reportTimelineWrite(commitRealtime(scope, [frame.event]));
      }
    }
    if (frame.type === "session_history_chunk") {
      const result = historyAssemblerRef.current?.accept(frame);
      if (result?.status === "discarded" && result.reason === "history_scope_mismatch") {
        historyAssemblerRef.current = null;
        fragmentAssemblerRef.current?.reset();
        applyTimelineChange(timelineRuntimeRef.current.invalidateScope());
        setConnection("connecting");
        const helloId = id();
        helloRequestRef.current = helloId;
        context.channel.send({ protocol_version: 2, type: "session_hello", id: helloId, channel_id: context.channel.channelId });
        return;
      }
      if (result?.status === "complete") {
        const scope = timelineRuntimeRef.current.currentScope;
        if (!scope) return;
        if (historyModeRef.current === "earlier") {
          applyTimelineChange(timelineRuntimeRef.current.prependHistory(result.events));
          setLoadingEarlier(false);
        } else {
          const journal = [...realtimeJournalRef.current.values()];
          applyTimelineChange(timelineRuntimeRef.current.replaceHistory([...result.events, ...journal]));
          networkSnapshotAppliedEpochRef.current = sessionEpochRef.current;
          reportTimelineWrite(replaceRecentWindow(scope, result.events, journal));
          realtimeJournalRef.current.clear();
        }
        setNextBefore(result.eos ? null : result.next_before ?? null);
        setLastSyncedAt(Date.now());
        historyAssemblerRef.current = null;
      }
      return;
    }
    applyTimelineChange(changed);
  }, [applyTimelineChange, clearPendingAction, clearStopRequest, isCurrentSelection, noteIncomingOutput, refreshModels, reportTimelineWrite]);

  const loadEarlier = useCallback(() => {
    const scope = timelineRuntimeRef.current.currentScope;
    const channel = channelRef.current;
    if (!scope || !channel || !nextBefore || loadingEarlier || connectionRef.current !== "online") return;
    const requestId = id();
    historyModeRef.current = "earlier";
    historyAssemblerRef.current = new HistoryWindowAssembler(requestId, { session_id: scope.sessionId, history_generation: scope.historyGeneration });
    setLoadingEarlier(true);
    if (!channel.send({ protocol_version: 2, type: "session_sync", id: requestId, channel_id: scope.channelId, history_generation: scope.historyGeneration, before: nextBefore, limit: 5 })) {
      historyAssemblerRef.current = null;
      setLoadingEarlier(false);
      setError("Relay is not connected.");
    }
  }, [loadingEarlier, nextBefore]);

  const handleControlFrame = useCallback((frame: ControlFrame, generation: number, peer: PwaPeerRecord, relay: RelayClient) => {
    if (frame.type === "presence" || !isCurrentSelection(generation, peer.id, peer.remoteEpk, roomIdRef.current, undefined, relay)) return;
    let framePeer: string;
    try { framePeer = normalizePeerId(frame.peer); } catch { return; }
    if (framePeer !== peer.remoteEpk) return;
    if (frame.type === "rooms") {
      const now = Date.now();
      const activeRooms = frame.rooms.map((room) => ({ id: `${framePeer}:${room.room_id}`, peerEpk: framePeer, roomId: room.room_id, name: room.name ?? undefined, cwd: room.cwd ?? undefined, startedAt: room.started_at, model: room.model ?? undefined, thinking: room.thinking ?? undefined, working: room.working, online: true, updatedAt: now }));
      const activeIds = new Set(activeRooms.map((room) => room.id));
      activeRoomSnapshotRef.current = activeIds;
      activeRoomsSnapshotReceivedRef.current = true;
      setActiveRoomsSnapshotReceived(true);
      const endedRooms = roomsRef.current.filter((room) => room.peerEpk === framePeer && !activeIds.has(room.id)).map((room) => ({ ...room, online: false, updatedAt: now }));
      void upsertRooms(framePeer, [...activeRooms, ...endedRooms], generation);
      return;
    }
    if (frame.type === "room_announced" || frame.type === "room_meta_updated") {
      const previous = roomsRef.current.find((room) => room.peerEpk === framePeer && room.roomId === frame.room_id);
      const next: PwaRoomRecord = { id: `${framePeer}:${frame.room_id}`, peerEpk: framePeer, roomId: frame.room_id, name: frame.type === "room_announced" ? frame.name ?? undefined : previous?.name, cwd: frame.type === "room_announced" ? frame.cwd ?? undefined : previous?.cwd, startedAt: frame.type === "room_announced" ? frame.started_at : previous?.startedAt, model: frame.type === "room_announced" ? frame.model ?? undefined : frame.meta?.model ?? previous?.model, thinking: frame.type === "room_announced" ? frame.thinking ?? undefined : frame.meta?.thinking ?? previous?.thinking, working: frame.type === "room_announced" ? frame.working : frame.meta?.working ?? previous?.working, online: true, updatedAt: Date.now() };
      activeRoomSnapshotRef.current?.add(next.id);
      void upsertRooms(framePeer, [...roomsRef.current.filter((room) => !(room.peerEpk === framePeer && room.roomId === frame.room_id)), next], generation);
      return;
    }
    if (frame.type === "room_ended") {
      activeRoomSnapshotRef.current?.delete(`${framePeer}:${frame.room_id}`);
      void upsertRooms(framePeer, roomsRef.current.filter((room) => room.peerEpk === framePeer).map((room) => room.roomId === frame.room_id ? { ...room, online: false, updatedAt: Date.now() } : room), generation);
    }
  }, [isCurrentSelection, upsertRooms]);

  useEffect(() => {
    const activePeerEpk = activePeer?.remoteEpk;
    const probePeers = new Map<string, PwaPeerRecord>();
    for (const peer of peers) {
      if (peer.remoteEpk !== activePeerEpk && !probePeers.has(peer.remoteEpk)) probePeers.set(peer.remoteEpk, peer);
    }
    const probes = new Map<string, PairingProbe>();
    const previousProbes = pairingProbesRef.current;
    pairingProbesRef.current = probes;
    for (const probe of previousProbes.values()) probe.dispose();
    previousProbes.clear();
    if (!identity) return;

    for (const [remoteEpk, peer] of probePeers) {
      const relay = new RelayClient({ relayUrl: peer.relayUrl || relayUrl, identity });
      const sessionIds = new Set<string>();
      let snapshotReceived = false;
      let disposed = false;
      let retryAttempt = 0;
      let retryTimer: ReturnType<typeof setTimeout> | null = null;
      const probe: PairingProbe = { relay, dispose: () => {} };
      const isCurrent = () => !disposed && pairingProbesRef.current.get(remoteEpk) === probe;
      const updatePresence = (status: PairingPresence["status"]) => {
        if (!isCurrent()) return;
        const onlineSessions = sessionIds.size;
        const next: ProbePresence = { status, onlineSessions, totalSessions: onlineSessions, sessionIds: new Set(sessionIds), lastSeenAt: onlineSessions ? Date.now() : undefined };
        setPairingProbePresence((current) => {
          if (!isCurrent()) return current;
          const previous = current[peer.id];
          if (previous?.status === next.status && previous.onlineSessions === next.onlineSessions && previous.totalSessions === next.totalSessions) return current;
          return { ...current, [peer.id]: next };
        });
      };
      const markSnapshotPresence = () => updatePresence(sessionIds.size ? "online" : "offline");
      const scheduleRetry = () => {
        if (!isCurrent() || retryTimer || retryAttempt >= 2) return;
        const delay = RETRY_DELAYS_MS[retryAttempt++];
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
  }, [activePeer?.remoteEpk, identity, peers, relayUrl]);

  const connectActivePeer = useCallback(async (peer: PwaPeerRecord, generation: number, selectedRoom: string) => {
    if (!identity || !isCurrentSelection(generation, peer.id, peer.remoteEpk, selectedRoom)) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setConnection("no_network");
      return;
    }
    const connectionToken = reconnectStateRef.current.beginConnection();
    const relay = new RelayClient({ relayUrl: peer.relayUrl || relayUrl, identity });
    let channel: PeerChannel | null = null;
    const context = () => channel ? { generation, peerId: peer.id, peerEpk: peer.remoteEpk, roomId: selectedRoom, channel, relay } : null;
    channel = new PeerChannel({
      relay,
      remotePeer: peer.remoteEpk,
      roomId: selectedRoom,
      onFrame: (frame) => { const current = context(); if (current) handleServerFrame(frame, current); },
      onMalformed: (reason) => { if (channel && isCurrentSelection(generation, peer.id, peer.remoteEpk, selectedRoom, channel, relay)) setError(reason); },
    });
    channelRef.current = channel;
    relayRef.current = relay;
    setConnection("connecting");
    const removeState = relay.on("state", (state) => {
      if (!channel || !isCurrentSelection(generation, peer.id, peer.remoteEpk, selectedRoom, channel, relay)) return;
      if (state === "open") {
        retryAttemptRef.current = 0;
        setRetryAttempt(0);
        setConnection("connecting");
      }
      if (state === "connecting" || state === "authenticating") setConnection("connecting");
      if (state === "closed") {
        interruptStreamingOutput();
        markPeerRoomsOffline(peer.remoteEpk);
        setConnection("offline");
        requestReconnect("closed", connectionToken);
      }
    });
    const removeError = relay.on("error", (eventError) => {
      if (!channel || !isCurrentSelection(generation, peer.id, peer.remoteEpk, selectedRoom, channel, relay)) return;
      setError(eventError.message);
      requestReconnect("error", connectionToken);
    });
    const removeControl = relay.on("control", (frame) => handleControlFrame(frame, generation, peer, relay));
    const dispose = () => {
      removeState();
      removeError();
      removeControl();
      channel?.close();
      relay.close();
    };
    try {
      await relay.connect();
      if (!channel || !isCurrentSelection(generation, peer.id, peer.remoteEpk, selectedRoom, channel, relay)) return dispose;
      retryAttemptRef.current = 0;
      relay.subscribeRooms([peer.remoteEpk]);
      relay.checkRooms();
      const helloId = id();
      helloRequestRef.current = helloId;
      channel.send({ protocol_version: 2, type: "session_hello", id: helloId, channel_id: channel.channelId });
    } catch (connectError) {
      if (channel && isCurrentSelection(generation, peer.id, peer.remoteEpk, selectedRoom, channel, relay)) {
        setError(connectError instanceof Error ? connectError.message : "Relay connection failed");
        requestReconnect("connect_rejected", connectionToken);
      }
    }
    return dispose;
  }, [handleControlFrame, handleServerFrame, identity, interruptStreamingOutput, isCurrentSelection, markPeerRoomsOffline, relayUrl, requestReconnect]);

  const invalidateConnection = useCallback((resetRetries = true) => {
    clearPendingAction();
    const previousPeer = activePeerRef.current;
    if (previousPeer) {
      interruptStreamingOutput();
      markPeerRoomsOffline(previousPeer.remoteEpk);
    }
    const generation = selectionGenerationRef.current + 1;
    selectionGenerationRef.current = generation;
    if (reconnectRef.current) {
      clearTimeout(reconnectRef.current);
      reconnectRef.current = null;
    }
    if (resetRetries) {
      retryAttemptRef.current = 0;
      setRetryAttempt(0);
    }
    connectionDisposeRef.current?.();
    connectionDisposeRef.current = null;
    channelRef.current?.close();
    relayRef.current?.close();
    channelRef.current = null;
    relayRef.current = null;
    return generation;
  }, [clearPendingAction, interruptStreamingOutput, markPeerRoomsOffline]);

  const restartActiveConnection = useCallback((resetRetries = true) => {
    const peer = activePeerRef.current;
    if (!selectionReady || !peer) {
      setConnection("offline");
      return;
    }
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setConnection("no_network");
      return;
    }
    const selectedRoom = roomIdRef.current;
    reconnectStateRef.current.userRecover();
    const generation = invalidateConnection(resetRetries);
    if (resetRetries) {
      retryAttemptRef.current = 1;
      setRetryAttempt(1);
    }
    setConnection("connecting");
    void connectActivePeer(peer, generation, selectedRoom).then((dispose) => {
      if (!dispose) return;
      if (!isCurrentSelection(generation, peer.id, peer.remoteEpk, selectedRoom)) {
        dispose();
        return;
      }
      connectionDisposeRef.current = dispose;
    });
  }, [connectActivePeer, invalidateConnection, isCurrentSelection, selectionReady]);

  const scheduleReconnect = useCallback(() => {
    const peer = activePeerRef.current;
    if (!selectionReady || !peer || !activePeerIdRef.current) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setConnection("no_network");
      return;
    }
    if (reconnectStateRef.current.isTerminal || reconnectRef.current || retryAttemptRef.current >= MAX_RETRY_ATTEMPTS) {
      if (retryAttemptRef.current >= MAX_RETRY_ATTEMPTS) setConnection("offline");
      return;
    }
    const generation = selectionGenerationRef.current;
    const attempt = retryAttemptRef.current + 1;
    retryAttemptRef.current = attempt;
    setRetryAttempt(attempt);
    setConnection("retrying");
    reconnectRef.current = setTimeout(() => {
      reconnectRef.current = null;
      if (selectionGenerationRef.current !== generation || reconnectStateRef.current.isTerminal) return;
      restartActiveConnection(false);
    }, RETRY_DELAYS_MS[attempt - 1]);
  }, [restartActiveConnection, selectionReady]);

  useEffect(() => {
    scheduleReconnectRef.current = scheduleReconnect;
    return () => {
      if (scheduleReconnectRef.current === scheduleReconnect) scheduleReconnectRef.current = null;
    };
  }, [scheduleReconnect]);

  const selectPeer = useCallback((peerId: string | null) => {
    if (peerId === activePeerIdRef.current) return;
    reconnectStateRef.current.userRecover();
    invalidateConnection();
    const selectedPeer = peers.find((peer) => peer.id === peerId) ?? null;
    const selectedRoom = selectedPeer?.roomId || "main";
    activePeerIdRef.current = peerId;
    activePeerRef.current = selectedPeer;
    roomIdRef.current = selectedRoom;
    setActivePeerId(peerId);
    setRoomId(selectedRoom);
    setSelectionReady(false);
    setRooms([]);
    roomsRef.current = [];
    activeRoomSnapshotRef.current = null;
    activeRoomsSnapshotReceivedRef.current = false;
    setActiveRoomsSnapshotReceived(false);
    roomRevisionRef.current += 1;
    applyTimelineChange(timelineRuntimeRef.current.clear());
    setLastSyncedAt(undefined);
    setDraft("");
    setAttachment(null);
    setVisionAvailable(null);
    setModels([]);
    setCurrentModel(null);
    setUnreadOutput(0);
    scheduleScrollToLatest();
    setConnection(peerId ? (typeof navigator !== "undefined" && navigator.onLine ? "connecting" : "no_network") : "offline");
    setError(null);
  }, [applyTimelineChange, invalidateConnection, peers, scheduleScrollToLatest]);

  const selectRoom = useCallback((nextRoom: string) => {
    const peer = activePeerRef.current;
    if (!peer || !nextRoom || nextRoom === roomIdRef.current) return;
    reconnectStateRef.current.userRecover();
    invalidateConnection();
    roomIdRef.current = nextRoom;
    setRoomId(nextRoom);
    activeRoomsSnapshotReceivedRef.current = false;
    setActiveRoomsSnapshotReceived(false);
    setSelectionReady(true);
    applyTimelineChange(timelineRuntimeRef.current.clear());
    setLastSyncedAt(undefined);
    setDraft("");
    setAttachment(null);
    setVisionAvailable(null);
    setModels([]);
    setCurrentModel(null);
    setUnreadOutput(0);
    scheduleScrollToLatest();
    setConnection(typeof navigator !== "undefined" && navigator.onLine ? "connecting" : "no_network");
    void getPwaDatabase().settings.put({ key: `${ACTIVE_ROOM_SETTING}${peer.id}`, value: nextRoom });
  }, [applyTimelineChange, invalidateConnection, scheduleScrollToLatest]);

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
      const normalizedPeers = storedPeers.map((peer) => {
        const remoteEpk = normalizePeerId(peer.remoteEpk);
        const nextRoom = peer.roomId || "main";
        const nextRelay = migrateLegacyDefaultRelay(peer.relayUrl, LEGACY_DEFAULT_RELAY, DEFAULT_RELAY);
        return { ...peer, id: peer.id || makePwaPeerId(remoteEpk, nextRoom), remoteEpk, roomId: nextRoom, relayUrl: nextRelay };
      });
      if (normalizedPeers.some((peer, index) => peer.id !== storedPeers[index]?.id || peer.remoteEpk !== storedPeers[index]?.remoteEpk || peer.roomId !== storedPeers[index]?.roomId || peer.relayUrl !== storedPeers[index]?.relayUrl)) await database.pairings.bulkPut(normalizedPeers);
      const relayValue = migrateLegacyDefaultRelay(storedRelay?.value, LEGACY_DEFAULT_RELAY, DEFAULT_RELAY);
      if (storedRelay?.value === LEGACY_DEFAULT_RELAY) await database.settings.put({ key: RELAY_SETTING, value: relayValue });
      const storedActivePeer = storedActive?.value ? normalizedPeers.find((peer) => peer.id === storedActive.value) ?? normalizedPeers.find((peer) => peer.remoteEpk === normalizePeerId(storedActive.value)) : undefined;
      return { nextIdentity, normalizedPeers, relayValue, activePeerId: storedActivePeer?.id || normalizedPeers[0]?.id || null };
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

  useEffect(() => {
    const peer = activePeerRef.current;
    const generation = selectionGenerationRef.current;
    if (!activePeerId || !peer) {
      activeRoomsSnapshotReceivedRef.current = false;
      setActiveRoomsSnapshotReceived(false);
      setSelectionReady(false);
      setLastSyncedAt(undefined);
      applyTimelineChange(timelineRuntimeRef.current.clear());
      return;
    }
    setLastSyncedAt(undefined);
    activeRoomsSnapshotReceivedRef.current = false;
    setActiveRoomsSnapshotReceived(false);
    const peerEpk = peer.remoteEpk;
    const roomRequestRevision = roomRevisionRef.current;
    const isCurrentPeer = () => selectionGenerationRef.current === generation && activePeerIdRef.current === peer.id && activePeerRef.current?.remoteEpk === peerEpk;
    void listPwaRooms(peerEpk).then((storedRooms) => {
      if (!isCurrentPeer()) return;
      const currentSnapshot = activeRoomSnapshotRef.current;
      const normalizedStoredRooms = currentSnapshot
        ? storedRooms.map((room) => ({ ...room, online: currentSnapshot.has(room.id) }))
        : storedRooms.map((room) => ({ ...room, online: false }));
      const merged = roomRequestRevision === roomRevisionRef.current ? normalizedStoredRooms : mergeRooms(normalizedStoredRooms, roomsRef.current);
      roomsRef.current = merged;
      roomRevisionRef.current += 1;
      setRooms(merged);
    }).catch(() => { if (isCurrentPeer()) setError("Could not read local rooms."); });
    void (async () => {
      try {
        const storedRoom = await getPwaDatabase().settings.get(`${ACTIVE_ROOM_SETTING}${peer.id}`);
        if (!isCurrentPeer()) return;
        const nextRoom = storedRoom?.value || peer.roomId || "main";
        roomIdRef.current = nextRoom;
        setRoomId(nextRoom);
        setSelectionReady(true);
      } catch {
        if (!isCurrentPeer()) return;
        setError("Could not read local settings.");
        setSelectionReady(true);
      }
    })();
    void getPwaDatabase().settings.put({ key: ACTIVE_PEER_SETTING, value: peer.id });
  }, [activePeerId, applyTimelineChange]);

  useEffect(() => {
    if (!selectionReady || startupState !== "ready" || !activePeerId || !identity) return;
    const peer = activePeerRef.current;
    if (!peer) return;
    const generation = selectionGenerationRef.current;
    const selectedRoom = roomIdRef.current;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void connectActivePeer(peer, generation, selectedRoom).then((dispose) => {
      if (!dispose) return;
      if (disposed || !isCurrentSelection(generation, peer.id, peer.remoteEpk, selectedRoom)) {
        dispose();
        return;
      }
      cleanup = dispose;
      connectionDisposeRef.current = dispose;
    });
    return () => {
      disposed = true;
      const latestDispose = connectionDisposeRef.current;
      connectionDisposeRef.current = null;
      latestDispose?.();
      interruptStreamingOutput();
      markPeerRoomsOffline(peer.remoteEpk);
      if (cleanup && cleanup !== latestDispose) cleanup();
      channelRef.current = null;
      relayRef.current = null;
    };
  }, [activePeerId, connectActivePeer, identity, interruptStreamingOutput, isCurrentSelection, markPeerRoomsOffline, roomId, selectionReady, startupState]);

  useEffect(() => {
    const reconnect = () => requestReconnect("closed");
    const goOffline = () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      reconnectRef.current = null;
      retryAttemptRef.current = 0;
      setRetryAttempt(0);
      invalidateConnection();
      setConnection("no_network");
    };
    window.addEventListener("online", reconnect);
    window.addEventListener("pageshow", reconnect);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", reconnect);
      window.removeEventListener("pageshow", reconnect);
      window.removeEventListener("offline", goOffline);
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      reconnectRef.current = null;
    };
  }, [invalidateConnection, requestReconnect]);

  const setImageAttachment = useCallback((source: Blob, label: string) => {
    if (!canAttachImage) {
      setError("Image attachments are unavailable for this connection.");
      return;
    }
    try {
      getImageOutputMime(source.type);
    } catch (imageError) {
      setError(imageError instanceof Error ? imageError.message : "Could not use that image.");
      return;
    }
    setAttachment({ source, previewUrl: URL.createObjectURL(source), label });
  }, [canAttachImage]);

  const sendMessage = useCallback(async () => {
    const text = draft.trim();
    const source = attachment?.source;
    const peer = activePeerRef.current;
    const channel = channelRef.current;
    const generation = selectionGenerationRef.current;
    const selectedRoom = roomIdRef.current;
    const scope = timelineRuntimeRef.current.currentScope;
    if ((!text && !source) || sendingImage || !peer || !channel || !scope || connectionRef.current !== "online" || !isCurrentSelection(generation, peer.id, peer.remoteEpk, selectedRoom, channel, relayRef.current || undefined)) return;
    if (source && !canAttachImage) {
      setError("Image attachments are unavailable for this connection.");
      return;
    }

    const clientRequestId = id();
    const requestId = id();
    let images: WireImage[] | undefined;
    if (source) {
      const frame: Omit<Extract<ClientFrame, { type: "user_message" }>, "images"> = {
        protocol_version: 2,
        type: "user_message",
        id: requestId,
        channel_id: scope.channelId,
        history_generation: scope.historyGeneration,
        client_request_id: clientRequestId,
        text,
      };
      setSendingImage(true);
      try {
        images = [await prepareImageAttachment(source, frame)];
      } catch (imageError) {
        setError(imageError instanceof Error ? imageError.message : "Could not prepare that image.");
        return;
      } finally {
        setSendingImage(false);
      }
      const currentScope = timelineRuntimeRef.current.currentScope;
      if (!currentScope || currentScope.sessionId !== scope.sessionId || currentScope.historyGeneration !== scope.historyGeneration) return;
    }

    const prepared = timelineRuntimeRef.current.sendUser(text, images, { clientRequestId, requestId });
    if (!prepared) return;
    if (!channel.send(prepared.frame)) {
      applyTimelineChange(timelineRuntimeRef.current.markUnknownDelivery(clientRequestId));
      setError("Relay is not connected.");
      return;
    }
    applyTimelineChange(prepared.change);
    scheduleScrollToLatest();
    setDraft((current) => current.trim() === text ? "" : current);
    setAttachment(null);
  }, [applyTimelineChange, attachment, canAttachImage, draft, isCurrentSelection, scheduleScrollToLatest, sendingImage]);

  const stopCurrentTask = useCallback(() => {
    const peer = activePeerRef.current;
    const channel = channelRef.current;
    const generation = selectionGenerationRef.current;
    const selectedRoom = roomIdRef.current;
    const scope = timelineRuntimeRef.current.currentScope;
    if (stopRequestIdRef.current || !peer || !channel || !scope || connectionRef.current !== "online" || !isCurrentSelection(generation, peer.id, peer.remoteEpk, selectedRoom, channel, relayRef.current || undefined)) return;
    const requestId = id();
    stopRequestIdRef.current = requestId;
    setStopRequestId(requestId);
    if (!channel.send({ protocol_version: 2, type: "cancel", id: requestId, channel_id: scope.channelId, history_generation: scope.historyGeneration })) {
      clearStopRequest(requestId);
      setError("Relay is not connected.");
    }
  }, [clearStopRequest, isCurrentSelection]);

  const sendCommandAction = useCallback((request: ComposerCommandRequest): boolean => {
    const peer = activePeerRef.current;
    const channel = channelRef.current;
    const generation = selectionGenerationRef.current;
    const selectedRoom = roomIdRef.current;
    const scope = timelineRuntimeRef.current.currentScope;
    const blocksWhileWorking = request.action === "session_new" || request.action === "session_compact";
    if (pendingActionRef.current || (blocksWhileWorking && activeRoom?.working === true) || !peer || !channel || !scope || connectionRef.current !== "online" || !isCurrentSelection(generation, peer.id, peer.remoteEpk, selectedRoom, channel, relayRef.current || undefined)) return false;
    const requestId = id();
    let frame: ClientFrame;
    switch (request.action) {
      case "session_new":
      case "session_compact":
        frame = { protocol_version: 2, type: request.action, id: requestId, channel_id: scope.channelId, history_generation: scope.historyGeneration };
        break;
      case "model_set":
        frame = { protocol_version: 2, type: "model_set", id: requestId, channel_id: scope.channelId, history_generation: scope.historyGeneration, provider: request.provider, model_id: request.modelId };
        break;
      case "thinking_set":
        frame = { protocol_version: 2, type: "thinking_set", id: requestId, channel_id: scope.channelId, history_generation: scope.historyGeneration, level: request.level };
        break;
    }
    pendingActionRef.current = { id: requestId, action: request.action };
    setPendingAction(pendingActionRef.current);
    if (!channel.send(frame)) {
      clearPendingAction(requestId);
      setError("Relay is not connected.");
      return false;
    }
    return true;
  }, [activeRoom?.working, clearPendingAction, isCurrentSelection]);

  const requestConfirmation = useCallback((action: ConfirmActionRequest, fallbackSelectors: readonly string[]) => {
    confirmOpenRef.current = true;
    confirmFocusOriginRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    confirmFocusFallbackSelectorsRef.current = fallbackSelectors;
    setConfirmError(null);
    setConfirmAction(action);
  }, []);

  const startNewSession = useCallback(() => {
    if (pendingActionRef.current || activeRoom?.working === true) return;
    requestConfirmation(
      { kind: "new-session" },
      ['button[aria-label="Pi commands"]', ".pwa-composer-input"],
    );
  }, [activeRoom?.working, requestConfirmation]);

  const compactSession = useCallback(() => {
    sendCommandAction({ action: "session_compact" });
  }, [sendCommandAction]);

  const setCommandModel = useCallback((model: WireModel) => {
    sendCommandAction({ action: "model_set", provider: model.provider, modelId: model.id });
  }, [sendCommandAction]);

  const setCommandThinking = useCallback((level: ThinkingLevel) => {
    sendCommandAction({ action: "thinking_set", level });
  }, [sendCommandAction]);

  const retryUnknownMessage = useCallback((clientRequestId: string) => {
    const peer = activePeerRef.current;
    const channel = channelRef.current;
    const generation = selectionGenerationRef.current;
    const selectedRoom = roomIdRef.current;
    if (!peer || !channel || connectionRef.current !== "online" || !isCurrentSelection(generation, peer.id, peer.remoteEpk, selectedRoom, channel, relayRef.current || undefined)) return;
    const prepared = timelineRuntimeRef.current.retryUnknown(clientRequestId);
    if (!prepared) return;
    if (!channel.send(prepared.frame)) {
      applyTimelineChange(timelineRuntimeRef.current.markUnknownDelivery(clientRequestId));
      setError("Relay is not connected.");
      return;
    }
    applyTimelineChange(prepared.change);
    scheduleScrollToLatest();
  }, [applyTimelineChange, isCurrentSelection, scheduleScrollToLatest]);

  const cancelQueuedMessage = useCallback((clientRequestId: string) => {
    const scope = timelineRuntimeRef.current.currentScope;
    const channel = channelRef.current;
    if (!scope || !channel || connectionRef.current !== "online") return;
    if (!channel.send({ protocol_version: 2, type: "queued_message_clear", id: id(), channel_id: scope.channelId, history_generation: scope.historyGeneration, target_id: clientRequestId })) {
      setError("Relay is not connected.");
    }
  }, []);

  const pairFromQr = useCallback(async (raw: string) => {
    if (!identity) return;
    setPairState("pairing");
    setError(null);
    const payload = parsePairUri(raw);
    if (!payload) { setError("That is not a valid Remote Pi pairing QR."); setPairState("scanning"); return; }
    if (relayMismatch(payload.relayUrl, relayUrl)) { setError("This QR belongs to a different Relay. Update the Relay setting first."); setPairState("scanning"); return; }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    let relay: RelayClient | null = null;
    let closePairing = () => {};
    try {
      const remotePeer = normalizePeerId(payload.epk);
      const pairingRelay = new RelayClient({ relayUrl: payload.relayUrl || relayUrl, identity });
      relay = pairingRelay;
      const pairedPeer = await new Promise<PwaPeerRecord | null>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (value: PwaPeerRecord | null) => { if (!timer) return; clearTimeout(timer); timer = null; resolve(value); };
        timer = setTimeout(() => { setError("Pairing timed out. Generate a fresh QR on the Pi."); finish(null); }, 15000);
        const channel = new PeerChannel({ relay: pairingRelay, remotePeer, roomId: payload.roomId || "main", onPairOk: (ok) => { const pairedRoomId = ok.room_id || payload.roomId || "main"; finish({ id: makePwaPeerId(remotePeer, pairedRoomId), remoteEpk: remotePeer, sessionName: ok.session_name, relayUrl: payload.relayUrl || relayUrl, pairedAt: new Date().toISOString(), hostname: ok.hostname, harness: ok.harness, roomId: pairedRoomId }); }, onPairError: (pairError) => { setError(pairError.message || pairError.code); finish(null); }, onMalformed: (reason) => { setError(reason); finish(null); } });
        closePairing = () => channel.close();
        void pairingRelay.connect().then(() => { channel.sendPairRequest(createPairRequest(payload.token, browserName(), id())); }).catch((connectError) => { setError(connectError instanceof Error ? connectError.message : "Could not connect to Relay."); finish(null); });
      });
      if (pairedPeer) {
        reconnectStateRef.current.userRecover();
        await getPwaDatabase().pairings.put(pairedPeer);
        const nextPeers = await listPwaPeers();
        setPeers(nextPeers);
        selectPeer(pairedPeer.id);
        setPairState("idle");
      } else setPairState("scanning");
    } finally {
      closePairing();
      relay?.close();
    }
  }, [identity, relayUrl, selectPeer]);

  const saveRelayUrl = useCallback(async (value: string) => {
    const normalized = value.trim().replace(/\/$/, "") || DEFAULT_RELAY;
    const updatedPeers = peers.map((peer) => ({ ...peer, relayUrl: normalized }));
    setRelayUrl(normalized);
    await Promise.all([
      getPwaDatabase().settings.put({ key: RELAY_SETTING, value: normalized }),
      getPwaDatabase().pairings.bulkPut(updatedPeers),
    ]);
    setPeers(updatedPeers);
    const activePeer = activePeerRef.current;
    if (activePeer) activePeerRef.current = { ...activePeer, relayUrl: normalized };
    setSettingsRequest(null);
    reconnectStateRef.current.userRecover();
    if (activePeer) restartActiveConnection();
  }, [peers, restartActiveConnection]);

  const removePeer = useCallback((peer: PwaPeerRecord) => {
    requestConfirmation(
      { kind: "remove-pairing", label: `${displayPeer(peer)} / ${peer.roomId || "main"}`, peer },
      [
        '.pwa-session-sheet button[aria-label="Close sessions"]',
        ".pwa-session-sheet .pwa-sheet-peer-select",
        'button[aria-label="Open session switcher"]',
        '.pwa-sidebar .pwa-button[data-tone="text"]',
        'button[aria-label="More options"]',
        'button[aria-label="Open settings"]',
      ],
    );
  }, [requestConfirmation]);

  const removePairingData = useCallback(async (peer: PwaPeerRecord) => {
    const roomKey = makePwaPeerId(peer.remoteEpk, peer.roomId);
    suppressRoomPersistenceRef.current.add(roomKey);
    try {
      if (activePeerIdRef.current === peer.id) {
        invalidateConnection();
        await flushLocalWrites();
      }
      await removePwaPairingData(peer.remoteEpk, peer.roomId, peer.id, `${ACTIVE_ROOM_SETTING}${peer.id}`);
      const nextPeers = await listPwaPeers();
      setPeers(nextPeers);
      if (activePeerIdRef.current === peer.id) selectPeer(nextPeers[0]?.id || null);
    } finally {
      suppressRoomPersistenceRef.current.delete(roomKey);
    }
  }, [flushLocalWrites, invalidateConnection, selectPeer]);

  const savePeerNickname = useCallback(async (peer: PwaPeerRecord, nickname: string) => {
    await getPwaDatabase().pairings.put({ ...peer, nickname });
    setPeers(await listPwaPeers());
  }, []);

  const clearLocalData = useCallback(async () => {
    requestConfirmation(
      { kind: "clear-local-data" },
      [
        '.pwa-settings-drawer .pwa-button[data-tone="danger"]',
        '.pwa-sidebar .pwa-button[data-tone="text"]',
        'button[aria-label="More options"]',
        'button[aria-label="Open settings"]',
      ],
    );
  }, [requestConfirmation]);

  const closeConfirmAction = useCallback(() => {
    if (confirmPendingRef.current) return;
    setConfirmAction(null);
    setConfirmError(null);
  }, []);

  const restoreConfirmFocus = useCallback(() => {
    const dialog = document.querySelector<HTMLElement>(".pwa-confirm-dialog");
    const candidates = [
      confirmFocusOriginRef.current,
      ...confirmFocusFallbackSelectorsRef.current.map((selector) => document.querySelector<HTMLElement>(selector)),
    ];
    const fallback = pickConfirmationFocusFallback(
      document.activeElement instanceof HTMLElement ? document.activeElement : null,
      candidates,
      (element) => element !== document.body && element !== document.documentElement && !dialog?.contains(element),
      (element) => element.isConnected && !element.matches(":disabled") && element.getClientRects().length > 0 && !element.closest('[aria-hidden="true"]'),
    );
    fallback?.focus({ preventScroll: true });
    confirmOpenRef.current = false;
    confirmFocusOriginRef.current = null;
    confirmFocusFallbackSelectorsRef.current = [];
  }, []);

  const confirmRequestedAction = useCallback(async () => {
    if (!confirmAction) return;
    await runConfirmAction(
      confirmAction,
      {
        startNewSession: () => sendCommandAction({ action: "session_new" }),
        removePairing: removePairingData,
        invalidateConnection,
        clearLocalData: clearPwaData,
        reload: () => window.location.reload(),
      },
      {
        pendingRef: confirmPendingRef,
        setPending: setConfirmPending,
        setError: setConfirmError,
        onSuccess: () => setConfirmAction(null),
      },
    );
  }, [confirmAction, invalidateConnection, removePairingData, sendCommandAction]);

  const resetLayout = useCallback(() => {
    if (confirmPendingRef.current) return;
    setSettingsRequest(null);
    setSessionSheetRequest(null);
    setRenameRequest(null);
    setConfirmAction(null);
    setConfirmPending(false);
    setConfirmError(null);
    setPairState("idle");
    setDraft("");
    setAttachment(null);
    scrollOnNextMessagesRef.current = false;
    followOutputRef.current = true;
    setFollowingOutput(true);
    setUnreadOutput(0);

    document.documentElement.style.removeProperty("width");
    document.documentElement.style.removeProperty("height");
    document.documentElement.style.removeProperty("overflow");
    document.body.style.removeProperty("width");
    document.body.style.removeProperty("height");
    document.body.style.removeProperty("overflow");
    document.querySelector<HTMLElement>(".pwa-root")?.style.removeProperty("width");
    document.querySelector<HTMLElement>(".pwa-root")?.style.removeProperty("height");
    document.querySelector<HTMLElement>(".pwa-root")?.style.removeProperty("overflow");

    setLayoutRevision((revision) => revision + 1);
    window.dispatchEvent(new Event("resize"));
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => scrollToLatest(false));
    });
  }, [scrollToLatest]);

  const openSessionSheet = useCallback(() => {
    setSessionSheetRequest({
      focusOrigin: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    });
  }, []);
  const closeSessionSheet = useCallback(() => {
    if (!canCloseBackgroundOverlay(confirmOpenRef.current, confirmPendingRef.current)) return;
    setSessionSheetRequest(null);
  }, []);
  const openRenamePeer = useCallback((peer: PwaPeerRecord) => {
    setRenameRequest({
      peer,
      focusOrigin: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      focusFallbackSelectors: [
        'button[aria-label="Open session switcher"]',
        '.pwa-sidebar button[aria-label^="Rename "]',
      ],
    });
    setSessionSheetRequest(null);
  }, []);
  const closeRenamePeer = useCallback(() => {
    setRenameRequest(null);
  }, []);
  const openSettings = useCallback(() => {
    setSettingsRequest({
      focusOrigin: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      focusFallbackSelectors: [
        'button[aria-label="Open settings"]',
        'button[aria-label="More options"]',
      ],
    });
  }, []);
  const closeSettings = useCallback(() => {
    if (!canCloseBackgroundOverlay(confirmOpenRef.current, confirmPendingRef.current)) return;
    setSettingsRequest(null);
  }, []);
  const viewModel: PwaAppViewModel = {
    startup: { state: startupState, error: startupError },
    status: { connection, retryAttempt, error, layoutRevision },
    workspace: {
      peers,
      rooms,
      activePeer,
      activePeerId,
      activeRoom,
      activeRooms,
      roomId,
      pairingPresence,
      lastSyncedLabel: formatSyncTime(lastSyncedAt),
      lastSyncedDateTime: lastSyncedAt ? new Date(lastSyncedAt).toISOString() : undefined,
    },
    timeline: { items: timelineItems, nextBefore, loadingEarlier, followingOutput, unreadOutput },
    composer: {
      attachment,
      canAttachImage,
      sendingImage,
      stopRequestId,
      draft,
      models,
      currentModel,
      activeThinking,
      pendingAction: pendingAction?.action ?? null,
    },
    overlays: {
      pairState,
      sessionSheetRequest,
      renameRequest,
      confirmAction,
      confirmPending,
      confirmError,
    },
    settings: { request: settingsRequest, relayUrl, defaultRelayUrl: DEFAULT_RELAY },
  };
  const actions: PwaAppViewActions = {
    startup: { retry: () => window.location.reload() },
    topbar: { refresh: refreshPwaApp, openSessionSheet, openSettings },
    workspace: {
      startPairing: () => setPairState("scanning"),
      selectPeer,
      selectRoom,
      openRenamePeer,
      removePeer,
      clearLocalData,
    },
    timeline: {
      loadEarlier,
      handleMessageListScroll,
      retryUnknownMessage,
      cancelQueuedMessage,
      restartConnection: restartActiveConnection,
      showLatest: () => { scrollToLatest(true); resumeFollowingOutput(); },
    },
    composer: {
      setDraft,
      sendMessage,
      stopCurrentTask,
      setImageAttachment,
      clearAttachment: () => setAttachment(null),
      startNewSession,
      compactSession,
      setCommandModel,
      setCommandThinking,
      refreshModels,
    },
    overlays: {
      setPairState: (state) => setPairState(state),
      pairFromQr,
      closeSessionSheet,
      savePeerNickname,
      closeRenamePeer,
      closeConfirmAction,
      confirmRequestedAction,
      restoreConfirmFocus,
      dismissError: () => setError(null),
    },
    settings: { saveRelayUrl, closeSettings, resetLayout },
  };
  const refs: PwaAppViewRefs = { messageListRef, bottomSentinelRef };

  return <PwaAppView viewModel={viewModel} actions={actions} refs={refs} />;
}
