"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity } from "lucide-react";
import { MessageComposer } from "@/components/pwa/message-composer";
import { RenamePairingDialog } from "@/components/pwa/rename-pairing-dialog";
import { ConfirmActionDialog } from "@/components/pwa/confirm-action-dialog";
import { COMPOSER_THINKING_LEVELS, type ComposerCommandAction } from "@/components/pwa/composer-command-menu";
import { MessageList } from "@/components/pwa/message-list";
import { describeStartupFailure, PairingDialog, StartupErrorView, StartupLoading, type StartupError } from "@/components/pwa/pwa-startup";
import { MobileTopbarMenu } from "@/components/pwa/mobile-topbar-menu";
import { DesktopTopbarActions, PwaMessageActions, PwaStatusToast, SessionSwitcherTrigger } from "@/components/pwa/pwa-app-actions";
import { SessionSheet } from "@/components/pwa/session-sheet";
import { SettingsPanel } from "@/components/pwa/settings-panel";
import { ConnectionStatus, DesktopSidebar, EmptyWorkspace, displayDevice, type ConnectionViewState, type PairingPresence } from "@/components/pwa/workspace-view";
import { createPairRequest, normalizePairDeviceId, parsePairUri, relayMismatch } from "@/lib/remote-pi/pairing";
import { PeerChannel } from "@/lib/remote-pi/peer-channel";
import { RelayClient } from "@/lib/remote-pi/relay-client";
import { generateOwnerKeyPair } from "@/lib/remote-pi/crypto";
import { acceptEndpointRuntime, assertBrowserCapabilities, browserName, fromStoredKey, mergeEndpoints, migrateLegacyDefaultRelay, toStoredKey, type ConnectionContext } from "@/lib/pwa/runtime";
import { TimelineRuntime, type TimelineScope, type TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { getImageOutputMime, prepareImageAttachment } from "@/lib/pwa/image-upload";
import { HistoryWindowAssembler, TimelineEventFragmentAssembler } from "@/lib/pwa/timeline-transfer";
import { commitRealtime, loadRecent, replaceRecentWindow, TimelineStoreConflictError } from "@/lib/pwa/timeline-store";
import { refreshPwaApp } from "@/lib/pwa/service-worker-update";
import type { ControlFrame, OwnerKeyPair, ThinkingLevel, WireImage, WireModel } from "@/lib/remote-pi/types";
import type { ClientFrame, ServerFrame } from "@/lib/remote-pi/protocol-v2/frames";
import type { TimelineEvent } from "@/lib/remote-pi/protocol-v2/schema";
import {
  clearPwaData,
  getPwaDatabase,
  listPwaDevices,
  listPwaEndpoints,
  makePwaDeviceId,
  makePwaEndpointId,
  openPwaDatabase,
  removePwaDeviceData,
  type PwaDeviceRecord,
  type PwaEndpointRecord,
} from "@/lib/pwa/db";

const LEGACY_DEFAULT_RELAY = "https://relay-rp1.jacobmoura.work";
const DEFAULT_RELAY = "https://relay-pi.yefengr.cn";
const ACTIVE_DEVICE_SETTING = "active_device";
const ACTIVE_ENDPOINT_SETTING = "active_endpoint:";
const RELAY_SETTING = "relay_url";
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000] as const;
type PairState = "idle" | "scanning" | "pairing";
type StartupState = "loading" | "ready" | "error";
type ImageAttachment = { source: Blob; previewUrl: string; label: string };
type ComposerCommandRequest =
  | { action: "session_new" | "session_compact" }
  | { action: "model_set"; provider: string; modelId: string }
  | { action: "thinking_set"; level: ThinkingLevel };
export type ConfirmActionRequest =
  | { kind: "new-session" }
  | { kind: "remove-pairing"; label: string; device: PwaDeviceRecord }
  | { kind: "clear-local-data" };
type ConfirmActionEffects = { startNewSession: () => boolean; removePairing: (device: PwaDeviceRecord) => Promise<void>; invalidateConnection: () => void; clearLocalData: () => Promise<void>; reload: () => void };
type ConfirmActionState = { pendingRef: { current: boolean }; setPending: (pending: boolean) => void; setError: (error: string | null) => void; onSuccess: () => void };

export async function runConfirmAction(action: ConfirmActionRequest, effects: ConfirmActionEffects, state: ConfirmActionState): Promise<"completed" | "failed" | "ignored"> {
  if (state.pendingRef.current) return "ignored";
  state.pendingRef.current = true;
  state.setPending(true);
  state.setError(null);
  try {
    if (action.kind === "new-session") {
      if (!effects.startNewSession()) throw new Error("Could not start a fresh session. Check the connection and try again.");
      state.onSuccess();
    } else if (action.kind === "remove-pairing") {
      await effects.removePairing(action.device);
      state.onSuccess();
    } else {
      effects.invalidateConnection();
      await effects.clearLocalData();
      effects.reload();
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

export function pickConfirmationFocusFallback<T>(activeElement: T | null, candidates: readonly (T | null)[], shouldKeepActive: (element: T) => boolean, canFocus: (element: T) => boolean): T | null {
  if (activeElement !== null && shouldKeepActive(activeElement)) return null;
  return candidates.find((candidate): candidate is T => candidate !== null && canFocus(candidate)) ?? null;
}
export function canCloseBackgroundOverlay(confirmOpen: boolean, confirmPending: boolean): boolean { return !confirmOpen && !confirmPending; }
function id(): string { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function formatSyncTime(timestamp?: number): string { return timestamp ? new Date(timestamp).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "never"; }
function safeThinkingLevel(value: unknown): ThinkingLevel { return typeof value === "string" && COMPOSER_THINKING_LEVELS.includes(value as ThinkingLevel) ? value as ThinkingLevel : "off"; }
function toEndpointRecord(deviceId: string, endpoint: Extract<ControlFrame, { type: "endpoints" }> ["endpoints"][number], online: boolean): PwaEndpointRecord {
  const metadata = endpoint.metadata;
  return { id: makePwaEndpointId(deviceId, endpoint.endpoint_id), deviceId, endpointId: endpoint.endpoint_id, runtimeInstanceId: endpoint.runtime_instance_id, kind: metadata.kind, name: metadata.name ?? undefined, cwd: metadata.cwd ?? undefined, pid: metadata.pid ?? undefined, startedAt: metadata.started_at ?? undefined, model: metadata.model ?? undefined, thinking: metadata.thinking ?? undefined, working: metadata.working ?? undefined, online, updatedAt: Date.now() };
}
function endpointRecordFromEvent(frame: Extract<ControlFrame, { type: "endpoint_announced" | "endpoint_updated" }>): PwaEndpointRecord {
  return toEndpointRecord(frame.device_id, { endpoint_id: frame.endpoint_id, runtime_instance_id: frame.runtime_instance_id, metadata: frame.metadata }, true);
}

export function PwaApp() {
  const [identity, setIdentity] = useState<OwnerKeyPair | null>(null);
  const [devices, setDevices] = useState<PwaDeviceRecord[]>([]);
  const [endpoints, setEndpoints] = useState<PwaEndpointRecord[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [activeEndpointId, setActiveEndpointId] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionViewState>("offline");
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY);
  const [timelineItems, setTimelineItems] = useState<TimelineViewItem[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<number>();
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<ImageAttachment | null>(null);
  const [sendingImage, setSendingImage] = useState(false);
  const [visionAvailable, setVisionAvailable] = useState<boolean | null>(null);
  const [models, setModels] = useState<WireModel[]>([]);
  const [currentModel, setCurrentModel] = useState<WireModel | null>(null);
  const [pendingAction, setPendingAction] = useState<{ id: string; action: ComposerCommandAction } | null>(null);
  const [stopRequestId, setStopRequestId] = useState<string | null>(null);
  const [pairState, setPairState] = useState<PairState>("idle");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [renameDevice, setRenameDevice] = useState<PwaDeviceRecord | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmActionRequest | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startupState, setStartupState] = useState<StartupState>("loading");
  const [startupError, setStartupError] = useState<StartupError | null>(null);
  const [followingOutput, setFollowingOutput] = useState(true);
  const [unreadOutput, setUnreadOutput] = useState(0);

  const devicesRef = useRef(devices);
  const endpointsRef = useRef(endpoints);
  const endpointRuntimeHistoryRef = useRef(new Map<string, Set<string>>());
  const endpointPersistChainRef = useRef(Promise.resolve());
  const activeDeviceIdRef = useRef(activeDeviceId);
  const activeEndpointIdRef = useRef(activeEndpointId);
  const relayRef = useRef<RelayClient | null>(null);
  const channelRef = useRef<PeerChannel | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionGenerationRef = useRef(0);
  const retryAttemptRef = useRef(0);
  const channelContextRef = useRef<ConnectionContext | null>(null);
  const timelineRuntimeRef = useRef(new TimelineRuntime());
  const historyAssemblerRef = useRef<HistoryWindowAssembler | null>(null);
  const historyModeRef = useRef<"recent" | "earlier">("recent");
  const fragmentAssemblerRef = useRef<TimelineEventFragmentAssembler | null>(null);
  const realtimeJournalRef = useRef(new Map<string, TimelineEvent>());
  const helloRequestRef = useRef<string | null>(null);
  const confirmPendingRef = useRef(false);
  const pendingActionRef = useRef<{ id: string; action: ComposerCommandAction } | null>(null);
  const stopRequestIdRef = useRef<string | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { devicesRef.current = devices; }, [devices]);
  useEffect(() => { endpointsRef.current = endpoints; }, [endpoints]);
  useEffect(() => { activeDeviceIdRef.current = activeDeviceId; }, [activeDeviceId]);
  useEffect(() => { activeEndpointIdRef.current = activeEndpointId; }, [activeEndpointId]);
  useEffect(() => () => { if (attachment) URL.revokeObjectURL(attachment.previewUrl); }, [attachment]);

  const activeDevice = useMemo(() => devices.find((device) => device.id === activeDeviceId) ?? null, [activeDeviceId, devices]);
  const activeEndpoint = useMemo(() => activeDevice && activeEndpointId ? endpoints.find((endpoint) => endpoint.deviceId === activeDevice.deviceId && endpoint.endpointId === activeEndpointId) ?? null : null, [activeDevice, activeEndpointId, endpoints]);
  const activeThinking = useMemo(() => safeThinkingLevel(activeEndpoint?.thinking), [activeEndpoint?.thinking]);
  const pairingPresence = useMemo<Record<string, PairingPresence>>(() => Object.fromEntries(devices.map((device) => {
    const deviceEndpoints = endpoints.filter((endpoint) => endpoint.deviceId === device.deviceId);
    const onlineEndpoints = deviceEndpoints.filter((endpoint) => endpoint.online).length;
    return [device.id, { status: deviceEndpoints.length === 0 ? "checking" : onlineEndpoints === 0 ? "offline" : onlineEndpoints === deviceEndpoints.length ? "online" : "partial", onlineEndpoints, totalEndpoints: deviceEndpoints.length, lastSeenAt: deviceEndpoints.find((endpoint) => endpoint.online)?.updatedAt }];
  })), [devices, endpoints]);

  const applyTimelineChange = useCallback((change: ReturnType<TimelineRuntime["receive"]>) => {
    setTimelineItems(change.items);
    for (const frame of change.observed) channelRef.current?.send(frame);
  }, []);
  const clearSessionConnection = useCallback(() => {
    connectionGenerationRef.current += 1;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    channelRef.current?.close();
    channelRef.current = null;
    channelContextRef.current = null;
    historyAssemblerRef.current = null;
    fragmentAssemblerRef.current?.reset();
    fragmentAssemblerRef.current = null;
    realtimeJournalRef.current.clear();
    helloRequestRef.current = null;
    pendingActionRef.current = null;
    stopRequestIdRef.current = null;
    setPendingAction(null);
    setStopRequestId(null);
    setVisionAvailable(null);
    setModels([]);
    setCurrentModel(null);
    setNextBefore(null);
    setLoadingEarlier(false);
    applyTimelineChange(timelineRuntimeRef.current.markDisconnected());
  }, [applyTimelineChange]);
  const scheduleReconnect = useCallback(() => {
    const device = devicesRef.current.find((candidate) => candidate.id === activeDeviceIdRef.current);
    const endpoint = device && endpointsRef.current.find((candidate) => candidate.deviceId === device.deviceId && candidate.endpointId === activeEndpointIdRef.current && candidate.online);
    if (!device || !endpoint || reconnectTimerRef.current || retryAttemptRef.current >= RETRY_DELAYS_MS.length || !navigator.onLine) return;
    const attempt = ++retryAttemptRef.current;
    setRetryAttempt(attempt);
    setConnection("retrying");
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      setActiveEndpointId(endpoint.endpointId);
    }, RETRY_DELAYS_MS[attempt - 1]);
  }, []);

  const persistEndpoints = useCallback((deviceId: string, next: PwaEndpointRecord[]) => {
    const operation = endpointPersistChainRef.current.then(async () => {
      const persisted = next.map((endpoint) => { const record = { ...endpoint }; delete record.online; return record; });
      await getPwaDatabase().endpoints.bulkPut(persisted);
      setEndpoints((current) => mergeEndpoints(current.filter((endpoint) => endpoint.deviceId !== deviceId), next));
    });
    endpointPersistChainRef.current = operation.catch(() => undefined);
    return operation;
  }, []);
  const applyControl = useCallback((frame: ControlFrame) => {
    const device = devicesRef.current.find((candidate) => candidate.deviceId === frame.device_id);
    if (!device) return;
    if (frame.type === "endpoints") {
      const snapshot = frame.endpoints.map((endpoint) => toEndpointRecord(frame.device_id, endpoint, true));
      const snapshotIds = new Set(snapshot.map((endpoint) => endpoint.id));
      const current = endpointsRef.current.filter((endpoint) => endpoint.deviceId === frame.device_id);
      const accepted = snapshot.filter((endpoint) => acceptEndpointRuntime(
        endpointRuntimeHistoryRef.current,
        current.find((candidate) => candidate.id === endpoint.id),
        endpoint,
      ));
      const acceptedIds = new Set(accepted.map((endpoint) => endpoint.id));
      const retained = current.filter((endpoint) => snapshotIds.has(endpoint.id) && !acceptedIds.has(endpoint.id));
      const stale = current.filter((endpoint) => !snapshotIds.has(endpoint.id)).map((endpoint) => ({ ...endpoint, online: false, updatedAt: Date.now() }));
      void persistEndpoints(frame.device_id, [...retained, ...accepted, ...stale]);
      return;
    }
    if (frame.type === "endpoint_announced" || frame.type === "endpoint_updated") {
      const next = endpointRecordFromEvent(frame);
      const current = endpointsRef.current.find((endpoint) => endpoint.id === next.id);
      if (!acceptEndpointRuntime(endpointRuntimeHistoryRef.current, current, next)) return;
      void persistEndpoints(frame.device_id, [...endpointsRef.current.filter((endpoint) => endpoint.id !== next.id), next]);
      return;
    }
    setEndpoints((current) => current.map((endpoint) => endpoint.deviceId === frame.device_id && endpoint.endpointId === frame.endpoint_id && endpoint.runtimeInstanceId === frame.runtime_instance_id ? { ...endpoint, online: false, updatedAt: Date.now() } : endpoint));
  }, [persistEndpoints]);

  const handleServerFrame = useCallback((frame: ServerFrame, context: ConnectionContext) => {
    const current = channelContextRef.current;
    if (!current || current.generation !== context.generation || current.deviceId !== context.deviceId || current.endpointId !== context.endpointId || current.runtimeInstanceId !== context.runtimeInstanceId || channelRef.current !== context.channel || relayRef.current !== context.relay) return;
    if (frame.type === "session_ready") {
      if (frame.in_reply_to !== helloRequestRef.current) return;
      helloRequestRef.current = null;
      const scope: TimelineScope = { deviceId: context.deviceId, endpointId: context.endpointId, runtimeInstanceId: context.runtimeInstanceId, sessionId: frame.session_id, historyGeneration: frame.history_generation, selfSenderRef: frame.self_sender_ref, channelId: context.channel.channelId };
      applyTimelineChange(timelineRuntimeRef.current.setScope(scope));
      fragmentAssemblerRef.current = new TimelineEventFragmentAssembler({ session_id: scope.sessionId, history_generation: scope.historyGeneration });
      const historyRequestId = id();
      historyModeRef.current = "recent";
      historyAssemblerRef.current = new HistoryWindowAssembler(historyRequestId, { session_id: scope.sessionId, history_generation: scope.historyGeneration });
      void loadRecent(scope).then((cached) => { if (timelineRuntimeRef.current.currentScope?.runtimeInstanceId === scope.runtimeInstanceId) applyTimelineChange(timelineRuntimeRef.current.replaceHistory(cached)); }).catch(() => setError("Could not read local history."));
      context.channel.send({ protocol_version: 2, type: "session_sync", id: historyRequestId, channel_id: scope.channelId, history_generation: scope.historyGeneration, before: null, limit: 5 });
      const modelRequestId = id();
      context.channel.send({ protocol_version: 2, type: "list_models", id: modelRequestId, channel_id: scope.channelId, history_generation: scope.historyGeneration });
      setConnection("online");
      return;
    }
    if (frame.type === "models_list") { setModels(frame.models); setCurrentModel(frame.current ?? null); setVisionAvailable(frame.current?.vision ?? null); return; }
    if (frame.type === "action_ok" || frame.type === "action_error") {
      if (pendingActionRef.current?.id !== frame.in_reply_to) return;
      pendingActionRef.current = null; setPendingAction(null);
      if (frame.type === "action_error") setError(frame.error);
      return;
    }
    if (frame.type === "cancelled") { stopRequestIdRef.current = null; setStopRequestId(null); return; }
    if (frame.type === "reset") { applyTimelineChange(timelineRuntimeRef.current.invalidateScope()); clearSessionConnection(); scheduleReconnect(); return; }
    const changed = timelineRuntimeRef.current.receive(frame);
    if (frame.type === "protocol_error") setError(frame.message);
    if (frame.type === "timeline_event_fragment") {
      const scope = timelineRuntimeRef.current.currentScope;
      if (!scope) return;
      const result = (fragmentAssemblerRef.current ??= new TimelineEventFragmentAssembler({ session_id: scope.sessionId, history_generation: scope.historyGeneration })).accept(frame);
      if (result.status === "complete") { realtimeJournalRef.current.set(result.event.event_id, result.event); applyTimelineChange(timelineRuntimeRef.current.commit(result.event)); void commitRealtime(scope, [result.event]).catch(() => setError("Could not update local history.")); }
      return;
    }
    if (frame.type === "timeline_event") {
      const scope = timelineRuntimeRef.current.currentScope;
      if (scope) { realtimeJournalRef.current.set(frame.event.event_id, frame.event); void commitRealtime(scope, [frame.event]).catch((writeError) => { setError(writeError instanceof TimelineStoreConflictError ? "Local timeline changed unexpectedly." : "Could not update local history."); }); }
    }
    if (frame.type === "session_history_chunk") {
      const result = historyAssemblerRef.current?.accept(frame);
      if (result?.status === "complete") {
        const scope = timelineRuntimeRef.current.currentScope;
        if (!scope) return;
        if (historyModeRef.current === "earlier") applyTimelineChange(timelineRuntimeRef.current.prependHistory(result.events));
        else { const journal = [...realtimeJournalRef.current.values()]; applyTimelineChange(timelineRuntimeRef.current.replaceHistory([...result.events, ...journal])); void replaceRecentWindow(scope, result.events, journal).catch(() => setError("Could not update local history.")); realtimeJournalRef.current.clear(); }
        setNextBefore(result.eos ? null : result.next_before ?? null);
        setLastSyncedAt(Date.now());
        setLoadingEarlier(false);
        historyAssemblerRef.current = null;
      }
      return;
    }
    applyTimelineChange(changed);
  }, [applyTimelineChange, clearSessionConnection, scheduleReconnect]);

  useEffect(() => {
    let cancelled = false;
    const database = getPwaDatabase();
    const removeFailure = database.onOpenFailure((failure) => { if (!cancelled) { setStartupError(describeStartupFailure(failure)); setStartupState("error"); } });
    void (async () => {
      assertBrowserCapabilities();
      const db = await openPwaDatabase();
      const storedIdentity = await db.identities.get("owner");
      const nextIdentity = storedIdentity ? { privateKey: fromStoredKey(storedIdentity.secretKey), publicKey: fromStoredKey(storedIdentity.publicKey) } : await generateOwnerKeyPair();
      if (!storedIdentity) await db.identities.put({ id: "owner", publicKey: toStoredKey(nextIdentity.publicKey), secretKey: toStoredKey(nextIdentity.privateKey), createdAt: Date.now() });
      const [storedDevices, storedRelay, storedActive] = await Promise.all([listPwaDevices(), db.settings.get(RELAY_SETTING), db.settings.get(ACTIVE_DEVICE_SETTING)]);
      if (cancelled) return;
      setIdentity(nextIdentity);
      setDevices(storedDevices);
      setRelayUrl(migrateLegacyDefaultRelay(storedRelay?.value, LEGACY_DEFAULT_RELAY, DEFAULT_RELAY));
      setActiveDeviceId(storedDevices.find((device) => device.id === storedActive?.value)?.id ?? storedDevices[0]?.id ?? null);
      setStartupState("ready");
    })().catch((failure: unknown) => { if (!cancelled) { setStartupError(describeStartupFailure(failure)); setStartupState("error"); } });
    return () => { cancelled = true; removeFailure(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!activeDevice) {
      queueMicrotask(() => {
        if (cancelled) return;
        setEndpoints([]);
        setActiveEndpointId(null);
      });
      return () => { cancelled = true; };
    }
    void listPwaEndpoints(activeDevice.deviceId)
      .then((stored) => { if (!cancelled) setEndpoints((current) => mergeEndpoints(stored.map((endpoint) => ({ ...endpoint, online: false })), current.filter((endpoint) => endpoint.deviceId === activeDevice.deviceId))); })
      .catch(() => { if (!cancelled) setError("Could not read local endpoints."); });
    void getPwaDatabase().settings.get(`${ACTIVE_ENDPOINT_SETTING}${activeDevice.id}`).then((setting) => { if (!cancelled) setActiveEndpointId(setting?.value ?? null); });
    void getPwaDatabase().settings.put({ key: ACTIVE_DEVICE_SETTING, value: activeDevice.id });
    return () => { cancelled = true; };
  }, [activeDevice]);

  useEffect(() => {
    if (!identity || startupState !== "ready" || devices.length === 0) return;
    const relay = new RelayClient({ relayUrl, identity });
    relayRef.current = relay;
    const unsubscribeControl = relay.on("control", applyControl);
    const unsubscribeState = relay.on("state", (state) => { if (state === "closed" && relayRef.current === relay) setConnection("offline"); });
    const unsubscribeError = relay.on("error", (eventError) => setError(eventError.message));
    void relay.connect().then(() => relay.subscribeEndpoints(devices.map((device) => device.deviceId))).catch((connectError) => setError(connectError instanceof Error ? connectError.message : "Relay connection failed"));
    return () => { unsubscribeControl(); unsubscribeState(); unsubscribeError(); if (relayRef.current === relay) relayRef.current = null; relay.close(); };
  }, [applyControl, devices, identity, relayUrl, startupState]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      clearSessionConnection();
      if (!activeDevice || !activeEndpoint || !activeEndpoint.online || !identity) { setConnection("offline"); return; }
      const relay = relayRef.current;
      if (!relay || relay.state !== "open") { setConnection("connecting"); return; }
      const generation = connectionGenerationRef.current;
      const contextBase = { generation, deviceId: activeDevice.deviceId, endpointId: activeEndpoint.endpointId, runtimeInstanceId: activeEndpoint.runtimeInstanceId, relay };
      const channel = new PeerChannel({ relay, endpoint: contextBase, onFrame: (frame) => {
        const currentChannel = channelRef.current;
        if (currentChannel) handleServerFrame(frame, { ...contextBase, channel: currentChannel });
      }, onMalformed: (reason) => setError(reason) });
      channelRef.current = channel;
      channelContextRef.current = { ...contextBase, channel };
      setConnection("connecting");
      retryAttemptRef.current = 0; setRetryAttempt(0);
      const helloId = id();
      helloRequestRef.current = helloId;
      if (!channel.send({ protocol_version: 2, type: "session_hello", id: helloId, channel_id: channel.channelId })) { setConnection("offline"); scheduleReconnect(); }
      channelRef.current = channel;
    });
    return () => {
      cancelled = true;
      const channel = channelRef.current;
      channel?.close();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [activeDevice, activeEndpoint, clearSessionConnection, handleServerFrame, identity, scheduleReconnect]);

  const selectDevice = useCallback((deviceId: string | null) => {
    setActiveDeviceId(deviceId); setActiveEndpointId(null); setTimelineItems([]); setLastSyncedAt(undefined); setError(null);
  }, []);
  const selectEndpoint = useCallback((endpointId: string) => {
    if (!activeDevice) return;
    setActiveEndpointId(endpointId);
    void getPwaDatabase().settings.put({ key: `${ACTIVE_ENDPOINT_SETTING}${activeDevice.id}`, value: endpointId });
  }, [activeDevice]);
  const sendMessage = useCallback(async () => {
    const scope = timelineRuntimeRef.current.currentScope;
    const channel = channelRef.current;
    const text = draft.trim();
    if ((!text && !attachment) || !scope || !channel || connection !== "online") return;
    let images: WireImage[] | undefined;
    if (attachment) {
      try { getImageOutputMime(attachment.source.type); setSendingImage(true); images = [await prepareImageAttachment(attachment.source, { protocol_version: 2, type: "user_message", id: id(), channel_id: scope.channelId, history_generation: scope.historyGeneration, client_request_id: id(), text })]; } catch (imageError) { setError(imageError instanceof Error ? imageError.message : "Could not prepare image."); return; } finally { setSendingImage(false); }
    }
    const prepared = timelineRuntimeRef.current.sendUser(text, images, { clientRequestId: id(), requestId: id() });
    if (!prepared) return;
    if (!channel.send(prepared.frame)) { applyTimelineChange(timelineRuntimeRef.current.markUnknownDelivery(prepared.frame.client_request_id)); setError("Relay is not connected."); return; }
    applyTimelineChange(prepared.change); setDraft(""); setAttachment(null);
  }, [applyTimelineChange, attachment, connection, draft]);
  const loadEarlier = useCallback(() => {
    const scope = timelineRuntimeRef.current.currentScope; const channel = channelRef.current;
    if (!scope || !channel || !nextBefore || loadingEarlier || connection !== "online") return;
    const requestId = id(); historyModeRef.current = "earlier"; historyAssemblerRef.current = new HistoryWindowAssembler(requestId, { session_id: scope.sessionId, history_generation: scope.historyGeneration }); setLoadingEarlier(true);
    if (!channel.send({ protocol_version: 2, type: "session_sync", id: requestId, channel_id: scope.channelId, history_generation: scope.historyGeneration, before: nextBefore, limit: 5 })) { setLoadingEarlier(false); setError("Relay is not connected."); }
  }, [connection, loadingEarlier, nextBefore]);
  const stopCurrentTask = useCallback(() => {
    const scope = timelineRuntimeRef.current.currentScope; const channel = channelRef.current;
    if (!scope || !channel || stopRequestIdRef.current) return;
    const requestId = id(); stopRequestIdRef.current = requestId; setStopRequestId(requestId);
    if (!channel.send({ protocol_version: 2, type: "cancel", id: requestId, channel_id: scope.channelId, history_generation: scope.historyGeneration })) { stopRequestIdRef.current = null; setStopRequestId(null); setError("Relay is not connected."); }
  }, []);
  const sendCommandAction = useCallback((request: ComposerCommandRequest): boolean => {
    const scope = timelineRuntimeRef.current.currentScope; const channel = channelRef.current;
    if (!scope || !channel || connection !== "online" || pendingActionRef.current) return false;
    const requestId = id();
    let frame: ClientFrame;
    if (request.action === "session_new" || request.action === "session_compact") frame = { protocol_version: 2, type: request.action, id: requestId, channel_id: scope.channelId, history_generation: scope.historyGeneration };
    else if (request.action === "model_set") frame = { protocol_version: 2, type: "model_set", id: requestId, channel_id: scope.channelId, history_generation: scope.historyGeneration, provider: request.provider, model_id: request.modelId };
    else {
      const thinking = request as Extract<ComposerCommandRequest, { action: "thinking_set" }>;
      frame = { protocol_version: 2, type: "thinking_set", id: requestId, channel_id: scope.channelId, history_generation: scope.historyGeneration, level: thinking.level };
    }
    pendingActionRef.current = { id: requestId, action: request.action }; setPendingAction(pendingActionRef.current);
    if (!channel.send(frame)) { pendingActionRef.current = null; setPendingAction(null); setError("Relay is not connected."); return false; }
    return true;
  }, [connection]);
  const pairFromQr = useCallback(async (raw: string) => {
    if (!identity) return;
    const payload = parsePairUri(raw);
    if (!payload || relayMismatch(payload.relayUrl, relayUrl)) { setError(payload ? "This QR belongs to a different Relay." : "That is not a valid endpoint pairing QR."); return; }
    setPairState("pairing"); setError(null);
    const deviceId = normalizePairDeviceId(payload.deviceId);
    const relay = new RelayClient({ relayUrl: payload.relayUrl || relayUrl, identity });
    let channel: PeerChannel | null = null;
    try {
      const paired = await new Promise<PwaDeviceRecord>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Pairing timed out. Generate a fresh QR on the Pi.")), 15000);
        channel = new PeerChannel({
          relay,
          endpoint: { deviceId, endpointId: payload.endpointId, runtimeInstanceId: payload.runtimeInstanceId },
          onPairOk: (ok) => {
            if (ok.endpoint_id !== payload.endpointId) { clearTimeout(timer); reject(new Error("Pairing response belongs to a different endpoint.")); return; }
            clearTimeout(timer);
            resolve({ id: makePwaDeviceId(deviceId), deviceId, relayUrl: payload.relayUrl || relayUrl, pairedAt: new Date().toISOString(), hostname: ok.hostname, harness: ok.harness });
          },
          onPairError: (pairError) => { clearTimeout(timer); reject(new Error(pairError.message)); },
          onMalformed: (reason) => { clearTimeout(timer); reject(new Error(reason)); },
        });
        void relay.connect().then(() => {
          if (!channel?.sendPairRequest(createPairRequest(payload.token, browserName(), id()))) throw new Error("Relay is not ready for pairing.");
        }).catch(reject);
      });
      const db = getPwaDatabase();
      await db.transaction("rw", [db.devices, db.settings], async () => {
        await Promise.all([
          db.devices.put(paired),
          db.settings.put({ key: `${ACTIVE_ENDPOINT_SETTING}${paired.id}`, value: payload.endpointId }),
        ]);
      });
      setDevices(await listPwaDevices());
      setActiveDeviceId(paired.id);
      setActiveEndpointId(payload.endpointId);
      setPairState("idle");
    } catch (pairingError) { setError(pairingError instanceof Error ? pairingError.message : "Pairing failed."); setPairState("scanning"); }
    finally {
      const pairingChannel = channel as PeerChannel | null;
      pairingChannel?.close();
      relay.close();
    }
  }, [identity, relayUrl]);
  const removePairing = useCallback(async (device: PwaDeviceRecord) => {
    if (activeDeviceIdRef.current === device.id) clearSessionConnection();
    await removePwaDeviceData(device.deviceId, device.id, `${ACTIVE_ENDPOINT_SETTING}${device.id}`);
    const remaining = await listPwaDevices(); setDevices(remaining);
    if (activeDeviceIdRef.current === device.id) selectDevice(remaining[0]?.id ?? null);
  }, [clearSessionConnection, selectDevice]);
  const saveDeviceNickname = useCallback(async (device: PwaDeviceRecord, nickname: string) => { await getPwaDatabase().devices.put({ ...device, nickname }); setDevices(await listPwaDevices()); }, []);
  const saveRelayUrl = useCallback(async (value: string) => {
    const normalized = value.trim().replace(/\/$/, "") || DEFAULT_RELAY;
    const updated = devices.map((device) => ({ ...device, relayUrl: normalized }));
    await Promise.all([getPwaDatabase().settings.put({ key: RELAY_SETTING, value: normalized }), getPwaDatabase().devices.bulkPut(updated)]);
    setRelayUrl(normalized); setDevices(updated); setSettingsOpen(false);
  }, [devices]);
  const setImageAttachment = useCallback((source: Blob, label: string) => { try { getImageOutputMime(source.type); setAttachment({ source, previewUrl: URL.createObjectURL(source), label }); } catch (imageError) { setError(imageError instanceof Error ? imageError.message : "Could not use that image."); } }, []);
  const confirmRequestedAction = useCallback(async () => {
    if (!confirmAction) return;
    await runConfirmAction(confirmAction, { startNewSession: () => sendCommandAction({ action: "session_new" }), removePairing, invalidateConnection: clearSessionConnection, clearLocalData: clearPwaData, reload: () => window.location.reload() }, { pendingRef: confirmPendingRef, setPending: setConfirmPending, setError: setConfirmError, onSuccess: () => setConfirmAction(null) });
  }, [clearSessionConnection, confirmAction, removePairing, sendCommandAction]);
  if (startupState === "loading") return <StartupLoading />;
  if (startupState === "error") return <StartupErrorView error={startupError} onRetry={() => window.location.reload()} />;
  const canAttachImage = connection === "online" && visionAvailable === true && !sendingImage;
  return <div className="pwa-root"><header className="pwa-topbar"><div className="pwa-brand"><span className="pwa-brand-mark">π</span><span>Remote Pi</span><span className="pwa-brand-tag">BROWSER APP</span></div><div className="pwa-topbar-actions"><SessionSwitcherTrigger label={activeDevice && activeEndpoint ? `Endpoint: ${displayDevice(activeDevice)} / ${activeEndpoint.name || activeEndpoint.endpointId}` : null} expanded={sheetOpen} onOpen={() => setSheetOpen(true)} /><ConnectionStatus state={connection} retryAttempt={retryAttempt} /><DesktopTopbarActions onRefresh={refreshPwaApp} onToggleSettings={() => setSettingsOpen(true)} /><MobileTopbarMenu onRefresh={refreshPwaApp} onOpenSettings={() => setSettingsOpen(true)} /></div></header>
    <div className="pwa-layout"><DesktopSidebar devices={devices} activeDeviceId={activeDeviceId} pairingPresence={pairingPresence} onPair={() => setPairState("scanning")} onSelect={selectDevice} onRename={setRenameDevice} onRemove={(device) => setConfirmAction({ kind: "remove-pairing", label: displayDevice(device), device })} onClearData={async () => setConfirmAction({ kind: "clear-local-data" })} /><main className="pwa-main">{activeDevice && activeEndpoint ? <><div className="pwa-chat-head"><div><span className="pwa-kicker">Active endpoint</span><h2>{activeEndpoint.name || activeEndpoint.endpointId}</h2><span className="pwa-chat-meta"><span className={connection === "online" ? "pwa-status-dot online" : "pwa-status-dot"} />{activeEndpoint.kind} <span className="pwa-separator">/</span> {activeEndpoint.cwd || "cwd unavailable"} <span className="pwa-separator">/</span> last synced <time dateTime={lastSyncedAt ? new Date(lastSyncedAt).toISOString() : undefined}>{formatSyncTime(lastSyncedAt)}</time></span></div></div><MessageList items={timelineItems} hasEarlier={nextBefore !== null} loadingEarlier={loadingEarlier} onLoadEarlier={loadEarlier} listRef={messageListRef} bottomSentinelRef={bottomSentinelRef} onScroll={() => setFollowingOutput(true)} onRetryUnknown={(requestId) => { const retry = timelineRuntimeRef.current.retryUnknown(requestId); if (retry && channelRef.current?.send(retry.frame)) applyTimelineChange(retry.change); }} onCancelQueued={(requestId) => { const scope = timelineRuntimeRef.current.currentScope; if (scope) channelRef.current?.send({ protocol_version: 2, type: "queued_message_clear", id: id(), channel_id: scope.channelId, history_generation: scope.historyGeneration, target_id: requestId }); }} /><div className="pwa-chat-footer"><PwaMessageActions show={connection === "offline" || !followingOutput || unreadOutput > 0} showRetry={connection === "offline"} showLatest={!followingOutput || unreadOutput > 0} unreadOutput={unreadOutput} onRetry={() => setActiveEndpointId(activeEndpoint.endpointId)} onLatest={() => { messageListRef.current?.scrollTo({ top: messageListRef.current.scrollHeight, behavior: "smooth" }); setFollowingOutput(true); setUnreadOutput(0); }} /><MessageComposer attachment={attachment} canAttachImage={canAttachImage} sendingImage={sendingImage} isOnline={connection === "online"} isWorking={activeEndpoint.working === true} stopping={stopRequestId !== null} draft={draft} onDraftChange={setDraft} onSend={sendMessage} onStop={stopCurrentTask} onSetAttachment={setImageAttachment} onClearAttachment={() => setAttachment(null)} commandModels={models} commandCurrentModel={currentModel} commandCurrentModelFallback={activeEndpoint.model ?? null} commandThinking={activeThinking} commandPendingAction={pendingAction?.action ?? null} onNewSession={() => setConfirmAction({ kind: "new-session" })} onCompactSession={() => sendCommandAction({ action: "session_compact" })} onSetModel={(model) => sendCommandAction({ action: "model_set", provider: model.provider, modelId: model.id })} onSetThinking={(level) => sendCommandAction({ action: "thinking_set", level })} onCommandsOpen={() => { const scope = timelineRuntimeRef.current.currentScope; if (scope) channelRef.current?.send({ protocol_version: 2, type: "list_models", id: id(), channel_id: scope.channelId, history_generation: scope.historyGeneration }); }} /></div></> : <EmptyWorkspace onPair={() => setPairState("scanning")} />}</main>{settingsOpen ? <SettingsPanel relayUrl={relayUrl} defaultRelayUrl={DEFAULT_RELAY} onSave={saveRelayUrl} onClose={() => setSettingsOpen(false)} onClearData={async () => setConfirmAction({ kind: "clear-local-data" })} onResetLayout={() => undefined} /> : null}</div>
    {sheetOpen ? <SessionSheet devices={devices} endpoints={endpoints} activeDeviceId={activeDeviceId} activeEndpointId={activeEndpointId} pairingPresence={pairingPresence} onSelectDevice={selectDevice} onSelectEndpoint={selectEndpoint} onPair={() => setPairState("scanning")} onRename={setRenameDevice} onRemove={(device) => setConfirmAction({ kind: "remove-pairing", label: displayDevice(device), device })} onClose={() => setSheetOpen(false)} /> : null}
    {renameDevice ? <RenamePairingDialog device={renameDevice} onSave={(nickname) => saveDeviceNickname(renameDevice, nickname)} onClose={() => setRenameDevice(null)} /> : null}
    {pairState !== "idle" ? <div className="pwa-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && pairState === "scanning") setPairState("idle"); }} role="presentation">{pairState === "scanning" ? <PairingDialog onScan={pairFromQr} onClose={() => setPairState("idle")} /> : <div className="pwa-pairing-card"><Activity className="pwa-spin" /><span className="pwa-kicker">Pairing</span><h2>Connecting to your Pi</h2><p>Waiting for the endpoint to confirm this browser.</p></div>}</div> : null}
    <ConfirmActionDialog action={confirmAction?.kind === "remove-pairing" ? { kind: "remove-pairing", label: confirmAction.label } : confirmAction} pending={confirmPending} error={confirmError} onConfirm={() => { void confirmRequestedAction(); }} onClose={() => { if (!confirmPendingRef.current) { setConfirmAction(null); setConfirmError(null); } }} />
    <PwaStatusToast message={error} onDismiss={() => setError(null)} /></div>;
}
