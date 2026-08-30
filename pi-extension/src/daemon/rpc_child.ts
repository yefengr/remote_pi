import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DaemonState, ProcessState, RelayState, RuntimeState } from "./control_protocol.js";
import { defaultAgentName, loadLocalConfig, type LocalConfig } from "../session/local_config.js";

/** RPC child wrapper. PID creation is not readiness: only structured stdout
 * responses/events can move runtime from pending to ready. */
export interface RpcChildOptions {
  piBin?: string;
  /** Retained until bin/supervisor wiring is removed; daemon spawn deliberately
   * does not pass it as `-e` because Pi's configured extension environment is
   * the sole extension source. */
  extensionPath: string;
  cwd: string;
  /** Stable daemon endpoint identity supplied by the supervisor. */
  endpointId?: string;
  env?: NodeJS.ProcessEnv;
  config?: LocalConfig;
  readinessTimeoutMs?: number;
  promptTimeoutMs?: number;
}

export interface RpcChildExitEvent {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True for every exit not initiated through stop(), including code 0. */
  isCrash: boolean;
}

export interface PromptAcceptance {
  accepted: boolean;
  code?: string;
  error?: string;
}

export interface RuntimeReadyEvent {
  control_protocol_version?: number;
  extension_version?: string;
  endpoint_id?: string;
  runtime_instance_id?: string;
  session_id?: string;
}

export interface RuntimeFailedEvent {
  stage?: string;
  code: string;
  message?: string;
  retryable: boolean;
}

export interface RelayStateChangedEvent { state: RelayState; }
export interface SessionChangedEvent { session_id?: string; }

export const EXIT_DAEMON_FRESH_SESSION = 42;
export const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
export const DEFAULT_PROMPT_TIMEOUT_MS = 5_000;

const WIN_EXECUTABLE_EXTS = [".exe", ".cmd", ".bat", ".com"];

export function resolvePiBin(piBin: string, plat: NodeJS.Platform = process.platform): string {
  if (plat !== "win32") return piBin;
  if (piBin.includes("\\") || piBin.includes("/") || /\.[a-z0-9]+$/i.test(piBin)) return piBin;
  try {
    const out = execFileSync("where", [piBin], { encoding: "utf8" });
    const lines = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.find((line) => WIN_EXECUTABLE_EXTS.some((ext) => line.toLowerCase().endsWith(ext))) ?? lines[0] ?? piBin;
  } catch {
    return piBin;
  }
}

export interface PiSpawnTarget { command: string; prefixArgs: string[]; }

export function resolvePiSpawn(piBin: string, plat: NodeJS.Platform = process.platform, nodeExe: string = process.execPath): PiSpawnTarget {
  const resolved = resolvePiBin(piBin, plat);
  if (plat !== "win32") return { command: resolved, prefixArgs: [] };
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const target = _npmShimTarget(resolved);
    if (target) return { command: nodeExe, prefixArgs: [target] };
  }
  return { command: resolved, prefixArgs: [] };
}

export function _npmShimTarget(cmdPath: string): string | null {
  let content: string;
  try { content = readFileSync(cmdPath, "utf8"); } catch { return null; }
  const match = content.match(/"%dp0%\\([^\"]+\.[cm]?js)"/i);
  if (!match) return null;
  const target = join(dirname(cmdPath), match[1]!);
  return existsSync(target) ? target : null;
}

export function busyTransition(line: string): boolean | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  const type = (value as { type?: unknown } | null)?.type;
  if (type === "message_start") return true;
  if (type === "message_end") return false;
  return null;
}

/**
 * The installed Pi RPC starts configured extensions itself. In particular this
 * must not attach Remote Pi with `-e`, which could load it a second time.
 */
export function rpcSpawnArgs(_extensionPath: string, sessionName?: string, useContinue = true): string[] {
  return [
    "--mode", "rpc",
    "--approve",
    ...(useContinue ? ["--continue"] : []),
    ...(sessionName ? ["--name", sessionName] : []),
  ];
}

type RpcResponse = {
  id?: unknown;
  type?: unknown;
  command?: unknown;
  success?: unknown;
  error?: unknown;
  data?: unknown;
};

type Pending<T> = { resolve: (result: T) => void; timer: ReturnType<typeof setTimeout>; };

type ParsedRuntimeEvent =
  | { type: "runtime_ready"; event: RuntimeReadyEvent }
  | { type: "runtime_failed"; event: RuntimeFailedEvent }
  | { type: "relay_state_changed"; event: RelayStateChangedEvent }
  | { type: "session_changed"; event: SessionChangedEvent };

/**
 * Parses direct daemon-control events and the current extension's custom
 * relay-state message shape. Natural-language stderr is intentionally absent.
 */
export function parseRuntimeEvent(line: string): ParsedRuntimeEvent | null {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  let type = obj["type"];
  let payload: Record<string, unknown> = obj;
  if (type === "entry_appended" && obj["entry"] && typeof obj["entry"] === "object") {
    const entry = obj["entry"] as Record<string, unknown>;
    const customType = entry["customType"];
    const details = entry["details"];
    if (typeof customType === "string" && details && typeof details === "object") {
      type = customType.replace(/^remote-pi:/, "").replace(/-/g, "_");
      payload = details as Record<string, unknown>;
    }
  }
  if (type === "runtime_ready") {
    return {
      type,
      event: {
        control_protocol_version: typeof payload["control_protocol_version"] === "number" ? payload["control_protocol_version"] : undefined,
        extension_version: typeof payload["extension_version"] === "string" ? payload["extension_version"] : undefined,
        endpoint_id: typeof payload["endpoint_id"] === "string" ? payload["endpoint_id"] : undefined,
        runtime_instance_id: typeof payload["runtime_instance_id"] === "string" ? payload["runtime_instance_id"] : undefined,
        session_id: typeof payload["session_id"] === "string" ? payload["session_id"] : undefined,
      },
    };
  }
  if (type === "runtime_failed") {
    if (typeof payload["code"] !== "string" || typeof payload["retryable"] !== "boolean") return null;
    return { type, event: {
      stage: typeof payload["stage"] === "string" ? payload["stage"] : undefined,
      code: payload["code"],
      message: typeof payload["message"] === "string" ? payload["message"] : undefined,
      retryable: payload["retryable"],
    } };
  }
  if (type === "relay_state_changed" || type === "relay_state") {
    const state = payload["state"] ?? payload["status"];
    if (state === "disconnected" || state === "connecting" || state === "connected" || state === "reconnecting") {
      return { type: "relay_state_changed", event: { state } };
    }
  }
  if (type === "session_changed") {
    return { type, event: { session_id: typeof payload["session_id"] === "string" ? payload["session_id"] : undefined } };
  }
  return null;
}

export class RpcChild extends EventEmitter {
  private child: ChildProcess | null = null;
  private _state: DaemonState = "stopped";
  private _process: ProcessState = "absent";
  private _runtime: RuntimeState = "pending";
  private _relay: RelayState = "disconnected";
  private _startedAt: number | undefined;
  private _runtimeInstanceId: string | undefined;
  private _sessionId: string | undefined;
  private _restartCount = 0;
  private _stopping = false;
  private forceFreshSessionOnNextSpawn = false;
  private stdoutBuf = "";
  private _busy = false;
  private rpcReady = false;
  private extensionReady = false;
  private extensionReadyEvent: RuntimeReadyEvent | null = null;
  private readinessTimer: ReturnType<typeof setTimeout> | null = null;
  private readyPromise: Promise<boolean> = Promise.resolve(false);
  private readyResolve: ((ready: boolean) => void) | null = null;
  private readonly statePending = new Map<string, Pending<boolean>>();
  private readonly promptPending = new Map<string, Pending<PromptAcceptance>>();

  constructor(private readonly opts: RpcChildOptions) { super(); }

  get state(): DaemonState { return this._state; }
  get processState(): ProcessState { return this._process; }
  get runtimeState(): RuntimeState { return this._runtime; }
  get relayState(): RelayState { return this._relay; }
  get isBusy(): boolean { return this._busy; }
  get pid(): number | undefined { return this.child?.pid; }
  get restartCount(): number { return this._restartCount; }
  get startedAt(): number | undefined { return this._startedAt; }
  get runtimeInstanceId(): string | undefined { return this._runtimeInstanceId; }
  get sessionId(): string | undefined { return this._sessionId; }
  get uptimeMs(): number | undefined { return this._startedAt === undefined ? undefined : Date.now() - this._startedAt; }

  /** Resolves true only after the readiness probe/event, false on timeout/exit. */
  ready(): Promise<boolean> { return this.readyPromise; }

  spawn(): void {
    if (this.child) return;
    this._stopping = false;
    this._busy = false;
    this._state = "starting";
    this._process = "spawning";
    this._runtime = "pending";
    this._relay = "connecting";
    this._sessionId = undefined;
    this.rpcReady = false;
    this.extensionReady = false;
    this.extensionReadyEvent = null;
    this._runtimeInstanceId = randomUUID();
    this.readyPromise = new Promise<boolean>((resolve) => { this.readyResolve = resolve; });

    const target = resolvePiSpawn(this.opts.piBin ?? "pi");
    const config = this.opts.config ?? loadLocalConfig(this.opts.cwd);
    const sessionName = config.agent_name ?? defaultAgentName(this.opts.cwd);
    const useContinue = !this.forceFreshSessionOnNextSpawn;
    this.forceFreshSessionOnNextSpawn = false;
    const args = [...target.prefixArgs, ...rpcSpawnArgs(this.opts.extensionPath, sessionName, useContinue)];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.opts.env,
      REMOTE_PI_DAEMON: "1",
      REMOTE_PI_ENDPOINT_ID: this.opts.endpointId ?? "",
      REMOTE_PI_RUNTIME_INSTANCE_ID: this._runtimeInstanceId,
      ...(this.opts.config ? { REMOTE_PI_DIRECT_CONFIG: JSON.stringify(this.opts.config) } : {}),
    };

    const child = spawn(target.command, args, { cwd: this.opts.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: process.platform === "win32" });
    this.child = child;
    this._startedAt = Date.now();
    // A spawned ChildProcess object is not evidence its executable completed
    // startup. Preserve `spawning` until Node reports the OS spawn event.
    child.once("spawn", () => {
      if (this.child === child && this._process === "spawning") this._process = "running";
    });
    child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[${this.opts.cwd}] ${chunk.toString()}`));
    child.on("exit", (code, signal) => this.onExit(code, signal));
    child.on("error", (error) => {
      this.failRuntime({ stage: "spawn", code: "spawn_failed", message: String(error), retryable: true });
      this._process = "exited";
    });
    this.startReadinessProbe();
    this.emit("spawn", { pid: child.pid, runtime_instance_id: this._runtimeInstanceId });
  }

  /** Waits for Pi's correlated prompt preflight response, not merely stdin write. */
  sendPrompt(text: string, requestId = `sv-${randomUUID()}`, timeoutMs = this.opts.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS): Promise<PromptAcceptance> {
    if (!this.child?.stdin || this._process !== "running" || this._runtime !== "ready") {
      return Promise.resolve({ accepted: false, code: "runtime_not_ready", error: "daemon RPC runtime is not ready" });
    }
    return new Promise<PromptAcceptance>((resolve) => {
      const timer = setTimeout(() => {
        this.promptPending.delete(requestId);
        resolve({ accepted: false, code: "prompt_response_timeout", error: "Pi did not accept the prompt before timeout" });
      }, timeoutMs);
      this.promptPending.set(requestId, { resolve, timer });
      try {
        this.child!.stdin!.write(JSON.stringify({ id: requestId, type: "prompt", message: text }) + "\n");
      } catch (error) {
        clearTimeout(timer);
        this.promptPending.delete(requestId);
        resolve({ accepted: false, code: "stdin_write_failed", error: String(error) });
      }
    });
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    if (!this.child) return;
    this._stopping = true;
    const child = this.child;
    await new Promise<void>((resolve) => {
      this.once("exit", resolve);
      try { child.kill("SIGTERM"); } catch { resolve(); }
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* process already gone */ } }, timeoutMs);
      this.once("exit", () => clearTimeout(timer));
    });
  }

  async refreshBusy(timeoutMs = 1_500): Promise<boolean> {
    if (this._process !== "running" || !this.child?.stdin) return this._busy;
    const id = `gs-${randomUUID()}`;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { this.statePending.delete(id); resolve(this._busy); }, timeoutMs);
      this.statePending.set(id, { resolve, timer });
      try { this.child!.stdin!.write(JSON.stringify({ id, type: "get_state" }) + "\n"); }
      catch { clearTimeout(timer); this.statePending.delete(id); resolve(this._busy); }
    });
  }

  /** Test injection point for deterministic RPC event/response coverage. */
  _ingestStdoutForTest(line: string): void { this.handleStdoutLine(line); }

  private startReadinessProbe(): void {
    const timeoutMs = this.opts.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.readinessTimer = setTimeout(() => {
      if (this.rpcReady && !this.extensionReady) {
        this.failRuntime({ stage: "extension", code: "extension_not_ready", message: "Pi RPC is ready but the configured Remote Pi extension did not report readiness", retryable: false });
        return;
      }
      this.failRuntime({ stage: "rpc_probe", code: "readiness_timeout", message: "Pi RPC get_state did not respond before timeout", retryable: true });
    }, timeoutMs);
    const id = `ready-${randomUUID()}`;
    try {
      this.child?.stdin?.write(JSON.stringify({ id, type: "get_state" }) + "\n");
    } catch (error) {
      this.failRuntime({ stage: "rpc_probe", code: "readiness_probe_write_failed", message: String(error), retryable: true });
    }
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf += chunk.toString();
    let newline: number;
    while ((newline = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, newline);
      this.stdoutBuf = this.stdoutBuf.slice(newline + 1);
      if (line.trim()) this.handleStdoutLine(line);
    }
  }

  private handleStdoutLine(line: string): void {
    const busy = busyTransition(line);
    if (busy !== null) this._busy = busy;
    const response = this.parseResponse(line);
    if (response) this.handleResponse(response);
    const event = parseRuntimeEvent(line);
    if (event) this.handleRuntimeEvent(event);
    this.emit("stdout", line);
  }

  private parseResponse(line: string): RpcResponse | null {
    try {
      const value = JSON.parse(line) as RpcResponse;
      return value.type === "response" ? value : null;
    } catch {
      return null;
    }
  }

  private handleResponse(response: RpcResponse): void {
    if (typeof response.id !== "string" || typeof response.command !== "string") return;
    if (response.command === "get_state") {
      const pending = this.statePending.get(response.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.statePending.delete(response.id);
        const streaming = (response.data as { isStreaming?: unknown } | undefined)?.isStreaming;
        if (typeof streaming === "boolean") this._busy = streaming;
        pending.resolve(this._busy);
      }
      if (response.success === true) {
        const data = response.data as { sessionId?: unknown } | undefined;
        this.rpcReady = true;
        if (typeof data?.sessionId === "string") this._sessionId = data.sessionId;
        this.maybeMarkReady();
      } else {
        this.failRuntime({ stage: "rpc_probe", code: "readiness_probe_rejected", message: typeof response.error === "string" ? response.error : "Pi rejected get_state", retryable: true });
      }
      return;
    }
    if (response.command === "prompt") {
      const pending = this.promptPending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.promptPending.delete(response.id);
      pending.resolve(response.success === true
        ? { accepted: true }
        : { accepted: false, code: "prompt_rejected", error: typeof response.error === "string" ? response.error : "Pi rejected prompt" });
    }
  }

  private handleRuntimeEvent(event: ParsedRuntimeEvent): void {
    switch (event.type) {
      case "runtime_ready": this.acceptExtensionReady(event.event); break;
      case "runtime_failed": this.failRuntime(event.event); break;
      case "relay_state_changed":
        this._relay = event.event.state;
        this.emit("relay_state_changed", event.event);
        break;
      case "session_changed":
        this._sessionId = event.event.session_id;
        this.emit("session_changed", event.event);
        break;
    }
  }

  private acceptExtensionReady(event: RuntimeReadyEvent): void {
    if (this._runtime === "failed" || !this.child) return;
    if (event.control_protocol_version !== 2) {
      this.failRuntime({ stage: "extension", code: "control_protocol_mismatch", message: "Remote Pi extension control protocol is incompatible", retryable: false });
      return;
    }
    if (event.endpoint_id !== this.opts.endpointId || event.runtime_instance_id !== this._runtimeInstanceId) {
      this.failRuntime({ stage: "extension", code: "runtime_identity_mismatch", message: "Remote Pi extension reported a different endpoint runtime identity", retryable: false });
      return;
    }
    this.extensionReady = true;
    this.extensionReadyEvent = event;
    if (event.session_id) this._sessionId = event.session_id;
    this.maybeMarkReady();
  }

  private maybeMarkReady(): void {
    if (!this.rpcReady || !this.extensionReady || this._runtime === "failed" || !this.child) return;
    this._process = "running";
    if (this.readinessTimer) { clearTimeout(this.readinessTimer); this.readinessTimer = null; }
    this._runtime = "ready";
    this._state = "running";
    this.readyResolve?.(true);
    this.readyResolve = null;
    this.emit("runtime_ready", { ...this.extensionReadyEvent, session_id: this._sessionId, endpoint_id: this.opts.endpointId, runtime_instance_id: this._runtimeInstanceId });
  }

  private failRuntime(event: RuntimeFailedEvent): void {
    if (this._runtime === "failed") return;
    if (this.readinessTimer) { clearTimeout(this.readinessTimer); this.readinessTimer = null; }
    this._runtime = "failed";
    this._state = event.retryable ? "crashed" : "blocked";
    this.readyResolve?.(false);
    this.readyResolve = null;
    this.emit("runtime_failed", event);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (code === EXIT_DAEMON_FRESH_SESSION) this.forceFreshSessionOnNextSpawn = true;
    if (this.readinessTimer) { clearTimeout(this.readinessTimer); this.readinessTimer = null; }
    const isCrash = !this._stopping;
    this._process = "exited";
    if (this._runtime !== "failed") this._runtime = "pending";
    this._state = isCrash ? "crashed" : "stopped";
    this.child = null;
    this._startedAt = undefined;
    this._busy = false;
    this._relay = "disconnected";
    this.readyResolve?.(false);
    this.readyResolve = null;
    for (const pending of this.statePending.values()) { clearTimeout(pending.timer); pending.resolve(false); }
    this.statePending.clear();
    for (const pending of this.promptPending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ accepted: false, code: "child_exited", error: "daemon exited before Pi accepted the prompt" });
    }
    this.promptPending.clear();
    this.emit("exit", { code, signal, isCrash } satisfies RpcChildExitEvent);
  }

  noteRestart(): void { this._restartCount += 1; }
}
