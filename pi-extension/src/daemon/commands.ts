import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { canonicalizeEd25519PublicKey, type Ed25519Keypair } from "../pairing/crypto.js";
import { buildQRUri, clampPairTtlMs, qrSession, renderQRAscii, TOKEN_TTL_MS } from "../pairing/qr.js";
import { addPeer, listPeers, removePeer } from "../pairing/storage.js";
import { isValidRelayUrl, isWebSocketScheme, resolveRelayUrl, saveConfig } from "../config.js";
import { addDaemon, findDaemonByCwd, listDaemons, removeDaemon } from "./registry.js";
import { callSupervisor, supervisorOnline, SupervisorOfflineError } from "./client.js";
import type { ControlRequest, DaemonInfo } from "./control_protocol.js";
import {
  installService,
  uninstallService,
  linkCliBinaries,
  unlinkCliBinaries,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
} from "./install.js";

type CommandUiContext = Pick<ExtensionContext, "ui">;
type CommandStartContext = Pick<ExtensionContext, "ui" | "cwd">;
type DaemonOperation = "start" | "stop" | "restart";

export interface RemoteCommandDependencies {
  start(ctx: CommandStartContext): Promise<void>;
  stop(): void;
  state(): "idle" | "started";
  relayStatus(): string;
  relayUrl(): string | null;
  endpointIdentity(): Readonly<{ endpointId: string; runtimeInstanceId: string }>;
  activeOwnerCount(): number;
  isOwnerActive(ownerId: string): boolean;
  detachOwner(ownerId: string): void;
  updateEndpoint(): Promise<void>;
  displayName(cwd?: string): string;
  keypair(): Ed25519Keypair | null;
  hasRelay(): boolean;
  piApi(): ExtensionAPI | null;
  setCommandContext(ctx: ExtensionCommandContext): void;
}

function notify(ctx: CommandUiContext, text: string, kind: "info" | "warning" | "error" = "info"): void {
  try { ctx.ui.notify(text, kind); } catch { /* headless/stale context */ }
}

async function pair(ctx: CommandStartContext, args: string, deps: RemoteCommandDependencies): Promise<void> {
  if (deps.state() === "idle") await deps.start(ctx);
  const keypair = deps.keypair();
  if (!deps.hasRelay() || !keypair) { notify(ctx, "[remote-pi] Pair requires a Relay connection.", "warning"); return; }
  const ttl = /--ttl\s+(\d+)/.exec(args);
  const ttlMs = ttl ? clampPairTtlMs(Number(ttl[1]) * 1_000) : TOKEN_TTL_MS;
  const issued = qrSession.issueToken(ttlMs);
  const identity = deps.endpointIdentity();
  const uri = buildQRUri(issued.token, keypair.publicKey, deps.displayName(ctx.cwd), identity.endpointId, identity.runtimeInstanceId);
  try {
    deps.piApi()?.sendMessage({
      customType: "remote-pi:pair-code",
      content: `Scan to pair:\n\n${renderQRAscii(uri)}\n\n${uri}`,
      details: { uri, token: issued.token, expiresAt: issued.expiresAt, endpointId: identity.endpointId, name: deps.displayName(ctx.cwd) },
      display: true,
    });
  } catch { /* headless pairing still has a status message */ }
  notify(ctx, `[remote-pi] QR ready until ${new Date(issued.expiresAt).toLocaleTimeString()}.`);
}

async function listDevices(ctx: CommandUiContext, deps: RemoteCommandDependencies): Promise<void> {
  const peers = await listPeers();
  if (!peers.length) { notify(ctx, "[remote-pi] No paired devices."); return; }
  notify(ctx, `[remote-pi] Paired devices:\n${peers.map((peer) => `• ${peer.remote_epk.slice(0, 8)} — ${peer.name}${deps.isOwnerActive(peer.remote_epk) ? " 🟢 online" : ""}`).join("\n")}`);
}

async function revoke(args: string, ctx: CommandUiContext, deps: RemoteCommandDependencies): Promise<void> {
  const shortId = args.trim();
  if (!shortId) { notify(ctx, "[remote-pi] Usage: /remote-pi revoke <shortid>", "warning"); return; }
  const matches = (await listPeers()).filter((peer) => peer.remote_epk.startsWith(shortId));
  if (matches.length !== 1) { notify(ctx, matches.length ? "[remote-pi] Ambiguous owner id." : "[remote-pi] No matching paired device.", "warning"); return; }
  const peer = matches[0]!;
  await removePeer(peer.remote_epk);
  try { deps.detachOwner(canonicalizeEd25519PublicKey(peer.remote_epk, "Owner public key")); } catch { deps.detachOwner(peer.remote_epk); }
  await deps.updateEndpoint();
  notify(ctx, `[remote-pi] Revoked: ${peer.name}`);
}

function status(ctx: CommandUiContext, deps: RemoteCommandDependencies): void {
  const url = deps.relayUrl() ?? resolveRelayUrl().url;
  const identity = deps.endpointIdentity();
  const detail = deps.state() === "idle"
    ? "off"
    : `${deps.relayStatus()}, endpoint=${identity.endpointId}, runtime=${identity.runtimeInstanceId}, owners=${deps.activeOwnerCount()}`;
  notify(ctx, `[remote-pi] Relay ${detail} (${url})`);
}

function setRelay(value: string, ctx: CommandUiContext): void {
  const url = value.trim();
  if (isWebSocketScheme(url)) { notify(ctx, "[remote-pi] Use http:// or https://; it is converted internally.", "warning"); return; }
  if (!isValidRelayUrl(url)) { notify(ctx, "[remote-pi] Invalid Relay URL.", "warning"); return; }
  saveConfig({ relay: url });
  notify(ctx, `[remote-pi] Relay set to ${url}.`);
}

export function persistModelDefault(provider: string, modelId: string): void {
  try {
    const path = join(process.cwd(), ".pi", "settings.json");
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { /* fresh file */ }
    config.defaultProvider = provider;
    config.defaultModel = modelId;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2));
  } catch { /* a live model switch must not fail because persistence failed */ }
}

function daemonLines(daemons: readonly DaemonInfo[]): string {
  return daemons.map((daemon) => `${daemon.id.slice(0, 8)}  ${daemon.name}  ${daemon.health}  ${daemon.relay}`).join("\n") || "(none)";
}

async function daemonList(ctx: CommandUiContext): Promise<void> {
  if (await supervisorOnline()) {
    const data = await callSupervisor({ op: "list" });
    notify(ctx, `[remote-pi] Daemons:\n${daemonLines(data.daemons)}`);
    return;
  }
  const entries = listDaemons();
  notify(ctx, `[remote-pi] Daemons (supervisor offline):\n${entries.map((entry) => `${entry.id.slice(0, 8)}  ${entry.name}  ${entry.desired_state}`).join("\n") || "(none)"}`);
}

async function daemonControl(op: DaemonOperation, id: string | undefined, ctx: CommandUiContext): Promise<void> {
  const data = await callSupervisor(id ? { op, id } : { op: `${op}_all` } as Extract<ControlRequest, { op: "start_all" | "stop_all" | "restart_all" }>);
  notify(ctx, `[remote-pi] ${op}: ${JSON.stringify(data)}`);
}

async function daemonCreate(arg: string, ctx: CommandUiContext): Promise<void> {
  const cwd = arg.trim() || process.cwd();
  const entry = addDaemon(cwd);
  try { await callSupervisor({ op: "start", id: entry.id }); }
  catch (error) { if (!(error instanceof SupervisorOfflineError)) throw error; }
  notify(ctx, `[remote-pi] Registered daemon ${entry.id} for ${entry.cwd}.`);
}

async function daemonRemove(arg: string, ctx: CommandUiContext): Promise<void> {
  const id = arg.trim();
  if (!id) { notify(ctx, "[remote-pi] Usage: remove <daemon-id>", "warning"); return; }
  const removed = await supervisorOnline() ? await callSupervisor({ op: "unregister", id }) : removeDaemon(id);
  notify(ctx, removed.removed ? "[remote-pi] Daemon removed." : "[remote-pi] No daemon matched.", removed.removed ? "info" : "warning");
}

async function daemonRemoveCwd(cwd: string, ctx: CommandUiContext): Promise<void> {
  const target = cwd.trim() || process.cwd();
  const removed = await supervisorOnline()
    ? await callSupervisor({ op: "unregister_cwd", cwd: target })
    : (() => { const entry = findDaemonByCwd(target); return entry ? removeDaemon(entry.id) : { removed: false }; })();
  notify(ctx, removed.removed ? "[remote-pi] Daemon removed." : "[remote-pi] No daemon matched.", removed.removed ? "info" : "warning");
}

function install(ctx: CommandUiContext): void {
  try { installService(); linkCliBinaries(); notify(ctx, "[remote-pi] Supervisor service installed."); }
  catch (error) { notify(ctx, `[remote-pi] install failed: ${String(error)}`, "error"); }
}

function uninstall(ctx: CommandUiContext): void {
  try { uninstallService(); unlinkCliBinaries(); notify(ctx, "[remote-pi] Supervisor service removed."); }
  catch (error) { notify(ctx, `[remote-pi] uninstall failed: ${String(error)}`, "error"); }
}

async function command(args: string, ctx: ExtensionCommandContext, deps: RemoteCommandDependencies): Promise<void> {
  deps.setCommandContext(ctx);
  const [verb, ...rest] = args.trim().split(/\s+/);
  const value = rest.join(" ");
  try {
    switch (verb || "start") {
      case "start": await deps.start(ctx); return;
      case "stop": deps.stop(); notify(ctx, "[remote-pi] Stopped."); return;
      case "status": status(ctx, deps); return;
      case "pair": await pair(ctx, value, deps); return;
      case "devices": await listDevices(ctx, deps); return;
      case "revoke": await revoke(value, ctx, deps); return;
      case "set-relay": setRelay(value, ctx); return;
      case "config": notify(ctx, `[remote-pi] ${resolveRelayUrl().url}`); return;
      case "daemons": await daemonList(ctx); return;
      case "create": await daemonCreate(value, ctx); return;
      case "remove": await daemonRemove(value, ctx); return;
      case "remove-cwd": await daemonRemoveCwd(value, ctx); return;
      case "install": install(ctx); return;
      case "uninstall": uninstall(ctx); return;
      case "daemon": {
        const [operation, id] = value.split(/\s+/, 2);
        if (operation === "start" || operation === "stop" || operation === "restart") await daemonControl(operation, id, ctx);
        else if (operation === "status") await daemonList(ctx);
        else notify(ctx, "[remote-pi] Usage: daemon <start|stop|restart|status> [id]", "warning");
        return;
      }
      default: await deps.start(ctx); return;
    }
  } catch (error) {
    notify(ctx, `[remote-pi] ${verb} failed: ${String(error)}`, "error");
  }
}

export function registerCommands(pi: ExtensionAPI, deps: RemoteCommandDependencies): void {
  const handler = (args: string, ctx: ExtensionCommandContext): Promise<void> => command(args, ctx, deps);
  pi.registerCommand("remote-pi", { description: "Connect this Pi endpoint to Remote Pi", handler });
  pi.registerCommand("remote-pi start", { description: "Connect this endpoint to Relay", handler: async (_, ctx) => handler("start", ctx) });
  pi.registerCommand("remote-pi stop", { description: "Disconnect this endpoint", handler: async (_, ctx) => handler("stop", ctx) });
  pi.registerCommand("remote-pi pair", { description: "Show an endpoint pairing QR", handler: async (args, ctx) => handler(`pair ${args}`, ctx) });
  pi.registerCommand("remote-pi devices", { description: "List locally paired Owners", handler: async (_, ctx) => handler("devices", ctx) });
  pi.registerCommand("remote-pi revoke", { description: "Revoke a locally paired Owner", handler: async (args, ctx) => handler(`revoke ${args}`, ctx) });
  pi.registerCommand("remote-pi remove-cwd", { description: "Unregister the daemon for a cwd", handler: async (args, ctx) => handler(`remove-cwd ${args}`, ctx) });
  pi.registerCommand("remote-pi set-relay", { description: "Set Relay URL", handler: async (args, ctx) => handler(`set-relay ${args}`, ctx) });
}

function directCliContext(): CommandUiContext {
  return { ui: { notify: (message: string) => console.log(message) } as unknown as ExtensionContext["ui"] };
}

export function runDirectCli(deps: RemoteCommandDependencies, directRun: boolean): void {
  if (!directRun) return;
  const [, , commandName, ...args] = process.argv;
  const ctx = directCliContext();
  if (commandName === "devices" || commandName === "list") void listDevices(ctx, deps);
  else if (commandName === "revoke") void revoke(args[0] ?? "", ctx, deps);
  else if (commandName === "set-relay") setRelay(args[0] ?? "", ctx);
  else if (commandName === "daemons") void daemonList(ctx);
  else if (commandName === "daemon" && ["start", "stop", "restart"].includes(args[0] ?? "")) void daemonControl(args[0] as DaemonOperation, args[1], ctx);
  else if (commandName === "create") void daemonCreate(args.join(" "), ctx);
  else if (commandName === "remove") void daemonRemove(args[0] ?? "", ctx);
  else if (commandName === "remove-cwd") void daemonRemoveCwd(args.join(" "), ctx);
  else if (commandName === "install") install(ctx);
  else if (commandName === "uninstall") uninstall(ctx);
  else if (commandName === "restart-supervisor") restartSupervisor();
  else console.log("Usage: remote-pi <devices|revoke|set-relay|daemons|daemon|create|remove|remove-cwd|install|uninstall>");
}

function restartSupervisor(): void {
  const uid = process.getuid?.() ?? 0;
  const step = process.platform === "darwin"
    ? ["launchctl", ["kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`]]
    : process.platform === "linux"
      ? ["systemctl", ["--user", "restart", SYSTEMD_UNIT]]
      : null;
  if (!step) process.exitCode = 1;
  else spawnSync(step[0] as string, step[1] as string[], { stdio: "inherit" });
}
