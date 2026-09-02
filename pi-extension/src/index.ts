#!/usr/bin/env node
/** One local Pi process is one stable Relay endpoint with replaceable sessions. */
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import { canonicalizeEd25519PublicKey, type Ed25519Keypair } from "./pairing/crypto.js";
import { qrSession } from "./pairing/qr.js";
import { addPeer, getOrCreateEd25519Keypair, KeyringUnavailableError, PairedIdentityMissingError, listPeers, type PeerRecord } from "./pairing/storage.js";
import { type ClientFrame, type ServerFrame } from "./protocol/v2/index.js";
import { RelayClient, type EndpointMetadata, type HostConnectOptions } from "./transport/relay_client.js";
import { V2PeerChannel, type HostRouteIdentity } from "./transport/peer_channel.js";
import { TimelineV2Service, type V2ActionFrame } from "./timeline/v2_service.js";
import { TimelineRuntime, type Correlation } from "./timeline/runtime.js";
import { createExtensionUiBridge, type ExtensionUiBridge } from "./extension_ui_bridge.js";
import { handleListModels, handleModelSet, handleSessionCompact, handleThinkingSet, getModelsList, type ActionCtx, type ActionReplySender } from "./actions/handlers.js";
import { ensureModelRegistry } from "./actions/registry.js";
import { SessionNewBridge } from "./actions/session_new_bridge.js";
import { RPC_CONTROL_STATUS_KEY } from "./daemon/rpc_child.js";
import { defaultAgentName, loadLocalConfig } from "./session/local_config.js";
import { resolveRelayUrl, toWebSocketUrl } from "./config.js";
import { persistModelDefault, registerCommands, runDirectCli, type RemoteCommandDependencies } from "./daemon/commands.js";
import { installOwnerRouter } from "./runtime/owner_router.js";
const CONTROL_PROTOCOL_VERSION = 2, RECONNECT_BACKOFFS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const ENDPOINT_ID_ENV = "REMOTE_PI_ENDPOINT_ID", RUNTIME_INSTANCE_ID_ENV = "REMOTE_PI_RUNTIME_INSTANCE_ID";
const CTRL_PREFIX = "\x00remote-pi-ctrl:";
export type RemoteState = "idle" | "started";
export type RelayConnectivity = "connected" | "reconnecting" | "disconnected";

type ProcessIdentity = Readonly<{ endpointId: string; runtimeInstanceId: string }>;
type EndpointGlobal = typeof globalThis & { [key: symbol]: ProcessIdentity | undefined };
const PROCESS_IDENTITY_KEY = Symbol.for("remote-pi.endpoint-process-identity");

function opaqueUuidFromEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}
export function processEndpointIdentity(): ProcessIdentity {
  const global = globalThis as EndpointGlobal;
  const existing = global[PROCESS_IDENTITY_KEY];
  if (existing) return existing;
  const identity = Object.freeze({
    endpointId: opaqueUuidFromEnv(ENDPOINT_ID_ENV) ?? randomUUID(),
    runtimeInstanceId: opaqueUuidFromEnv(RUNTIME_INSTANCE_ID_ENV) ?? randomUUID(),
  });
  global[PROCESS_IDENTITY_KEY] = identity;
  return identity;
}

const endpointIdentity = processEndpointIdentity();
let state: RemoteState = "idle";
let relay: RelayClient | null = null;
let relayUrl: string | null = null;
let keypair: Ed25519Keypair | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let lifecycle = 0;
let disposed = false;
let currentModel: string | undefined;
let currentThinking: string | undefined;
let working = false;
let currentSessionManager: SessionManager | null = null;
let timelineGeneration = randomUUID();
let timeline: TimelineRuntime | null = null;
let piApi: ExtensionAPI | null = null;
let lastCommandCtx: Pick<ExtensionContext, "ui" | "abort" | "cwd"> | null = null;
let lastEventCtx: Pick<ExtensionContext, "ui" | "abort" | "compact"> | null = null;
let extensionUiBridge: ExtensionUiBridge | null = null;
let currentTurnId: string | null = null;
let replacedSessionId: string | null = null;
const sessionNewBridge = new SessionNewBridge({ getPi: () => piApi, onCommandContext: (ctx) => { lastCommandCtx = ctx; }, onReplaced: (ctx) => { lastCommandCtx = ctx as typeof lastCommandCtx; }, onFinished: () => finishSessionReplacement() });

export const _getState = (): "idle" | "started" | "paired" => state === "idle" ? "idle" : activeOwners.size > 0 ? "paired" : "started";
export const _getCachedPublicKeyForTest = (): string | null => keypair ? Buffer.from(keypair.publicKey).toString("base64") : null;
export const _getCurrentTurnIdForTest = (): string | null => currentTurnId;
export const _setPiForTest = (value: unknown): void => { piApi = value as ExtensionAPI; };
export const _setCurrentModelForTest = (value: string | undefined): void => { currentModel = value; };
export const _setSessionStartedAtForTest = (_value: number | null): void => { /* compatibility no-op */ };
export const _setMessageBufferForTest = (_value: unknown[]): void => { /* compatibility no-op */ };
export const _getMessageBufferForTest = (): unknown[] => [];
export const _hasPendingReconnect = (): boolean => reconnectTimer !== null;
export const _getActivePeerCountForTest = (): number => activeOwners.size;
export const _hasActivePeerForTest = (ownerId: string): boolean => activeOwners.has(ownerId);
export const _getDisposedForTest = (): boolean => disposed;
export const _setDisposedForTest = (value: boolean): void => { disposed = value; };
export const _resetAutoInitedForTest = (): void => undefined;
export const _setAutoInitedForTest = (_value: boolean): void => undefined;
export const _setSessionNewBridgeTimeoutForTest = (timeoutMs: number): void => sessionNewBridge.setTimeoutForTest(timeoutMs);
function displayName(cwd = process.cwd()): string { return loadLocalConfig(cwd).agent_name ?? defaultAgentName(cwd); }

function endpointMetadata(cwd = process.cwd()): EndpointMetadata {
  return {
    kind: process.env.REMOTE_PI_DAEMON === "1" ? "daemon" : "interactive",
    name: displayName(cwd),
    cwd,
    pid: process.pid,
    started_at: Date.now(),
    ...(currentModel ? { model: currentModel } : {}),
    ...(currentThinking ? { thinking: currentThinking } : {}),
    working,
  };
}

function routeIdentity(): HostRouteIdentity {
  if (!keypair) throw new Error("remote-pi identity is unavailable");
  return { deviceId: Buffer.from(keypair.publicKey).toString("base64"), endpointId: endpointIdentity.endpointId, runtimeInstanceId: endpointIdentity.runtimeInstanceId };
}

async function authorizedOwnerIds(): Promise<string[]> {
  const owners = new Set<string>();
  for (const record of await listPeers()) {
    try { owners.add(canonicalizeEd25519PublicKey(record.remote_epk, "stored Owner public key")); }
    catch { /* malformed legacy records have no Relay authority */ }
  }
  return [...owners];
}

function relayStatus(): RelayConnectivity {
  if (state === "idle") return "disconnected";
  return relay?.isOpen() ? "connected" : "reconnecting";
}

function emitRuntimeEvent(type: string, details: Record<string, unknown>): void {
  if (process.env.REMOTE_PI_DAEMON === "1") {
    const ui = lastEventCtx?.ui ?? lastCommandCtx?.ui;
    try { ui?.setStatus(RPC_CONTROL_STATUS_KEY, JSON.stringify({ type: type.replace(/-/g, "_"), ...details })); }
    catch { /* a stale RPC UI context must not take down the process */ }
    return;
  }
  try { piApi?.sendMessage({ customType: `remote-pi:${type}`, content: "", details, display: false }); }
  catch { /* a stale session must not take down the process */ }
}

function emitRelayState(): void {
  emitRuntimeEvent("relay-state", { state: relayStatus(), endpoint_id: endpointIdentity.endpointId, runtime_instance_id: endpointIdentity.runtimeInstanceId });
}

function emitRuntimeReady(): void {
  emitRuntimeEvent("runtime-ready", {
    control_protocol_version: CONTROL_PROTOCOL_VERSION, extension_version: extensionVersion(),
    endpoint_id: endpointIdentity.endpointId, runtime_instance_id: endpointIdentity.runtimeInstanceId,
    ...(currentSessionManager ? { session_id: currentSessionManager.getSessionId() } : {}),
  });
}

function emitRuntimeFailed(stage: string, code: string, message: string, retryable: boolean): void {
  emitRuntimeEvent("runtime-failed", { stage, code, message, retryable });
}

async function updateEndpoint(): Promise<void> {
  if (!relay?.isOpen()) return;
  try {
    relay.sendControl({
      type: "endpoint_update",
      metadata: endpointMetadata(),
      authorized_owner_ids: await authorizedOwnerIds(),
    });
  } catch { /* reconnect owns recovery */ }
}

function refreshFooter(ctx?: Pick<ExtensionContext, "ui"> | null): void {
  const ui = ctx?.ui ?? lastEventCtx?.ui ?? lastCommandCtx?.ui;
  if (!ui || typeof ui.setStatus !== "function" || typeof ui.setTitle !== "function") return;
  try {
    ui.setStatus("remote-pi:relay", state === "idle" ? undefined : activeOwners.size ? "🟢 relay" : "🟡 relay waiting for pairing");
    ui.setStatus("remote-pi:owner-active", activeOwners.size ? `📱 ${[...activeOwners.keys()][0]!.slice(0, 8)}` : undefined);
    ui.setStatus("remote-pi:session", undefined);
    ui.setTitle(`${displayName()} · ${state === "idle" ? "Off" : "On"}`);
  } catch { /* stale UI context */ }
}

const activeOwners = new Map<string, { channel: V2PeerChannel; service: TimelineV2Service }>();

function detachOwner(ownerId: string): void {
  const binding = activeOwners.get(ownerId);
  if (!binding) return;
  try { binding.channel.detach(); } catch { /* best effort */ }
  activeOwners.delete(ownerId); refreshFooter();
}
function sendToOwner(ownerId: string, frames: readonly ServerFrame[]): void {
  const binding = activeOwners.get(ownerId);
  if (binding) for (const frame of frames) binding.channel.sendV2(frame);
}
function broadcastV2(factory: (service: TimelineV2Service) => readonly ServerFrame[]): void {
  for (const { channel, service } of activeOwners.values()) for (const frame of factory(service)) channel.sendV2(frame);
}

function finishSessionReplacement(): void {
  const sessionId = replacedSessionId;
  if (!sessionId) return;
  replacedSessionId = null;
  for (const [ownerId, { channel, service }] of [...activeOwners]) {
    channel.sendV2({ protocol_version: 2, type: "bye", session_id: sessionId, history_generation: service.generation, reason: "session_replaced" }); detachOwner(ownerId);
  }
}

function ensureTimeline(sessionManager: SessionManager): TimelineRuntime {
  currentSessionManager = sessionManager;
  if (!timeline) {
    timeline = new TimelineRuntime({
      getHistoryGeneration: () => timelineGeneration,
      onStarted: (started) => {
        if (!started.correlation.senderRef) return;
        const binding = activeOwners.get(started.correlation.senderRef);
        if (!binding) return;
        sendToOwner(started.correlation.senderRef, binding.service.started(started));
      },
      onPublished: (event, correlation) => {
        broadcastV2((service) => service.publishFrames(event));
        if (correlation.senderRef && correlation.clientRequestId) {
          const binding = activeOwners.get(correlation.senderRef);
          if (binding) sendToOwner(correlation.senderRef, binding.service.commit(correlation.clientRequestId, event.event_id, "group_id" in event ? event.group_id : undefined));
        }
      },
    });
  }
  timeline.attach(sessionManager);
  return timeline;
}

function rotateGeneration(reason: "generation_changed" | "branch_changed" | "session_replaced"): void {
  timelineGeneration = randomUUID();
  for (const { channel, service } of activeOwners.values()) {
    service.refreshGeneration(timelineGeneration);
    for (const frame of service.reset(reason)) channel.sendV2(frame);
  }
}

function actionSender(ownerId: string, channelId: string): ActionReplySender {
  return {
    send(message) {
      const binding = activeOwners.get(ownerId);
      if (!binding) return;
      if (message.type === "action_ok" || message.type === "action_error") {
        binding.channel.sendV2({ protocol_version: 2, type: message.type, target_channel_id: channelId, in_reply_to: message.in_reply_to, action: message.action, ...(message.type === "action_error" ? { error: message.error } : {}) } as ServerFrame);
      }
    },
  };
}

function wakeAgent(content: Parameters<ExtensionAPI["sendUserMessage"]>[0], correlation: Correlation): boolean {
  if (!piApi) return false;
  try {
    const send = () => piApi!.sendUserMessage(content, { deliverAs: "steer" });
    if (timeline) timeline.runWithCorrelation(correlation, send); else send();
    return true;
  } catch { return false; }
}

function routeAction(ownerId: string, frame: V2ActionFrame): void {
  const sender = actionSender(ownerId, frame.channel_id);
  const ctx = (lastEventCtx ?? lastCommandCtx) as ActionCtx | null;
  switch (frame.type) {
    case "session_compact":
      handleSessionCompact(ctx, sender, frame);
      return;
    case "session_new":
      sessionNewBridge.dispatch(sender, frame);
      return;
    case "model_set":
      if (piApi) void handleModelSet(piApi, ctx, ensureModelRegistry(ctx), sender, frame, persistModelDefault);
      return;
    case "thinking_set":
      if (piApi) handleThinkingSet(piApi, sender, frame);
      return;
  }
}

function createBinding(relayClient: RelayClient, ownerId: string): { channel: V2PeerChannel; service: TimelineV2Service } | null {
  const manager = currentSessionManager;
  if (!manager) return null;
  const runtime = ensureTimeline(manager);
  const channel = new V2PeerChannel(relayClient, ownerId, routeIdentity(), (frame) => routeClientFrame(ownerId, frame));
  const service = new TimelineV2Service({
    sessionManager: manager,
    senderRef: ownerId,
    generation: timelineGeneration,
    runtime,
    onUserMessage: (frame, correlation) => {
      currentTurnId = frame.client_request_id;
      return wakeAgent(
        frame.images?.length
          ? [...frame.images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mime })), { type: "text" as const, text: frame.text }]
          : frame.text,
        correlation,
      );
    },
    onCancel: () => {
      const abort = lastEventCtx?.abort ?? lastCommandCtx?.abort;
      if (!abort) return false;
      abort();
      return true;
    },
    onAction: (frame) => routeAction(ownerId, frame),
    onListModels: () => getModelsList((lastEventCtx ?? lastCommandCtx) as ActionCtx | null, ensureModelRegistry((lastEventCtx ?? lastCommandCtx) as ActionCtx | null), currentModel),
  });
  return { channel, service };
}

function attachOwner(relayClient: RelayClient, ownerId: string): { channel: V2PeerChannel; service: TimelineV2Service } | null {
  detachOwner(ownerId);
  const binding = createBinding(relayClient, ownerId);
  if (!binding) return null;
  activeOwners.set(ownerId, binding);
  refreshFooter();
  return binding;
}

function routeClientFrame(ownerId: string, frame: ClientFrame): void {
  const binding = activeOwners.get(ownerId);
  if (!binding) return;
  for (const response of binding.service.handle(frame)) binding.channel.sendV2(response);
}

function installRouteListener(relayClient: RelayClient): () => void {
  const expectedLifecycle = lifecycle;
  return installOwnerRouter(relayClient, {
    isCurrent: (candidate) => !disposed && state === "started" && relay === candidate && lifecycle === expectedLifecycle,
    routeIdentity,
    hasOwner: (ownerId) => activeOwners.has(ownerId),
    findKnownOwner: async (ownerId) => !!await findKnownOwner(ownerId),
    attachOwner,
    routeClientFrame,
    handlePairRequest,
  });
}

async function findKnownOwner(ownerId: string): Promise<PeerRecord | null> {
  let canonical: string;
  try { canonical = canonicalizeEd25519PublicKey(ownerId, "Relay Owner key"); }
  catch { return null; }
  for (const record of await listPeers()) {
    try {
      if (canonicalizeEd25519PublicKey(record.remote_epk, "stored Owner public key") === canonical) return record;
    } catch { /* bad stored record */ }
  }
  return null;
}

async function handlePairRequest(
  relayClient: RelayClient,
  ownerId: string,
  frame: Extract<ClientFrame, { type: "pair_request" }>,
): Promise<void> {
  const binding = attachOwner(relayClient, ownerId);
  if (!binding) return;
  const status = qrSession.consumeToken(frame.token);
  if (status !== "ok") {
    binding.channel.sendV2({ protocol_version: 2, type: "pair_error", in_reply_to: frame.id, code: status === "expired" ? "token_expired" : status === "consumed" ? "token_consumed" : "token_unknown", message: "Pairing token is invalid or expired" });
    detachOwner(ownerId);
    return;
  }
  try {
    await addPeer({ name: frame.device_name, remote_epk: ownerId, paired_at: new Date().toISOString() });
    await updateEndpoint();
  } catch {
    binding.channel.sendV2({ protocol_version: 2, type: "pair_error", in_reply_to: frame.id, code: "internal_error", message: "Failed to persist pairing" });
    detachOwner(ownerId);
    return;
  }
  binding.channel.sendV2({
    protocol_version: 2,
    type: "pair_ok",
    in_reply_to: frame.id,
    session_name: displayName(),
    session_started_at: Date.now(),
    endpoint_id: endpointIdentity.endpointId,
    harness: { name: "Pi coding agent", version: extensionVersion() },
    hostname: hostname(),
  });
}

function closeRelay(reason?: "peer_stop" | "session_replaced" | "shutdown"): void {
  lifecycle += 1;
  sessionNewBridge.clear("session replacement cancelled because the endpoint closed");
  replacedSessionId = null;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectAttempt = 0;
  if (reason) {
    for (const { channel, service } of activeOwners.values()) {
      channel.sendV2({ protocol_version: 2, type: "bye", session_id: currentSessionManager?.getSessionId() ?? "unknown", history_generation: service.generation, reason });
    }
  }
  for (const ownerId of [...activeOwners.keys()]) detachOwner(ownerId);
  const oldRelay = relay;
  relay = null;
  relayUrl = null;
  state = "idle";
  oldRelay?.close();
  refreshFooter();
  emitRelayState();
}

function scheduleRelayReconnect(url: string): void {
  if (!keypair || disposed || state !== "started") return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const localLifecycle = ++lifecycle;
  const delay = RECONNECT_BACKOFFS_MS[Math.min(reconnectAttempt++, RECONNECT_BACKOFFS_MS.length - 1)]!;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (disposed || state !== "started" || lifecycle !== localLifecycle) return;
    void reconnect(url, localLifecycle);
  }, delay);
}

function onRelayClose(closed: RelayClient): void {
  if (closed !== relay || state === "idle") return;
  for (const ownerId of [...activeOwners.keys()]) detachOwner(ownerId);
  relay = null;
  emitRelayState();
  const url = relayUrl;
  if (url) scheduleRelayReconnect(url);
}

async function reconnect(url: string, expectedLifecycle: number): Promise<void> {
  if (!keypair || disposed || state !== "started" || lifecycle !== expectedLifecycle) return;
  const candidate = new RelayClient(toWebSocketUrl(url), keypair);
  try {
    await candidate.connect(await hostConnectOptions());
  } catch {
    candidate.close();
    if (state === "started" && lifecycle === expectedLifecycle) {
      emitRelayState();
      scheduleRelayReconnect(url);
    }
    return;
  }
  if (disposed || state !== "started" || lifecycle !== expectedLifecycle) { candidate.close(); return; }
  relay = candidate;
  reconnectAttempt = 0;
  candidate.on("close", () => onRelayClose(candidate));
  installRouteListener(candidate);
  emitRelayState();
  void updateEndpoint();
}

async function hostConnectOptions(cwd = process.cwd()): Promise<HostConnectOptions> {
  return {
    role: "host",
    endpointId: endpointIdentity.endpointId,
    runtimeInstanceId: endpointIdentity.runtimeInstanceId,
    metadata: endpointMetadata(cwd),
    authorizedOwnerIds: await authorizedOwnerIds(),
  };
}

async function start(ctx: Pick<ExtensionContext, "ui" | "cwd">): Promise<void> {
  if (state !== "idle") { try { ctx.ui.notify("[remote-pi] Already connected.", "warning"); } catch { /* stale UI context */ } return; }
  const candidateLifecycle = ++lifecycle;
  try { keypair = await getOrCreateEd25519Keypair(); }
  catch (error) {
    if (error instanceof KeyringUnavailableError || error instanceof PairedIdentityMissingError) {
      emitRuntimeFailed("identity", error instanceof KeyringUnavailableError ? "keyring_unavailable" : "paired_identity_missing", error.message, false);
      try { ctx.ui.notify(`[remote-pi] Cannot access the established device identity: ${error.message}`, "error"); } catch { /* stale UI context */ }
      return;
    }
    throw error;
  }
  if (disposed || lifecycle !== candidateLifecycle) return;
  const resolution = resolveRelayUrl();
  relayUrl = resolution.url;
  state = "started";
  emitRelayState();
  const candidate = new RelayClient(toWebSocketUrl(resolution.url), keypair);
  try { ctx.ui.notify(`[remote-pi] Connecting endpoint ${endpointIdentity.endpointId.slice(0, 8)} to ${resolution.url} (source: ${resolution.source})…`); } catch { /* stale UI context */ }
  try { await candidate.connect(await hostConnectOptions(ctx.cwd)); }
  catch (error) {
    candidate.close();
    if (!disposed && lifecycle === candidateLifecycle) {
      try { ctx.ui.notify(`[remote-pi] Relay unavailable; reconnecting in background: ${String(error)}`, "warning"); } catch { /* stale UI context */ }
      emitRelayState();
      scheduleRelayReconnect(resolution.url);
    }
    return;
  }
  if (disposed || lifecycle !== candidateLifecycle) { candidate.close(); return; }
  relay = candidate;
  candidate.on("close", () => onRelayClose(candidate));
  installRouteListener(candidate);
  refreshFooter(ctx);
  emitRelayState();
}

const extensionVersion = (): string => {
  try {
    const here = fileURLToPath(import.meta.url);
    const pkg = JSON.parse(readFileSync(join(dirname(dirname(here)), "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch { return "0.0.0"; }
};

const APPLIED = Symbol.for("remote-pi.endpoint-extension-applied");
function appliedSet(): WeakSet<object> {
  const global = globalThis as typeof globalThis & { [APPLIED]?: WeakSet<object> };
  return global[APPLIED] ??= new WeakSet<object>();
}

const commandDependencies: RemoteCommandDependencies = {
  start,
  stop: () => closeRelay("peer_stop"),
  state: () => state,
  relayStatus,
  relayUrl: () => relayUrl,
  endpointIdentity: () => endpointIdentity,
  activeOwnerCount: () => activeOwners.size,
  isOwnerActive: (ownerId) => activeOwners.has(ownerId),
  detachOwner,
  updateEndpoint,
  displayName,
  keypair: () => keypair,
  hasRelay: () => relay !== null,
  piApi: () => piApi,
  setCommandContext: (ctx) => { lastCommandCtx = ctx; },
  runInternalSessionNew: (token, ctx) => sessionNewBridge.run(token, ctx),
};

const extension: ExtensionFactory = (pi): void => {
  if (appliedSet().has(pi)) return;
  appliedSet().add(pi);
  piApi = pi;
  extensionUiBridge?.dispose();
  extensionUiBridge = createExtensionUiBridge(pi, (frame) => broadcastV2(() => [frame]));
  registerCommands(pi, commandDependencies);

  pi.on("input", (event) => {
    if (event.text.startsWith(CTRL_PREFIX)) {
      const control = event.text.slice(CTRL_PREFIX.length).trim();
      if (control === "relay:on") void start({ ui: { notify: () => undefined }, cwd: process.cwd() } as unknown as ExtensionContext);
      else if (control === "relay:off") closeRelay("peer_stop");
      else if (control === "relay:status") emitRelayState();
      return { action: "handled" } as const;
    }
    return undefined;
  });
  pi.on("session_before_switch", (event) => sessionNewBridge.beforeSwitch(event.reason)); pi.on("session_before_fork", () => sessionNewBridge.beforeFork());
  pi.on("model_select", (event) => {
    const model = event.model as { name?: string; id?: string } | undefined;
    currentModel = model?.name ?? model?.id;
    void updateEndpoint();
  });
  pi.on("thinking_level_select", (event) => {
    currentThinking = event.level as string | undefined;
    void updateEndpoint();
  });
  pi.on("turn_start", () => { working = true; void updateEndpoint(); });
  pi.on("turn_end", () => { working = false; void updateEndpoint(); });
  pi.on("agent_start", () => timeline?.onAgentStart());
  pi.on("agent_end", () => { timeline?.onAgentEnd(); currentTurnId = null; });
  pi.on("message_start", (event, ctx) => {
    const manager = (ctx as unknown as { sessionManager?: SessionManager }).sessionManager;
    if (manager) ensureTimeline(manager).onMessageStart(event.message, manager);
  });
  pi.on("message_end", (event, ctx) => {
    const manager = (ctx as unknown as { sessionManager?: SessionManager }).sessionManager;
    if (manager) ensureTimeline(manager).onMessageEnd(event.message, manager);
  });
  pi.on("session_start", (_event, ctx) => {
    lastEventCtx = ctx;
    const manager = (ctx as unknown as { sessionManager?: SessionManager }).sessionManager;
    if (manager) {
      currentSessionManager = manager;
      timelineGeneration = randomUUID();
      ensureTimeline(manager).resetSession(manager);
      emitRuntimeEvent("session-changed", { endpoint_id: endpointIdentity.endpointId, runtime_instance_id: endpointIdentity.runtimeInstanceId, session_id: manager.getSessionId(), history_generation: timelineGeneration });
      emitRuntimeReady();
      if (!sessionNewBridge.isRunning()) finishSessionReplacement();
    }
    try { currentThinking = pi.getThinkingLevel() as string | undefined; } catch { /* optional SDK capability */ }
    if (loadLocalConfig(process.cwd()).auto_start_relay !== false && state === "idle") {
      void start(ctx as Pick<ExtensionContext, "ui" | "cwd">);
    }
  });
  pi.on("session_tree", () => rotateGeneration("branch_changed"));
  pi.on("session_shutdown", (event) => {
    const isProcessShutdown = event.reason === "quit";
    if (!isProcessShutdown) {
      replacedSessionId = currentSessionManager?.getSessionId() ?? null;
      currentSessionManager = null;
      return;
    }
    disposed = true;
    extensionUiBridge?.dispose();
    extensionUiBridge = null;
    closeRelay("shutdown");
  });
};
export default extension;
/** Compatibility seam used by focused extension tests. */
export async function _startRelayForTest(ctx: unknown): Promise<void> { await start(ctx as Pick<ExtensionContext, "ui" | "cwd">); }
export async function _stopForTest(_ctx: unknown): Promise<void> { closeRelay("peer_stop"); }
export async function _connectForTest(ctx: unknown): Promise<void> { await start(ctx as Pick<ExtensionContext, "ui" | "cwd">); }

runDirectCli(commandDependencies, (() => {
  try { return fileURLToPath(import.meta.url) === realpathSync(process.argv[1] ?? ""); }
  catch { return false; }
})());
