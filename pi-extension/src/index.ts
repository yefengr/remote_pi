#!/usr/bin/env node
/** One local Pi process is one stable Relay endpoint with replaceable sessions. */
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import { canonicalizeEd25519PublicKey } from "./pairing/crypto.js";
import { qrSession } from "./pairing/qr.js";
import { addPeer, conditionalRollbackPeer, getOrCreateEd25519Keypair, KeyringUnavailableError, PairedIdentityMissingError, listPeers, type PeerRecord } from "./pairing/storage.js";
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
import { RelayLifecycle, type RelayStartContext } from "./runtime/relay_lifecycle.js";
import { PairingCoordinator } from "./runtime/pairing_coordinator.js";
export type { RelayConnectivity, RemoteState } from "./runtime/relay_lifecycle.js";
const CONTROL_PROTOCOL_VERSION = 2;
const ENDPOINT_ID_ENV = "REMOTE_PI_ENDPOINT_ID", RUNTIME_INSTANCE_ID_ENV = "REMOTE_PI_RUNTIME_INSTANCE_ID";
const CTRL_PREFIX = "\x00remote-pi-ctrl:";
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

export const _getState = (): "idle" | "started" | "paired" => relayLifecycle.state === "idle" ? "idle" : activeOwners.size > 0 ? "paired" : "started";
export const _getCachedPublicKeyForTest = (): string | null => relayLifecycle.keypair ? Buffer.from(relayLifecycle.keypair.publicKey).toString("base64") : null;
export const _getCurrentTurnIdForTest = (): string | null => currentTurnId;
export const _setPiForTest = (value: unknown): void => { piApi = value as ExtensionAPI; };
export const _setCurrentModelForTest = (value: string | undefined): void => { currentModel = value; };
export const _setSessionStartedAtForTest = (_value: number | null): void => { /* compatibility no-op */ };
export const _setMessageBufferForTest = (_value: unknown[]): void => { /* compatibility no-op */ };
export const _getMessageBufferForTest = (): unknown[] => [];
export const _hasPendingReconnect = (): boolean => relayLifecycle.hasPendingReconnect;
export const _getActivePeerCountForTest = (): number => activeOwners.size;
export const _hasActivePeerForTest = (ownerId: string): boolean => activeOwners.has(ownerId);
export const _getDisposedForTest = (): boolean => relayLifecycle.disposed;
export const _setDisposedForTest = (value: boolean): void => { relayLifecycle.setDisposed(value); };
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
  const keypair = relayLifecycle.keypair;
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

function relayStatus() { return relayLifecycle.status; }

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

let endpointUpdateQueue: Promise<void> = Promise.resolve();

function updateEndpoint(expectedRelay?: RelayClient): Promise<boolean> {
  let sent = false;
  const operation = endpointUpdateQueue.then(async () => {
    const relay = expectedRelay ?? relayLifecycle.relay;
    if (!relay?.isOpen() || !relayLifecycle.isCurrent(relay)) return;
    try {
      const authorized = await authorizedOwnerIds();
      if (!relayLifecycle.isCurrent(relay) || !relay.isOpen()) return;
      sent = relay.sendControl({
        type: "endpoint_update",
        metadata: endpointMetadata(),
        authorized_owner_ids: authorized,
      });
    } catch { /* reconnect owns recovery */ }
  });
  endpointUpdateQueue = operation.then(() => undefined, () => undefined);
  return operation.then(() => sent);
}

function refreshFooter(ctx?: Pick<ExtensionContext, "ui"> | null): void {
  const ui = ctx?.ui ?? lastEventCtx?.ui ?? lastCommandCtx?.ui;
  if (!ui || typeof ui.setStatus !== "function" || typeof ui.setTitle !== "function") return;
  try {
    ui.setStatus("remote-pi:relay", relayLifecycle.state === "idle" ? undefined : activeOwners.size ? "🟢 relay" : "🟡 relay waiting for pairing");
    ui.setStatus("remote-pi:owner-active", activeOwners.size ? `📱 ${[...activeOwners.keys()][0]!.slice(0, 8)}` : undefined);
    ui.setStatus("remote-pi:session", undefined);
    ui.setTitle(`${displayName()} · ${relayLifecycle.state === "idle" ? "Off" : "On"}`);
  } catch { /* stale UI context */ }
}

type OwnerBinding = { channel: V2PeerChannel; service: TimelineV2Service; sessionId: string };

const activeOwners = new Map<string, OwnerBinding>();
const relayLifecycle = new RelayLifecycle({
  loadIdentity: getOrCreateEd25519Keypair,
  resolveRelayUrl,
  createClient: (url, identity) => new RelayClient(toWebSocketUrl(url), identity),
  buildConnectOptions: hostConnectOptions,
  handleIdentityError: (error, ctx) => {
    if (!(error instanceof KeyringUnavailableError) && !(error instanceof PairedIdentityMissingError)) return false;
    emitRuntimeFailed("identity", error instanceof KeyringUnavailableError ? "keyring_unavailable" : "paired_identity_missing", error.message, false);
    try { ctx.ui.notify(`[remote-pi] Cannot access the established device identity: ${error.message}`, "error"); } catch { /* stale UI context */ }
    return true;
  },
  describeConnection: (resolution) => `[remote-pi] Connecting endpoint ${endpointIdentity.endpointId.slice(0, 8)} to ${resolution.url} (source: ${resolution.source})…`,
  onStateChange: emitRelayState,
  onConnected: (client, ctx) => {
    installRouteListener(client);
    if (ctx) refreshFooter(ctx);
    else void updateEndpoint(client);
  },
  onDisconnected: () => {
    for (const ownerId of [...activeOwners.keys()]) detachOwner(ownerId);
    pairingCoordinator.abandonInactive();
  },
});

function detachOwner(ownerId: string): void {
  const binding = activeOwners.get(ownerId);
  if (!binding) return;
  try { binding.channel.detach(); } catch { /* best effort */ }
  activeOwners.delete(ownerId); refreshFooter();
}
function closeOwner(ownerId: string, reason: "peer_stop"): void {
  const binding = activeOwners.get(ownerId);
  if (!binding) return;
  binding.channel.sendV2({
    protocol_version: 2,
    type: "bye",
    session_id: binding.sessionId,
    history_generation: binding.service.generation,
    reason,
  });
  detachOwner(ownerId);
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

function createBinding(relayClient: RelayClient, ownerId: string): OwnerBinding | null {
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
  return { channel, service, sessionId: manager.getSessionId() };
}

function attachOwner(relayClient: RelayClient, ownerId: string): OwnerBinding | null {
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
  return installOwnerRouter(relayClient, {
    isCurrent: (candidate) => relayLifecycle.isCurrent(candidate),
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

const pairingCoordinator = new PairingCoordinator({
  qrSession,
  routeIdentity,
  isRelayCurrent: (relay) => relayLifecycle.isCurrent(relay),
  attachOwner,
  activeBinding: (ownerId) => activeOwners.get(ownerId),
  addPeer,
  rollbackPeer: conditionalRollbackPeer,
  updateEndpoint: (relay) => updateEndpoint(relay),
  refreshCurrentEndpoint: () => updateEndpoint(),
  buildPairOk: (frame) => ({
    protocol_version: 2,
    type: "pair_ok",
    in_reply_to: frame.id,
    session_name: displayName(),
    session_started_at: Date.now(),
    endpoint_id: endpointIdentity.endpointId,
    harness: { name: "Pi coding agent", version: extensionVersion() },
    hostname: hostname(),
  }),
});

function handlePairRequest(relayClient: RelayClient, ownerId: string, frame: Extract<ClientFrame, { type: "pair_request" }>): Promise<void> {
  return pairingCoordinator.handle(relayClient, ownerId, frame);
}

function closeRelay(reason?: "peer_stop" | "session_replaced" | "shutdown"): void {
  sessionNewBridge.clear("session replacement cancelled because the endpoint closed");
  replacedSessionId = null;
  if (reason) {
    for (const { channel, service } of activeOwners.values()) {
      channel.sendV2({ protocol_version: 2, type: "bye", session_id: currentSessionManager?.getSessionId() ?? "unknown", history_generation: service.generation, reason });
    }
  }
  relayLifecycle.stop();
  refreshFooter();
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

function start(ctx: RelayStartContext) { return relayLifecycle.start(ctx); }
function waitForInitialRelay() { return relayLifecycle.waitForInitial(); }

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
  waitForInitialRelay,
  stop: () => closeRelay("peer_stop"),
  state: () => relayLifecycle.state,
  relayStatus,
  relayUrl: () => relayLifecycle.relayUrl,
  endpointIdentity: () => endpointIdentity,
  activeOwnerCount: () => activeOwners.size,
  isOwnerActive: (ownerId) => activeOwners.has(ownerId),
  closeOwner,
  updateEndpoint: async () => { await updateEndpoint(); },
  displayName,
  keypair: () => relayLifecycle.keypair,
  hasRelay: () => relayLifecycle.relay?.isOpen() === true,
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
    if (loadLocalConfig(process.cwd()).auto_start_relay !== false && relayLifecycle.state === "idle") {
      void start(ctx as RelayStartContext);
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
    relayLifecycle.setDisposed(true);
    extensionUiBridge?.dispose();
    extensionUiBridge = null;
    closeRelay("shutdown");
  });
};
export default extension;
/** Compatibility seam used by focused extension tests. */
export async function _startRelayForTest(ctx: unknown): Promise<void> { await start(ctx as RelayStartContext); }
export async function _stopForTest(_ctx: unknown): Promise<void> { closeRelay("peer_stop"); }
export async function _connectForTest(ctx: unknown): Promise<void> { await start(ctx as RelayStartContext); }

runDirectCli(commandDependencies, (() => {
  try { return fileURLToPath(import.meta.url) === realpathSync(process.argv[1] ?? ""); }
  catch { return false; }
})());
