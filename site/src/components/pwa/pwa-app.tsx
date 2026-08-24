"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, Activity, MessageSquare, RefreshCw, Settings, X } from "lucide-react";
import { MessageList } from "@/components/pwa/message-list";
import { describeStartupFailure, PairingDialog, StartupErrorView, StartupLoading, type StartupError } from "@/components/pwa/pwa-startup";
import { SessionSheet } from "@/components/pwa/session-sheet";
import { SettingsPanel } from "@/components/pwa/settings-panel";
import { ConnectionStatus, DesktopSidebar, EmptyWorkspace, displayPeer, type ConnectionViewState } from "@/components/pwa/workspace-view";
import { createPairRequest, parsePairUri, relayMismatch } from "@/lib/remote-pi/pairing";
import { PeerChannel } from "@/lib/remote-pi/peer-channel";
import { RelayClient } from "@/lib/remote-pi/relay-client";
import { RelayConnectionLock } from "@/lib/pwa/connection-lock";
import { normalizePeerId } from "@/lib/remote-pi/encoding";
import { generateOwnerKeyPair } from "@/lib/remote-pi/crypto";
import { assertBrowserCapabilities, browserName, fromStoredKey, markStreamingMessagesInterrupted, mergeMessages, mergeRooms, migrateLegacyDefaultRelay, toStoredKey, upsertMessage, type ConnectionContext } from "@/lib/pwa/runtime";
import type { ControlFrame, OwnerKeyPair, ServerMessage, SessionHistoryEvent } from "@/lib/remote-pi/types";
import {
  clearPwaData,
  getPwaDatabase,
  getPwaSyncState,
  listPwaMessages,
  markPwaHistorySynced,
  openPwaDatabase,
  listPwaPeers,
  listPwaRooms,
  makePwaPeerId,
  removePwaPairingData,
  type PwaMessageRecord,
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
type PairState = "idle" | "scanning" | "pairing";
type StartupState = "loading" | "ready" | "error";
function id(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatSyncTime(timestamp: number | undefined): string {
  return timestamp ? new Date(timestamp).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "never";
}

export function PwaApp() {
  const [identity, setIdentity] = useState<OwnerKeyPair | null>(null);
  const [peers, setPeers] = useState<PwaPeerRecord[]>([]);
  const [rooms, setRooms] = useState<PwaRoomRecord[]>([]);
  const [activePeerId, setActivePeerId] = useState<string | null>(null);
  const [roomId, setRoomId] = useState("main");
  const [messages, setMessages] = useState<PwaMessageRecord[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | undefined>();
  const [connection, setConnection] = useState<ConnectionViewState>("offline");
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY);
  const [draft, setDraft] = useState("");
  const [pairState, setPairState] = useState<PairState>("idle");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionSheetOpen, setSessionSheetOpen] = useState(false);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [selectionReady, setSelectionReady] = useState(false);
  const [followingOutput, setFollowingOutput] = useState(true);
  const [unreadOutput, setUnreadOutput] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [startupState, setStartupState] = useState<StartupState>("loading");
  const [startupError, setStartupError] = useState<StartupError | null>(null);
  const channelRef = useRef<PeerChannel | null>(null);
  const relayRef = useRef<RelayClient | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionDisposeRef = useRef<(() => void) | null>(null);
  const relayLockRef = useRef<RelayConnectionLock | null>(null);
  const suppressRoomPersistenceRef = useRef(new Set<string>());
  const retryAttemptRef = useRef(0);
  const scheduleReconnectRef = useRef<(() => void) | null>(null);
  const selectionGenerationRef = useRef(0);
  const messageRevisionRef = useRef(0);
  const roomRevisionRef = useRef(0);
  const activeRoomSnapshotRef = useRef<Set<string> | null>(null);
  const activePeerIdRef = useRef<string | null>(null);
  const activePeerRef = useRef<PwaPeerRecord | null>(null);
  const connectionRef = useRef(connection);
  // Stream handlers update this synchronously; React state only mirrors it for rendering.
  const messagesRef = useRef(messages);
  const roomsRef = useRef(rooms);
  const pendingWritesRef = useRef(new Set<Promise<unknown>>());
  const roomIdRef = useRef(roomId);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const followOutputRef = useRef(true);
  const scrollOnNextMessagesRef = useRef(false);

  useEffect(() => { roomsRef.current = rooms; }, [rooms]);
  useEffect(() => { roomIdRef.current = roomId; }, [roomId]);
  useEffect(() => { connectionRef.current = connection; }, [connection]);
  const activePeer = useMemo(() => peers.find((peer) => peer.id === activePeerId) ?? null, [activePeerId, peers]);
  useEffect(() => {
    activePeerRef.current = activePeer;
    activePeerIdRef.current = activePeerId;
  }, [activePeer, activePeerId]);
  const activeRooms = useMemo(
    () => rooms.filter((room) => room.peerEpk === activePeer?.remoteEpk).sort((a, b) => (a.name || a.cwd || a.roomId).localeCompare(b.name || b.cwd || b.roomId)),
    [activePeer?.remoteEpk, rooms],
  );
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

  const persistMessage = useCallback((message: PwaMessageRecord) => {
    const write = trackWrite(getPwaDatabase().messages.put(message));
    void write.catch(() => {});
    return write;
  }, [trackWrite]);

  const interruptStreamingOutput = useCallback((peerEpk: string, selectedRoom: string) => {
    const interrupted = markStreamingMessagesInterrupted(messagesRef.current, peerEpk, selectedRoom);
    if (interrupted.every((message, index) => message === messagesRef.current[index])) return;
    messagesRef.current = interrupted;
    messageRevisionRef.current += 1;
    setMessages(interrupted);
    void trackWrite(getPwaDatabase().messages.bulkPut(interrupted.filter((message) => message.peerEpk === peerEpk && message.roomId === selectedRoom && message.status === "interrupted"))).catch(() => {});
  }, [trackWrite]);

  const markPeerRoomsOffline = useCallback(async (peerEpk: string) => {
    if (suppressRoomPersistenceRef.current.has(makePwaPeerId(peerEpk, roomIdRef.current))) return;
    const now = Date.now();
    const updated = roomsRef.current.map((room) => room.peerEpk === peerEpk && room.online ? { ...room, online: false, updatedAt: now } : room);
    if (updated.every((room, index) => room === roomsRef.current[index])) return;
    roomsRef.current = updated;
    if (activePeerRef.current?.remoteEpk === peerEpk) setRooms(updated);
    await trackWrite(getPwaDatabase().rooms.bulkPut(updated.filter((room) => room.peerEpk === peerEpk)));
  }, [trackWrite]);

  const addOrUpdateMessage = useCallback((next: PwaMessageRecord) => {
    const current = messagesRef.current;
    const index = current.findIndex((message) => message.id === next.id);
    const updated = upsertMessage(current, next);
    messagesRef.current = updated;
    messageRevisionRef.current += 1;
    setMessages(updated);
    if (next.status !== "streaming") void persistMessage(index < 0 ? next : updated[index]);
  }, [persistMessage]);

  const upsertRooms = useCallback(async (peerEpk: string, nextRooms: PwaRoomRecord[], generation: number) => {
    roomRevisionRef.current += 1;
    if (selectionGenerationRef.current === generation && activePeerRef.current?.remoteEpk === peerEpk) {
      const updated = mergeRooms(roomsRef.current.filter((room) => room.peerEpk !== peerEpk), nextRooms);
      roomsRef.current = updated;
      setRooms(updated);
    }
    await trackWrite(getPwaDatabase().rooms.bulkPut(nextRooms));
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
  }, [messages, scrollToLatest]);

  const applySessionHistory = useCallback(async (context: ConnectionContext, events: SessionHistoryEvent[], syncComplete: boolean) => {
    if (!isCurrentSelection(context.generation, context.peerId, context.peerEpk, context.roomId, context.channel, context.relay)) return;
    const requestRevision = messageRevisionRef.current;
    const records: PwaMessageRecord[] = [];
    for (const event of events) {
      if (event.type === "user_input") records.push({ id: event.id, peerEpk: context.peerEpk, roomId: context.roomId, kind: "user", text: event.text, createdAt: event.ts, status: "complete" });
      if (event.type === "agent_message") records.push({ id: `assistant-${event.in_reply_to}`, peerEpk: context.peerEpk, roomId: context.roomId, kind: "assistant", text: event.text, createdAt: event.ts, replyTo: event.in_reply_to, status: "complete" });
      if (event.type === "compaction") records.push({ id: `compaction-${event.ts}`, peerEpk: context.peerEpk, roomId: context.roomId, kind: "system", text: `Context compacted: ${event.summary}`, createdAt: event.ts, status: "complete" });
    }
    const uniqueRecords = Array.from(new Map(records.map((record) => [record.id, record])).values())
      .sort((a, b) => a.createdAt - b.createdAt);
    if (uniqueRecords.length) await trackWrite(getPwaDatabase().messages.bulkPut(uniqueRecords));
    if (!isCurrentSelection(context.generation, context.peerId, context.peerEpk, context.roomId, context.channel, context.relay)) return;
    const merged = requestRevision === messageRevisionRef.current
      ? mergeMessages(messagesRef.current, uniqueRecords)
      : mergeMessages(uniqueRecords, messagesRef.current);
    messagesRef.current = merged;
    messageRevisionRef.current += 1;
    scheduleScrollToLatest();
    setMessages(merged);
    if (syncComplete) {
      const syncedAt = Date.now();
      await trackWrite(markPwaHistorySynced(context.peerEpk, context.roomId, syncedAt));
      if (isCurrentSelection(context.generation, context.peerId, context.peerEpk, context.roomId, context.channel, context.relay)) setLastSyncedAt(syncedAt);
    }
  }, [isCurrentSelection, scheduleScrollToLatest, trackWrite]);

  const handleServerMessage = useCallback((message: ServerMessage, context: ConnectionContext) => {
    if (!isCurrentSelection(context.generation, context.peerId, context.peerEpk, context.roomId, context.channel, context.relay)) return;
    const now = Date.now();
    if (message.type === "agent_chunk") {
      const existing = messagesRef.current.find((item) => item.replyTo === message.in_reply_to && item.kind === "assistant");
      if (existing?.status === "interrupted") return;
      if (!existing) noteIncomingOutput();
      addOrUpdateMessage({ id: existing?.id ?? `assistant-${message.in_reply_to}`, peerEpk: context.peerEpk, roomId: context.roomId, kind: "assistant", text: `${existing?.text ?? ""}${message.delta}`, createdAt: existing?.createdAt ?? now, replyTo: message.in_reply_to, status: "streaming" });
    } else if (message.type === "agent_done") {
      const existing = messagesRef.current.find((item) => item.replyTo === message.in_reply_to && item.kind === "assistant");
      if (existing?.status === "streaming") addOrUpdateMessage({ ...existing, status: "complete" });
    } else if (message.type === "agent_message") {
      const existing = messagesRef.current.find((item) => item.replyTo === message.in_reply_to && item.kind === "assistant");
      if (!existing) noteIncomingOutput();
      addOrUpdateMessage({ id: existing?.id ?? `assistant-${message.in_reply_to}`, peerEpk: context.peerEpk, roomId: context.roomId, kind: "assistant", text: message.text, createdAt: existing?.createdAt ?? now, replyTo: message.in_reply_to, status: "complete" });
    } else if (message.type === "user_input" || message.type === "user_message") {
      if (!messagesRef.current.some((item) => item.id === message.id)) addOrUpdateMessage({ id: message.id, peerEpk: context.peerEpk, roomId: context.roomId, kind: "user", text: message.text, createdAt: now, status: "complete" });
    } else if (message.type === "session_history") {
      void applySessionHistory(context, message.events, message.eos);
    } else if (message.type === "compaction") {
      addOrUpdateMessage({ id: `compaction-${message.ts ?? now}`, peerEpk: context.peerEpk, roomId: context.roomId, kind: "system", text: `Context compacted: ${message.summary}`, createdAt: message.ts ?? now, status: "complete" });
    } else if (message.type === "error") {
      addOrUpdateMessage({ id: `error-${message.in_reply_to ?? id()}-${now}`, peerEpk: context.peerEpk, roomId: context.roomId, kind: "system", text: message.message, createdAt: now, status: "error" });
    }
  }, [addOrUpdateMessage, applySessionHistory, isCurrentSelection, noteIncomingOutput]);

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

  const connectActivePeer = useCallback(async (peer: PwaPeerRecord, generation: number, selectedRoom: string) => {
    if (!identity || !isCurrentSelection(generation, peer.id, peer.remoteEpk, selectedRoom)) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setConnection("no_network");
      return;
    }
    const relay = new RelayClient({ relayUrl: peer.relayUrl || relayUrl, identity });
    let channel: PeerChannel | null = null;
    const context = () => channel ? { generation, peerId: peer.id, peerEpk: peer.remoteEpk, roomId: selectedRoom, channel, relay } : null;
    channel = new PeerChannel({
      relay,
      remotePeer: peer.remoteEpk,
      roomId: selectedRoom,
      onMessage: (message) => { const current = context(); if (current) handleServerMessage(message, current); },
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
        setConnection("online");
      }
      if (state === "connecting" || state === "authenticating") setConnection("connecting");
      if (state === "closed") {
        interruptStreamingOutput(peer.remoteEpk, selectedRoom);
        void markPeerRoomsOffline(peer.remoteEpk);
        setConnection("offline");
        scheduleReconnectRef.current?.();
      }
    });
    const removeError = relay.on("error", (eventError) => {
      if (!channel || !isCurrentSelection(generation, peer.id, peer.remoteEpk, selectedRoom, channel, relay)) return;
      setError(eventError.message);
      scheduleReconnectRef.current?.();
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
      channel.send({ type: "session_sync", id: id(), limit: 200 });
    } catch (connectError) {
      if (channel && isCurrentSelection(generation, peer.id, peer.remoteEpk, selectedRoom, channel, relay)) {
        setError(connectError instanceof Error ? connectError.message : "Relay connection failed");
        scheduleReconnectRef.current?.();
      }
    }
    return dispose;
  }, [handleControlFrame, handleServerMessage, identity, interruptStreamingOutput, isCurrentSelection, markPeerRoomsOffline, relayUrl]);

  const invalidateConnection = useCallback((resetRetries = true) => {
    const previousPeer = activePeerRef.current;
    const previousRoom = roomIdRef.current;
    if (previousPeer) {
      interruptStreamingOutput(previousPeer.remoteEpk, previousRoom);
      void markPeerRoomsOffline(previousPeer.remoteEpk);
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
  }, [interruptStreamingOutput, markPeerRoomsOffline]);

  const restartActiveConnection = useCallback((resetRetries = true) => {
    const lock = relayLockRef.current;
    if (lock && !lock.ensureHeld()) {
      setConnection("tab_in_use");
      return;
    }
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
    if (reconnectRef.current || retryAttemptRef.current >= MAX_RETRY_ATTEMPTS) {
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
      if (selectionGenerationRef.current !== generation) return;
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
    roomRevisionRef.current += 1;
    messagesRef.current = [];
    messageRevisionRef.current += 1;
    setMessages([]);
    setLastSyncedAt(undefined);
    setDraft("");
    setUnreadOutput(0);
    scheduleScrollToLatest();
    setConnection(peerId ? (typeof navigator !== "undefined" && navigator.onLine ? "connecting" : "no_network") : "offline");
    setError(null);
  }, [invalidateConnection, peers, scheduleScrollToLatest]);

  const selectRoom = useCallback((nextRoom: string) => {
    const peer = activePeerRef.current;
    if (!peer || !nextRoom || nextRoom === roomIdRef.current) return;
    invalidateConnection();
    roomIdRef.current = nextRoom;
    setRoomId(nextRoom);
    setSelectionReady(true);
    messagesRef.current = [];
    messageRevisionRef.current += 1;
    setMessages([]);
    setLastSyncedAt(undefined);
    setDraft("");
    setUnreadOutput(0);
    scheduleScrollToLatest();
    setConnection(typeof navigator !== "undefined" && navigator.onLine ? "connecting" : "no_network");
    void getPwaDatabase().settings.put({ key: `${ACTIVE_ROOM_SETTING}${peer.id}`, value: nextRoom });
  }, [invalidateConnection, scheduleScrollToLatest]);

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
      setSelectionReady(false);
      setLastSyncedAt(undefined);
      messagesRef.current = [];
      messageRevisionRef.current += 1;
      setMessages([]);
      return;
    }
    setLastSyncedAt(undefined);
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
  }, [activePeerId]);

  useEffect(() => {
    const peer = activePeerRef.current;
    const generation = selectionGenerationRef.current;
    const selectedRoom = roomIdRef.current;
    const requestRevision = messageRevisionRef.current;
    if (!selectionReady || !activePeerId || !peer) return;
    void Promise.all([listPwaMessages(peer.remoteEpk, selectedRoom), getPwaSyncState(peer.remoteEpk, selectedRoom)]).then(([storedMessages, syncState]) => {
      if (!isCurrentSelection(generation, peer.id, peer.remoteEpk, selectedRoom)) return;
      setLastSyncedAt(syncState?.lastSyncedAt);
      const merged = requestRevision === messageRevisionRef.current ? storedMessages : mergeMessages(storedMessages, messagesRef.current);
      messagesRef.current = merged;
      messageRevisionRef.current += 1;
      scheduleScrollToLatest();
      setMessages(merged);
    }).catch(() => { if (isCurrentSelection(generation, peer.id, peer.remoteEpk, selectedRoom)) setError("Could not read local history."); });
  }, [activePeerId, isCurrentSelection, roomId, scheduleScrollToLatest, selectionReady]);

  useEffect(() => {
    if (!selectionReady || startupState !== "ready" || pairState !== "idle" || !activePeerId || !identity) return;
    const peer = activePeerRef.current;
    if (!peer) return;
    const generation = selectionGenerationRef.current;
    const selectedRoom = roomIdRef.current;
    const lock = new RelayConnectionLock();
    relayLockRef.current = lock;
    let disposed = false;
    let attemptInFlight = false;
    let cleanup: (() => void) | undefined;
    let removeAvailable: (() => void) | null = null;
    const removeLost = lock.onLost(() => {
      const latestDispose = connectionDisposeRef.current;
      connectionDisposeRef.current = null;
      latestDispose?.();
      interruptStreamingOutput(peer.remoteEpk, selectedRoom);
      void markPeerRoomsOffline(peer.remoteEpk);
      cleanup = undefined;
      setConnection("tab_in_use");
    });
    const tryConnect = async () => {
      if (disposed || attemptInFlight || cleanup) return;
      attemptInFlight = true;
      const acquired = await lock.acquire();
      attemptInFlight = false;
      if (disposed) {
        if (acquired) lock.release();
        return;
      }
      if (!acquired) {
        setConnection("tab_in_use");
        removeAvailable ??= lock.onAvailable(() => { void tryConnect(); });
        return;
      }
      removeAvailable?.();
      removeAvailable = null;
      const dispose = await connectActivePeer(peer, generation, selectedRoom);
      if (disposed || !isCurrentSelection(generation, peer.id, peer.remoteEpk, selectedRoom)) {
        dispose?.();
        lock.release();
        return;
      }
      if (!dispose) return;
      cleanup = dispose;
      connectionDisposeRef.current = dispose;
    };
    void tryConnect();
    const retryLock = setInterval(() => { if (!cleanup) void tryConnect(); }, 2000);
    return () => {
      disposed = true;
      clearInterval(retryLock);
      removeAvailable?.();
      removeLost();
      const latestDispose = connectionDisposeRef.current;
      connectionDisposeRef.current = null;
      latestDispose?.();
      interruptStreamingOutput(peer.remoteEpk, selectedRoom);
      void markPeerRoomsOffline(peer.remoteEpk);
      if (cleanup && cleanup !== latestDispose) cleanup();
      lock.release();
      lock.dispose();
      if (relayLockRef.current === lock) relayLockRef.current = null;
      channelRef.current = null;
      relayRef.current = null;
    };
  }, [activePeerId, connectActivePeer, identity, interruptStreamingOutput, isCurrentSelection, markPeerRoomsOffline, pairState, roomId, selectionReady, startupState]);

  useEffect(() => {
    const reconnect = () => scheduleReconnectRef.current?.();
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
  }, [invalidateConnection]);

  const sendMessage = useCallback(() => {
    const text = draft.trim();
    const peer = activePeerRef.current;
    const channel = channelRef.current;
    const generation = selectionGenerationRef.current;
    const selectedRoom = roomIdRef.current;
    if (!text || !peer || !channel || connectionRef.current !== "online" || !isCurrentSelection(generation, peer.id, peer.remoteEpk, selectedRoom, channel, relayRef.current || undefined)) return;
    const messageId = id();
    if (!channel.send({ type: "user_message", id: messageId, text })) { setError("Relay is not connected."); return; }
    addOrUpdateMessage({ id: messageId, peerEpk: peer.remoteEpk, roomId: selectedRoom, kind: "user", text, createdAt: Date.now(), status: "complete" });
    scheduleScrollToLatest();
    setDraft("");
  }, [addOrUpdateMessage, draft, isCurrentSelection, scheduleScrollToLatest]);

  const pairFromQr = useCallback(async (raw: string) => {
    if (!identity) return;
    setPairState("pairing");
    setError(null);
    const payload = parsePairUri(raw);
    if (!payload) { setError("That is not a valid Remote Pi pairing QR."); setPairState("scanning"); return; }
    if (relayMismatch(payload.relayUrl, relayUrl)) { setError("This QR belongs to a different Relay. Update the Relay setting first."); setPairState("scanning"); return; }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const pairingLock = new RelayConnectionLock();
    if (!await pairingLock.acquire()) {
      pairingLock.dispose();
      setError("Another Remote Pi tab is using the Relay connection.");
      setPairState("scanning");
      return;
    }
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
        const channel = new PeerChannel({ relay: pairingRelay, remotePeer, roomId: payload.roomId || "main", onPairOk: (ok) => { const pairedRoomId = ok.room_id || payload.roomId || "main"; finish({ id: makePwaPeerId(remotePeer, pairedRoomId), remoteEpk: remotePeer, sessionName: ok.session_name, relayUrl: payload.relayUrl || relayUrl, pairedAt: new Date().toISOString(), roomId: pairedRoomId }); }, onPairError: (pairError) => { setError(pairError.message || pairError.code); finish(null); }, onMalformed: (reason) => { setError(reason); finish(null); } });
        closePairing = () => channel.close();
        void pairingRelay.connect().then(() => { channel.sendPairRequest(createPairRequest(payload.token, browserName(), id())); }).catch((connectError) => { setError(connectError instanceof Error ? connectError.message : "Could not connect to Relay."); finish(null); });
      });
      if (pairedPeer) {
        await getPwaDatabase().pairings.put(pairedPeer);
        const nextPeers = await listPwaPeers();
        setPeers(nextPeers);
        selectPeer(pairedPeer.id);
        setPairState("idle");
      } else setPairState("scanning");
    } finally {
      closePairing();
      relay?.close();
      pairingLock.release();
      pairingLock.dispose();
    }
  }, [identity, relayUrl, selectPeer]);

  const saveRelayUrl = useCallback(async (value: string) => {
    const normalized = value.trim().replace(/\/$/, "");
    setRelayUrl(normalized || DEFAULT_RELAY);
    await getPwaDatabase().settings.put({ key: RELAY_SETTING, value: normalized || DEFAULT_RELAY });
    setSettingsOpen(false);
  }, []);

  const removePeer = useCallback(async (peer: PwaPeerRecord) => {
    const label = `${displayPeer(peer)} / ${peer.roomId || "main"}`;
    if (!window.confirm(`Delete pairing for ${label}? This removes this Pi/Room pairing from this browser.`)) return;
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

  const renamePeer = useCallback(async (peer: PwaPeerRecord) => {
    const nickname = window.prompt("Name this Pi", peer.nickname || peer.sessionName)?.trim();
    if (!nickname) return;
    await getPwaDatabase().pairings.put({ ...peer, nickname });
    setPeers(await listPwaPeers());
  }, []);

  const clearLocalData = useCallback(async () => {
    if (!window.confirm("Clear this browser's Remote Pi identity, pairings, and history?")) return;
    invalidateConnection();
    await clearPwaData();
    window.location.reload();
  }, [invalidateConnection]);

  const resetLayout = useCallback(() => {
    setSettingsOpen(false);
    setSessionSheetOpen(false);
    setPairState("idle");
    setDraft("");
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

  const closeSessionSheet = useCallback(() => setSessionSheetOpen(false), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  if (startupState === "loading") return <StartupLoading />;
  if (startupState === "error") return <StartupErrorView error={startupError} onRetry={() => window.location.reload()} />;

  return (
    <div className="pwa-root" key={layoutRevision}>
      <header className="pwa-topbar">
        <div className="pwa-brand"><span className="pwa-brand-mark">π</span><span>Remote Pi</span><span className="pwa-brand-tag">BROWSER APP</span></div>
        <div className="pwa-topbar-actions">
          {activePeer ? <button className="pwa-session-trigger" type="button" onClick={() => setSessionSheetOpen(true)} aria-haspopup="dialog" aria-expanded={sessionSheetOpen}><MessageSquare size={16} /><span>{displayPeer(activePeer)} / {roomId}</span></button> : null}
          <ConnectionStatus state={connection} retryAttempt={retryAttempt} />
          <button className="pwa-icon-button" type="button" onClick={() => window.location.reload()} aria-label="Refresh app" title="Refresh app"><RefreshCw size={18} /></button>
          <button className="pwa-icon-button" type="button" onClick={() => setSettingsOpen((open) => !open)} aria-label="Open settings" title="Settings"><Settings size={18} /></button>
        </div>
      </header>
      <div className="pwa-layout">
        <DesktopSidebar peers={peers} activePeerId={activePeerId} connection={connection} onPair={() => setPairState("scanning")} onSelect={selectPeer} onRename={(peer) => void renamePeer(peer)} onRemove={(peer) => void removePeer(peer)} onClearData={clearLocalData} />
        <main className="pwa-main">
          {activePeer ? <>
            <div className="pwa-chat-head"><div><span className="pwa-kicker">Active session</span><h2>{displayPeer(activePeer)}</h2><span className="pwa-chat-meta"><span className={connection === "online" ? "pwa-status-dot online" : "pwa-status-dot"} />{connection === "online" ? "Live" : connection === "tab_in_use" ? "Local history / another tab" : "Local history"} <span className="pwa-separator">/</span> room <code>{roomId}</code> <span className="pwa-separator">/</span> last synced <time dateTime={lastSyncedAt ? new Date(lastSyncedAt).toISOString() : undefined}>{formatSyncTime(lastSyncedAt)}</time></span></div><div className="pwa-room-control"><label htmlFor="room-id">Room</label><select id="room-id" value={roomId} disabled={connection !== "online"} onChange={(event) => selectRoom(event.target.value)}><option value={roomId}>{roomId}</option>{activeRooms.filter((room) => room.roomId !== roomId).map((room) => <option key={room.roomId} value={room.roomId}>{room.name || room.cwd || room.roomId}</option>)}</select></div></div>
            <MessageList messages={messages} listRef={messageListRef} bottomSentinelRef={bottomSentinelRef} onScroll={handleMessageListScroll} />
            {((connection !== "no_network" && (connection === "retrying" || connection === "offline")) || !followingOutput || unreadOutput > 0) ? <div className="pwa-message-actions">
              {connection !== "no_network" && (connection === "retrying" || connection === "offline") ? <button className="pwa-latest-button" type="button" onClick={() => restartActiveConnection(true)}><RefreshCw size={16} />Try again</button> : null}
              {!followingOutput || unreadOutput > 0 ? <button className="pwa-latest-button" type="button" onClick={() => { scrollToLatest(true); resumeFollowingOutput(); }}><ArrowDownToLine size={16} />{unreadOutput > 0 ? `${unreadOutput} new output` : "Latest"}</button> : null}
            </div> : null}
            <form className="pwa-composer" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={connection === "online" ? "Send a message to your agent..." : "Reconnect to send a message"} disabled={connection !== "online"} rows={2} /><button className="pwa-primary-button" type="submit" disabled={connection !== "online" || !draft.trim()}>Send <span>↗</span></button></form>
          </> : <EmptyWorkspace onPair={() => setPairState("scanning")} />}
        </main>
        {settingsOpen ? <SettingsPanel relayUrl={relayUrl} defaultRelayUrl={DEFAULT_RELAY} onSave={saveRelayUrl} onClose={closeSettings} onClearData={clearLocalData} onResetLayout={resetLayout} /> : null}
      </div>
      {sessionSheetOpen ? <SessionSheet peers={peers} rooms={rooms} activePeerId={activePeerId} activeRoomId={roomId} connection={connection} onSelectPeer={selectPeer} onSelectRoom={selectRoom} onPair={() => setPairState("scanning")} onRename={(peer) => void renamePeer(peer)} onRemove={(peer) => void removePeer(peer)} onClose={closeSessionSheet} /> : null}
      {pairState !== "idle" ? <div className="pwa-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && pairState === "scanning") setPairState("idle"); }} role="presentation">{pairState === "scanning" ? <PairingDialog onScan={pairFromQr} onClose={() => setPairState("idle")} /> : <div className="pwa-pairing-card"><Activity className="pwa-spin" /><span className="pwa-kicker">Pairing</span><h2>Connecting to your Pi</h2><p>Waiting for the Pi to confirm this browser.</p></div>}</div> : null}
      {error ? <div className="pwa-toast" role="status"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss"><X size={15} /></button></div> : null}
    </div>
  );
}
