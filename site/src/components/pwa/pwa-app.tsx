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
import { PeerChannel } from "@/lib/remote-pi/peer-channel";
import { RelayClient } from "@/lib/remote-pi/relay-client";
import { generateOwnerKeyPair } from "@/lib/remote-pi/crypto";
import { assertBrowserCapabilities, fromStoredKey, migrateLegacyDefaultRelay, toStoredKey, type ConnectionContext } from "@/lib/pwa/runtime";
import { useEndpointRegistry } from "@/lib/pwa/use-endpoint-registry";
import { useDevicePairing, type DevicePairingResult } from "@/lib/pwa/use-device-pairing";
import { useTimelineViewport } from "@/lib/pwa/use-timeline-viewport";
import { TimelineRuntime, type TimelineScope, type TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { getImageOutputMime, prepareImageAttachment } from "@/lib/pwa/image-upload";
import { HistoryWindowAssembler, TimelineEventFragmentAssembler } from "@/lib/pwa/timeline-transfer";
import { commitRealtime, loadRecent, replaceRecentWindow, TimelineStoreConflictError } from "@/lib/pwa/timeline-store";
import { refreshPwaApp } from "@/lib/pwa/service-worker-update";
import { ReconnectState, type ReconnectTrigger } from "@/lib/pwa/reconnect-state";
import { recoverServerFrame } from "@/lib/pwa/server-frame-recovery";
import type { OwnerKeyPair, ThinkingLevel, WireImage, WireModel } from "@/lib/remote-pi/types";
import type { ClientFrame, ServerFrame } from "@/lib/remote-pi/protocol-v2/frames";
import type { TimelineEvent } from "@/lib/remote-pi/protocol-v2/schema";
import {
  clearPwaData,
  getPwaDatabase,
  listPwaDevices,
  openPwaDatabase,
  removePwaDeviceData,
  type PwaDeviceRecord,
} from "@/lib/pwa/db";

const LEGACY_DEFAULT_RELAY = "https://relay-rp1.jacobmoura.work";
const DEFAULT_RELAY = "https://relay-pi.yefengr.cn";
const ACTIVE_DEVICE_SETTING = "active_device";
const ACTIVE_ENDPOINT_SETTING = "active_endpoint:";
const RELAY_SETTING = "relay_url";
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000] as const;
type StartupState = "loading" | "ready" | "error";
type ImageAttachment = { source: Blob; previewUrl: string; label: string };

function sameTimelineScope(current: TimelineScope | null, expected: TimelineScope): boolean {
  return current !== null
    && current.deviceId === expected.deviceId
    && current.endpointId === expected.endpointId
    && current.runtimeInstanceId === expected.runtimeInstanceId
    && current.sessionId === expected.sessionId
    && current.historyGeneration === expected.historyGeneration
    && current.selfSenderRef === expected.selfSenderRef
    && current.channelId === expected.channelId;
}

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
export function PwaApp() {
  const [identity, setIdentity] = useState<OwnerKeyPair | null>(null);
  const [devices, setDevices] = useState<PwaDeviceRecord[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [activeEndpointId, setActiveEndpointId] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionViewState>("offline");
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [relayConnectionGeneration, setRelayConnectionGeneration] = useState(0);
  const [sessionRestartToken, setSessionRestartToken] = useState(0);
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [renameDevice, setRenameDevice] = useState<PwaDeviceRecord | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmActionRequest | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startupState, setStartupState] = useState<StartupState>("loading");
  const [startupError, setStartupError] = useState<StartupError | null>(null);

  const devicesRef = useRef(devices);
  const activeDeviceIdRef = useRef(activeDeviceId);
  const relayRef = useRef<RelayClient | null>(null);
  const relayReconnectNowRef = useRef<(() => void) | null>(null);
  const channelRef = useRef<PeerChannel | null>(null);
  const intentionalRelayCloseRef = useRef(false);
  const relayReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionGenerationRef = useRef(0);
  const retryAttemptRef = useRef(0);
  const sessionChannelIdRef = useRef(id());
  const sessionRecoveryStateRef = useRef(new ReconnectState());
  const sessionIdentityRef = useRef<string | null>(null);
  const onlineRef = useRef(typeof navigator === "undefined" || navigator.onLine);
  const channelContextRef = useRef<ConnectionContext | null>(null);
  const timelineRuntimeRef = useRef(new TimelineRuntime());
  const historyAssemblerRef = useRef<HistoryWindowAssembler | null>(null);
  const historyModeRef = useRef<"recent" | "earlier">("recent");
  const fragmentAssemblerRef = useRef<TimelineEventFragmentAssembler | null>(null);
  const realtimeJournalRef = useRef(new Map<string, TimelineEvent>());
  const helloRequestRef = useRef<string | null>(null);
  const modelRequestRef = useRef<string | null>(null);
  const confirmPendingRef = useRef(false);
  const pendingActionRef = useRef<{ id: string; action: ComposerCommandAction } | null>(null);
  const stopRequestIdRef = useRef<string | null>(null);
  const {
    followingOutput,
    unreadOutput,
    messageListRef,
    bottomSentinelRef,
    receiveRealtimeOutput,
    handleScroll,
    showLatest,
    reset: resetOutputFollowing,
  } = useTimelineViewport();

  useEffect(() => { devicesRef.current = devices; }, [devices]);
  useEffect(() => { activeDeviceIdRef.current = activeDeviceId; }, [activeDeviceId]);
  useEffect(() => () => { if (attachment) URL.revokeObjectURL(attachment.previewUrl); }, [attachment]);

  const activeDevice = useMemo(() => devices.find((device) => device.id === activeDeviceId) ?? null, [activeDeviceId, devices]);
  const { endpoints, applyControl, markAllOffline, invalidatePersistence } = useEndpointRegistry({ devices, activeDevice, onError: setError });
  const activeEndpoint = useMemo(() => activeDevice && activeEndpointId ? endpoints.find((endpoint) => endpoint.deviceId === activeDevice.deviceId && endpoint.endpointId === activeEndpointId) ?? null : null, [activeDevice, activeEndpointId, endpoints]);
  const activeThinking = useMemo(() => safeThinkingLevel(activeEndpoint?.thinking), [activeEndpoint?.thinking]);
  const sessionDeviceId = activeDevice?.deviceId ?? null;
  const sessionEndpointId = activeEndpoint?.endpointId ?? null;
  const sessionRuntimeInstanceId = activeEndpoint?.runtimeInstanceId ?? null;
  const sessionOnline = activeEndpoint?.online === true;
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
    channelRef.current?.close();
    channelRef.current = null;
    channelContextRef.current = null;
    historyAssemblerRef.current = null;
    fragmentAssemblerRef.current?.reset();
    fragmentAssemblerRef.current = null;
    realtimeJournalRef.current.clear();
    helloRequestRef.current = null;
    modelRequestRef.current = null;
    pendingActionRef.current = null;
    stopRequestIdRef.current = null;
    setPendingAction(null);
    setStopRequestId(null);
    setVisionAvailable(null);
    setModels([]);
    setCurrentModel(null);
    setNextBefore(null);
    setLoadingEarlier(false);
    resetOutputFollowing();
    applyTimelineChange(timelineRuntimeRef.current.markDisconnected());
  }, [applyTimelineChange, resetOutputFollowing]);
  const restartSession = useCallback(() => {
    sessionRecoveryStateRef.current.replacementBye();
    clearSessionConnection();
    if (!onlineRef.current) { setConnection("no_network"); return; }
    setConnection("connecting");
    setSessionRestartToken((token) => token + 1);
  }, [clearSessionConnection]);
  const disconnectSession = useCallback(() => {
    sessionRecoveryStateRef.current.terminalBye();
    clearSessionConnection();
    setConnection(onlineRef.current ? "offline" : "no_network");
  }, [clearSessionConnection]);
  const retryCurrentSession = useCallback(() => {
    sessionRecoveryStateRef.current.userRecover();
    clearSessionConnection();
    if (!onlineRef.current) { setConnection("no_network"); return; }
    const relay = relayRef.current;
    if (!relay || relay.state !== "open") {
      setConnection("connecting");
      relayReconnectNowRef.current?.();
      return;
    }
    setConnection("connecting");
    setSessionRestartToken((token) => token + 1);
  }, [clearSessionConnection]);

  const handleServerFrame = useCallback((frame: ServerFrame, context: ConnectionContext) => {
    const current = channelContextRef.current;
    if (!current || current.generation !== context.generation || current.deviceId !== context.deviceId || current.endpointId !== context.endpointId || current.runtimeInstanceId !== context.runtimeInstanceId || channelRef.current !== context.channel || relayRef.current !== context.relay) return;
    if (frame.type === "reset" || frame.type === "bye") {
      const scope = timelineRuntimeRef.current.currentScope;
      if (!scope || scope.sessionId !== frame.session_id) return;
      if (frame.type === "bye" && scope.historyGeneration !== frame.history_generation) return;
    }
    const recoveryAction = recoverServerFrame(frame, {
      invalidateScope: () => applyTimelineChange(timelineRuntimeRef.current.invalidateScope()),
      rehello: restartSession,
      reconnect: restartSession,
      disconnect: disconnectSession,
    });
    if (recoveryAction !== "ignore") return;
    if (frame.type === "session_ready") {
      if (frame.in_reply_to !== helloRequestRef.current) return;
      helloRequestRef.current = null;
      const scope: TimelineScope = { deviceId: context.deviceId, endpointId: context.endpointId, runtimeInstanceId: context.runtimeInstanceId, sessionId: frame.session_id, historyGeneration: frame.history_generation, selfSenderRef: frame.self_sender_ref, channelId: context.channel.channelId };
      resetOutputFollowing();
      applyTimelineChange(timelineRuntimeRef.current.setScope(scope));
      fragmentAssemblerRef.current = new TimelineEventFragmentAssembler({ session_id: scope.sessionId, history_generation: scope.historyGeneration });
      const historyRequestId = id();
      historyModeRef.current = "recent";
      historyAssemblerRef.current = new HistoryWindowAssembler(historyRequestId, { session_id: scope.sessionId, history_generation: scope.historyGeneration });
      void loadRecent(scope).then((cached) => { if (sameTimelineScope(timelineRuntimeRef.current.currentScope, scope)) applyTimelineChange(timelineRuntimeRef.current.replaceHistory(cached)); }).catch(() => setError("Could not read local history."));
      context.channel.send({ protocol_version: 2, type: "session_sync", id: historyRequestId, channel_id: scope.channelId, history_generation: scope.historyGeneration, before: null, limit: 5 });
      const modelRequestId = id();
      modelRequestRef.current = modelRequestId;
      context.channel.send({ protocol_version: 2, type: "list_models", id: modelRequestId, channel_id: scope.channelId, history_generation: scope.historyGeneration });
      setConnection("online");
      return;
    }
    if (frame.type === "models_list") {
      if (frame.in_reply_to !== modelRequestRef.current) return;
      modelRequestRef.current = null;
      setModels(frame.models); setCurrentModel(frame.current ?? null); setVisionAvailable(frame.current?.vision ?? null); return;
    }
    if (frame.type === "action_ok" || frame.type === "action_error") {
      if (pendingActionRef.current?.id !== frame.in_reply_to) return;
      pendingActionRef.current = null; setPendingAction(null);
      if (frame.type === "action_error") setError(frame.error);
      return;
    }
    if (frame.type === "cancelled") {
      if (frame.in_reply_to !== stopRequestIdRef.current) return;
      stopRequestIdRef.current = null; setStopRequestId(null); return;
    }
    const changed = timelineRuntimeRef.current.receive(frame);
    if (frame.type === "protocol_error") setError(frame.message);
    if (frame.type === "timeline_event_fragment") {
      const scope = timelineRuntimeRef.current.currentScope;
      if (!scope) return;
      const result = (fragmentAssemblerRef.current ??= new TimelineEventFragmentAssembler({ session_id: scope.sessionId, history_generation: scope.historyGeneration })).accept(frame);
      if (result.status === "complete") {
        if (result.event.kind === "assistant" || result.event.kind === "tool" || result.event.kind === "provider_error") receiveRealtimeOutput(result.event.group_id);
        realtimeJournalRef.current.set(result.event.event_id, result.event);
        applyTimelineChange(timelineRuntimeRef.current.commit(result.event));
        void commitRealtime(scope, [result.event]).catch(() => setError("Could not update local history."));
      }
      return;
    }
    if (frame.type === "timeline_event") {
      if (frame.event.kind === "assistant" || frame.event.kind === "tool" || frame.event.kind === "provider_error") receiveRealtimeOutput(frame.event.group_id);
      const scope = timelineRuntimeRef.current.currentScope;
      if (scope) { realtimeJournalRef.current.set(frame.event.event_id, frame.event); void commitRealtime(scope, [frame.event]).catch((writeError) => { setError(writeError instanceof TimelineStoreConflictError ? "Local timeline changed unexpectedly." : "Could not update local history."); }); }
    }
    if (frame.type === "timeline_partial") receiveRealtimeOutput(frame.group_id);
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
  }, [applyTimelineChange, disconnectSession, receiveRealtimeOutput, resetOutputFollowing, restartSession]);

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
        if (!cancelled) setActiveEndpointId(null);
      });
      return () => { cancelled = true; };
    }
    void getPwaDatabase().settings.get(`${ACTIVE_ENDPOINT_SETTING}${activeDevice.id}`).then((setting) => { if (!cancelled) setActiveEndpointId(setting?.value ?? null); });
    void getPwaDatabase().settings.put({ key: ACTIVE_DEVICE_SETTING, value: activeDevice.id });
    return () => { cancelled = true; };
  }, [activeDevice]);

  useEffect(() => {
    if (!identity || startupState !== "ready" || devices.length === 0) return;
    let cancelled = false;
    let activeToken = 0;
    const controller = new ReconnectState();
    const relay = new RelayClient({ relayUrl, identity });
    relayRef.current = relay;
    let connectRelay: (token: number) => void = () => undefined;
    const scheduleRelayReconnect = (trigger: ReconnectTrigger): boolean => {
      if (cancelled || !onlineRef.current) { if (!onlineRef.current) setConnection("no_network"); return false; }
      if (retryAttemptRef.current >= RETRY_DELAYS_MS.length) { setConnection("offline"); return false; }
      const attempt = retryAttemptRef.current + 1;
      const token = activeToken;
      if (!controller.request(trigger, () => {
        relayReconnectTimerRef.current = setTimeout(() => {
          relayReconnectTimerRef.current = null;
          if (cancelled || !onlineRef.current) { controller.cancel(); setConnection("no_network"); return; }
          activeToken = controller.beginConnection();
          connectRelay(activeToken);
        }, RETRY_DELAYS_MS[attempt - 1]);
      }, token)) return false;
      retryAttemptRef.current = attempt;
      setRetryAttempt(attempt);
      setConnection("retrying");
      return true;
    };
    connectRelay = (token: number) => {
      if (cancelled || !onlineRef.current) return;
      intentionalRelayCloseRef.current = false;
      setConnection("connecting");
      void relay.connect().then(() => {
        if (cancelled || relayRef.current !== relay || !onlineRef.current || token !== activeToken) return;
        activeToken = controller.beginConnection();
        retryAttemptRef.current = 0;
        setRetryAttempt(0);
        if (!relay.subscribeEndpoints(devicesRef.current.map((device) => device.deviceId))) {
          relay.close(1000, "Relay subscription failed");
          return;
        }
        setRelayConnectionGeneration((generation) => generation + 1);
      }).catch((connectError: unknown) => {
        if (cancelled || relayRef.current !== relay) return;
        setError(connectError instanceof Error ? connectError.message : "Relay connection failed");
        scheduleRelayReconnect("connect_rejected");
      });
    };
    const reconnectNow = () => {
      if (cancelled || !onlineRef.current) { if (!onlineRef.current) setConnection("no_network"); return; }
      if (relayReconnectTimerRef.current) { clearTimeout(relayReconnectTimerRef.current); relayReconnectTimerRef.current = null; }
      controller.userRecover();
      retryAttemptRef.current = 0;
      setRetryAttempt(0);
      activeToken = controller.beginConnection();
      connectRelay(activeToken);
    };
    relayReconnectNowRef.current = reconnectNow;
    const unsubscribeControl = relay.on("control", applyControl);
    const unsubscribeState = relay.on("state", (state) => {
      if (cancelled || relayRef.current !== relay) return;
      if (state === "closed") {
        clearSessionConnection();
        if (!onlineRef.current) { intentionalRelayCloseRef.current = false; setConnection("no_network"); return; }
        if (intentionalRelayCloseRef.current) {
          intentionalRelayCloseRef.current = false;
          setConnection("offline");
          return;
        }
        markAllOffline();
        if (!scheduleRelayReconnect("closed") && !relayReconnectTimerRef.current) setConnection("offline");
      }
    });
    const unsubscribeError = relay.on("error", (eventError) => {
      if (cancelled || relayRef.current !== relay) return;
      setError(eventError.message);
      scheduleRelayReconnect("error");
    });
    const handleOffline = () => {
      onlineRef.current = false;
      intentionalRelayCloseRef.current = false;
      controller.cancel();
      if (relayReconnectTimerRef.current) { clearTimeout(relayReconnectTimerRef.current); relayReconnectTimerRef.current = null; }
      clearSessionConnection();
      relay.close(1000, "browser offline");
      setConnection("no_network");
    };
    const handleOnline = () => {
      onlineRef.current = true;
      controller.userRecover();
      retryAttemptRef.current = 0;
      setRetryAttempt(0);
      if (relay.state === "open") setRelayConnectionGeneration((generation) => generation + 1);
      else reconnectNow();
    };
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    onlineRef.current = typeof navigator === "undefined" || navigator.onLine;
    activeToken = controller.beginConnection();
    if (onlineRef.current) connectRelay(activeToken);
    else setConnection("no_network");
    return () => {
      cancelled = true;
      controller.cancel();
      if (relayReconnectTimerRef.current) { clearTimeout(relayReconnectTimerRef.current); relayReconnectTimerRef.current = null; }
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      unsubscribeControl();
      unsubscribeState();
      unsubscribeError();
      if (relayReconnectNowRef.current === reconnectNow) relayReconnectNowRef.current = null;
      if (relayRef.current === relay) relayRef.current = null;
      relay.close();
    };
  }, [applyControl, clearSessionConnection, devices.length, identity, markAllOffline, relayUrl, startupState]);

  useEffect(() => {
    const relay = relayRef.current;
    if (!relay || relay.state !== "open") return;
    relay.subscribeEndpoints(devices.map((device) => device.deviceId));
  }, [devices]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const sessionIdentity = sessionDeviceId && sessionEndpointId && sessionRuntimeInstanceId
        ? `${sessionDeviceId}\u0000${sessionEndpointId}\u0000${sessionRuntimeInstanceId}`
        : null;
      if (sessionIdentityRef.current !== sessionIdentity) {
        sessionRecoveryStateRef.current.replacementBye();
        sessionIdentityRef.current = sessionIdentity;
      }
      clearSessionConnection();
      if (sessionRecoveryStateRef.current.isTerminal) { setConnection("offline"); return; }
      if (!sessionDeviceId || !sessionEndpointId || !sessionRuntimeInstanceId || !sessionOnline || !identity) {
        setConnection(onlineRef.current ? "offline" : "no_network");
        return;
      }
      const relay = relayRef.current;
      if (!relay || relay.state !== "open") { setConnection(onlineRef.current ? "connecting" : "no_network"); return; }
      const generation = connectionGenerationRef.current;
      const contextBase = { generation, deviceId: sessionDeviceId, endpointId: sessionEndpointId, runtimeInstanceId: sessionRuntimeInstanceId, relay };
      let channel: PeerChannel | null = null;
      channel = new PeerChannel({ relay, endpoint: contextBase, channelId: sessionChannelIdRef.current, onFrame: (frame) => {
        if (channel) handleServerFrame(frame, { ...contextBase, channel });
      }, onMalformed: (reason) => setError(reason) });
      channelRef.current = channel;
      channelContextRef.current = { ...contextBase, channel };
      setConnection("connecting");
      sessionRecoveryStateRef.current.beginConnection();
      const helloId = id();
      helloRequestRef.current = helloId;
      if (!channel.send({ protocol_version: 2, type: "session_hello", id: helloId, channel_id: channel.channelId })) {
        setConnection("offline");
        intentionalRelayCloseRef.current = true;
        relay.close(1000, "Session channel send failed");
      }
    });
    return () => {
      cancelled = true;
      const channel = channelRef.current;
      channel?.close();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [clearSessionConnection, handleServerFrame, identity, relayConnectionGeneration, sessionDeviceId, sessionEndpointId, sessionOnline, sessionRestartToken, sessionRuntimeInstanceId, startupState]);

  const selectDevice = useCallback((deviceId: string | null) => {
    resetOutputFollowing();
    setActiveDeviceId(deviceId); setActiveEndpointId(null); setTimelineItems([]); setLastSyncedAt(undefined); setError(null);
  }, [resetOutputFollowing]);
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
  const persistPairedDevice = useCallback(async ({ device, endpointId }: DevicePairingResult) => {
    const db = getPwaDatabase();
    await db.transaction("rw", [db.devices, db.settings], async () => {
      await Promise.all([
        db.devices.put(device),
        db.settings.put({ key: `${ACTIVE_ENDPOINT_SETTING}${device.id}`, value: endpointId }),
      ]);
    });
    setDevices(await listPwaDevices());
    setActiveDeviceId(device.id);
    setActiveEndpointId(endpointId);
  }, []);
  const pairing = useDevicePairing({ identity, relayUrl, onPaired: persistPairedDevice, onError: setError });
  const removePairing = useCallback(async (device: PwaDeviceRecord) => {
    if (activeDeviceIdRef.current === device.id) clearSessionConnection();
    await invalidatePersistence();
    await removePwaDeviceData(device.deviceId, device.id, `${ACTIVE_ENDPOINT_SETTING}${device.id}`);
    const remaining = await listPwaDevices(); setDevices(remaining);
    if (activeDeviceIdRef.current === device.id) selectDevice(remaining[0]?.id ?? null);
  }, [clearSessionConnection, invalidatePersistence, selectDevice]);
  const clearLocalData = useCallback(async () => {
    await invalidatePersistence();
    await clearPwaData();
  }, [invalidatePersistence]);
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
    await runConfirmAction(confirmAction, { startNewSession: () => sendCommandAction({ action: "session_new" }), removePairing, invalidateConnection: clearSessionConnection, clearLocalData, reload: () => window.location.reload() }, { pendingRef: confirmPendingRef, setPending: setConfirmPending, setError: setConfirmError, onSuccess: () => setConfirmAction(null) });
  }, [clearLocalData, clearSessionConnection, confirmAction, removePairing, sendCommandAction]);
  if (startupState === "loading") return <StartupLoading />;
  if (startupState === "error") return <StartupErrorView error={startupError} onRetry={() => window.location.reload()} />;
  const canAttachImage = connection === "online" && visionAvailable === true && !sendingImage;
  return <div className="pwa-root"><header className="pwa-topbar"><div className="pwa-brand"><span className="pwa-brand-mark">π</span><span>Remote Pi</span><span className="pwa-brand-tag">BROWSER APP</span></div><div className="pwa-topbar-actions"><SessionSwitcherTrigger label={activeDevice && activeEndpoint ? `Endpoint: ${displayDevice(activeDevice)} / ${activeEndpoint.name || activeEndpoint.endpointId}` : null} expanded={sheetOpen} onOpen={() => setSheetOpen(true)} /><ConnectionStatus state={connection} retryAttempt={retryAttempt} /><DesktopTopbarActions onRefresh={refreshPwaApp} onToggleSettings={() => setSettingsOpen(true)} /><MobileTopbarMenu onRefresh={refreshPwaApp} onOpenSettings={() => setSettingsOpen(true)} /></div></header>
    <div className="pwa-layout"><DesktopSidebar devices={devices} activeDeviceId={activeDeviceId} pairingPresence={pairingPresence} onPair={pairing.open} onSelect={selectDevice} onRename={setRenameDevice} onRemove={(device) => setConfirmAction({ kind: "remove-pairing", label: displayDevice(device), device })} onClearData={async () => setConfirmAction({ kind: "clear-local-data" })} /><main className="pwa-main">{activeDevice && activeEndpoint ? <><div className="pwa-chat-head"><div><span className="pwa-kicker">Active endpoint</span><h2>{activeEndpoint.name || activeEndpoint.endpointId}</h2><span className="pwa-chat-meta"><span className={connection === "online" ? "pwa-status-dot online" : "pwa-status-dot"} />{activeEndpoint.kind} <span className="pwa-separator">/</span> {activeEndpoint.cwd || "cwd unavailable"} <span className="pwa-separator">/</span> last synced <time dateTime={lastSyncedAt ? new Date(lastSyncedAt).toISOString() : undefined}>{formatSyncTime(lastSyncedAt)}</time></span></div></div><MessageList items={timelineItems} hasEarlier={nextBefore !== null} loadingEarlier={loadingEarlier} onLoadEarlier={loadEarlier} listRef={messageListRef} bottomSentinelRef={bottomSentinelRef} onScroll={handleScroll} onRetryUnknown={(requestId) => { const retry = timelineRuntimeRef.current.retryUnknown(requestId); if (retry && channelRef.current?.send(retry.frame)) applyTimelineChange(retry.change); }} onCancelQueued={(requestId) => { const scope = timelineRuntimeRef.current.currentScope; if (scope) channelRef.current?.send({ protocol_version: 2, type: "queued_message_clear", id: id(), channel_id: scope.channelId, history_generation: scope.historyGeneration, target_id: requestId }); }} /><div className="pwa-chat-footer"><PwaMessageActions show={connection === "offline" || !followingOutput || unreadOutput > 0} showRetry={connection === "offline"} showLatest={!followingOutput || unreadOutput > 0} unreadOutput={unreadOutput} onRetry={retryCurrentSession} onLatest={showLatest} /><MessageComposer attachment={attachment} canAttachImage={canAttachImage} sendingImage={sendingImage} isOnline={connection === "online"} isWorking={activeEndpoint.working === true} stopping={stopRequestId !== null} draft={draft} onDraftChange={setDraft} onSend={sendMessage} onStop={stopCurrentTask} onSetAttachment={setImageAttachment} onClearAttachment={() => setAttachment(null)} commandModels={models} commandCurrentModel={currentModel} commandCurrentModelFallback={activeEndpoint.model ?? null} commandThinking={activeThinking} commandPendingAction={pendingAction?.action ?? null} onNewSession={() => setConfirmAction({ kind: "new-session" })} onCompactSession={() => sendCommandAction({ action: "session_compact" })} onSetModel={(model) => sendCommandAction({ action: "model_set", provider: model.provider, modelId: model.id })} onSetThinking={(level) => sendCommandAction({ action: "thinking_set", level })} onCommandsOpen={() => { const scope = timelineRuntimeRef.current.currentScope; const channel = channelRef.current; if (scope && channel) { const requestId = id(); modelRequestRef.current = requestId; channel.send({ protocol_version: 2, type: "list_models", id: requestId, channel_id: scope.channelId, history_generation: scope.historyGeneration }); } }} /></div></> : <EmptyWorkspace onPair={pairing.open} />}</main>{settingsOpen ? <SettingsPanel relayUrl={relayUrl} defaultRelayUrl={DEFAULT_RELAY} onSave={saveRelayUrl} onClose={() => setSettingsOpen(false)} onClearData={async () => setConfirmAction({ kind: "clear-local-data" })} onResetLayout={() => undefined} /> : null}</div>
    {sheetOpen ? <SessionSheet devices={devices} endpoints={endpoints} activeDeviceId={activeDeviceId} activeEndpointId={activeEndpointId} pairingPresence={pairingPresence} onSelectDevice={selectDevice} onSelectEndpoint={selectEndpoint} onPair={pairing.open} onRename={setRenameDevice} onRemove={(device) => setConfirmAction({ kind: "remove-pairing", label: displayDevice(device), device })} onClose={() => setSheetOpen(false)} /> : null}
    {renameDevice ? <RenamePairingDialog device={renameDevice} onSave={(nickname) => saveDeviceNickname(renameDevice, nickname)} onClose={() => setRenameDevice(null)} /> : null}
    {pairing.state !== "idle" ? <div className="pwa-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) pairing.close(); }} role="presentation">{pairing.state === "scanning" ? <PairingDialog onScan={pairing.pairFromQr} onClose={pairing.close} /> : <div className="pwa-pairing-card"><Activity className="pwa-spin" /><span className="pwa-kicker">Pairing</span><h2>Connecting to your Pi</h2><p>Waiting for the endpoint to confirm this browser.</p></div>}</div> : null}
    <ConfirmActionDialog action={confirmAction?.kind === "remove-pairing" ? { kind: "remove-pairing", label: confirmAction.label } : confirmAction} pending={confirmPending} error={confirmError} onConfirm={() => { void confirmRequestedAction(); }} onClose={() => { if (!confirmPendingRef.current) { setConfirmAction(null); setConfirmError(null); } }} />
    <PwaStatusToast message={error} onDismiss={() => setError(null)} /></div>;
}
