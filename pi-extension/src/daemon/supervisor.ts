import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Cron } from "croner";
import {
  addDaemon, findDaemonByCwd, listDaemons, removeDaemon, setDaemonDesiredState,
  type DaemonEntry, type DesiredState,
} from "./registry.js";
import { defaultAgentName, type LocalConfig } from "../session/local_config.js";
import { ipcAddress, usesNamedPipe } from "../session/ipc.js";
import {
  EXIT_DAEMON_FRESH_SESSION, RpcChild,
  type RpcChildExitEvent, type RpcChildOptions, type RuntimeFailedEvent,
} from "./rpc_child.js";
import {
  type ControlReply, type ControlRequest, type CronJobView, type DaemonInfo,
  encodeReply, parseRequest,
} from "./control_protocol.js";
import {
  addJob as addCronJob, getJob as getCronJob, listJobs as listCronJobs,
  nextRunFor, recordRun, removeJob as removeCronJob, setJobEnabled, validateSchedule,
  type CronJob, type NewJobInput,
} from "./cron_registry.js";
import { appendCronLog, readCronLog, type CronResult } from "./cron_log.js";
import { decideFireAction, infoFor, type FireAction, type DaemonStatusSnapshot } from "./status.js";
import { probeSupervisor } from "./supervisor-ipc.js";

const SUPERVISOR_SOCK_NAME = "supervisor.sock";
const RESTART_BACKOFFS_MS = [1_000, 5_000, 30_000, 5 * 60_000], RESTART_STABILITY_MS = 30_000, RECONCILE_INTERVAL_MS = 15_000, MISSING_CWD_CONFIRMATIONS = 2;

function supervisorSockPath(): string {
  const root = process.env["REMOTE_PI_HOME"] || homedir();
  return ipcAddress("supervisor", join(root, ".pi", "remote", SUPERVISOR_SOCK_NAME));
}

export class SupervisorAlreadyRunningError extends Error {
  constructor(public readonly sockPath: string) {
    super(`Another pi-supervisord is already running (UDS held at ${sockPath}).`);
    this.name = "SupervisorAlreadyRunningError";
  }
}

export interface SupervisorOptions {
  piBin?: string;
  reconcileIntervalMs?: number;
  childFactory?: (options: RpcChildOptions) => RpcChild;
}

export { decideFireAction, type FireAction } from "./status.js";

type SlotError = { code: string; message?: string; at: number; retryable: boolean; stage: string; };

interface ChildSlot { entry: DaemonEntry; child: RpcChild; restartTimer: ReturnType<typeof setTimeout> | null; stabilityTimer: ReturnType<typeof setTimeout> | null; restartAttempt: number; nextRetryAt?: number; blocked: boolean; error?: SlotError; missingCwdObservations: number; reconcileInProgress: boolean; }

export class Supervisor {
  private server: Server | null = null;
  private readonly children = new Map<string, ChildSlot>();
  private readonly cronJobs = new Map<string, Cron>();
  private shuttingDown = false;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileRunning = false;
  private readonly lifecycleQueues = new Map<string, Promise<void>>();
  private readonly controlSockets = new Map<Socket, { requestStarted: boolean }>();
  private readonly activeRequests = new Set<Promise<void>>();

  constructor(private readonly opts: SupervisorOptions) {}

  async start(): Promise<void> {
    this.mkdirParent();
    await this.bindUds();
    await this.reconcileRegistryCwds();
    this.spawnDesiredEntries();
    this.reconcileCron();
    this.runCatchup();
    const interval = this.opts.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS;
    this.reconcileTimer = setInterval(() => { void this.reconcileRegistryCwds(); }, interval);
    this.reconcileTimer.unref();
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    for (const cron of this.cronJobs.values()) cron.stop();
    this.cronJobs.clear();

    const server = this.server;
    this.server = null;
    const serverClosed = new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    for (const [socket, state] of this.controlSockets) {
      if (!state.requestStarted) socket.destroy();
    }
    for (const slot of this.children.values()) {
      this.cancelRetry(slot);
      this.cancelStabilityReset(slot);
    }

    await Promise.all([...this.activeRequests]);
    while (this.lifecycleQueues.size > 0) await Promise.all([...this.lifecycleQueues.values()]);
    await Promise.all([...this.children.values()].map(async (slot) => slot.child.stop()));
    this.children.clear();
    await serverClosed;
    if (!usesNamedPipe()) {
      try { unlinkSync(supervisorSockPath()); } catch { /* socket already absent */ }
    }
  }

  private mkdirParent(): void {
    if (!usesNamedPipe()) mkdirSync(dirname(supervisorSockPath()), { recursive: true });
  }

  private async bindUds(): Promise<void> {
    const path = supervisorSockPath();
    const namedPipe = usesNamedPipe();
    if (namedPipe || existsSync(path)) {
      if (await probeSupervisor(path)) throw new SupervisorAlreadyRunningError(path);
      if (!namedPipe) { try { unlinkSync(path); } catch { /* bind reports an actual race */ } }
    }
    const server = createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => resolve());
    });
    this.server = server;
  }

  private onConnection(socket: Socket): void {
    if (this.shuttingDown) {
      socket.destroy();
      return;
    }
    const state = { requestStarted: false };
    this.controlSockets.set(socket, state);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (state.requestStarted || this.shuttingDown) return;
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      state.requestStarted = true;
      let task!: Promise<void>;
      task = this.handleRequest(buffer.slice(0, newline)).then(
        (reply) => { socket.end(encodeReply(reply)); },
        (error) => { socket.end(encodeReply({ ok: false, error: String(error) })); },
      ).finally(() => this.activeRequests.delete(task));
      this.activeRequests.add(task);
    });
    socket.on("close", () => this.controlSockets.delete(socket));
    socket.on("error", () => { /* callers can abandon a control operation */ });
  }

  private async handleRequest(line: string): Promise<ControlReply<unknown>> {
    let request: ControlRequest;
    try { request = parseRequest(line); }
    catch (error) { return { ok: false, error: (error as Error).message }; }
    await this.reconcileRegistryCwds();
    switch (request.op) {
      case "list": return { ok: true, data: { daemons: this.listInfo() } };
      case "status": return { ok: true, data: { daemons: this.listInfo() } };
      case "start_all": return this.startAll();
      case "start": return this.startOne(request.id);
      case "stop_all": return this.stopAll();
      case "stop": return this.stopOne(request.id);
      case "restart_all": return this.restartAll();
      case "restart": return this.restartOne(request.id);
      case "send": return this.send(request.id, request.text);
      case "register": return this.register(request.cwd);
      case "unregister": return this.unregister(request.id);
      case "unregister_cwd": return this.unregisterCwd(request.cwd);
      case "cron_add": return this.cronAdd(request);
      case "cron_list": return { ok: true, data: { jobs: listCronJobs().map((job) => this.jobView(job)) } };
      case "cron_remove": return this.cronRemove(request.job_id);
      case "cron_enable": return this.cronEnable(request.job_id, request.enabled);
      case "cron_run": return this.cronRun(request.job_id);
      case "cron_log": return { ok: true, data: { entries: readCronLog({ jobId: request.job_id, tail: request.tail }) } };
      default: return { ok: false, error: `unknown op: ${(request as { op: string }).op}` };
    }
  }

  private listInfo(): DaemonInfo[] {
    return listDaemons().map((entry) => this.infoFor(entry));
  }

  private infoFor(entry: DaemonEntry): DaemonInfo {
    const slot = this.children.get(entry.id);
    const snapshot: DaemonStatusSnapshot = {
      id: entry.id,
      cwd: entry.cwd,
      name: entry.name,
      registration: existsSync(entry.cwd) ? "registered" : "missing",
      desired: entry.desired_state,
      process: slot?.child.processState ?? "absent",
      runtime: slot?.child.runtimeState ?? "pending",
      relay: slot?.child.relayState ?? "disconnected",
      ...(slot?.child.runtimeInstanceId ? { runtimeInstanceId: slot.child.runtimeInstanceId } : {}),
      ...(slot?.child.pid !== undefined ? { pid: slot.child.pid } : {}),
      ...(slot?.child.startedAt !== undefined ? { startedAt: slot.child.startedAt } : {}),
      ...(slot?.child.uptimeMs !== undefined ? { uptimeMs: slot.child.uptimeMs } : {}),
      restartCount: slot?.child.restartCount ?? 0,
      retrying: !!slot?.restartTimer,
      ...(slot?.nextRetryAt ? { nextRetryAt: slot.nextRetryAt } : {}),
      blocked: !!slot?.blocked || slot?.child.state === "blocked",
      ...(slot?.error ? { error: slot.error } : {}),
    };
    return infoFor(snapshot);
  }

  private async startAll(): Promise<ControlReply<unknown>> {
    const started: string[] = [];
    const alreadyRunning: string[] = [];
    for (const entry of listDaemons()) {
      const result = await this.startEntry(entry);
      (result ? alreadyRunning : started).push(entry.id);
    }
    return { ok: true, data: { started, already_running: alreadyRunning } };
  }

  private async startOne(id: string): Promise<ControlReply<unknown>> {
    const entry = listDaemons().find((item) => item.id === id);
    if (!entry) return { ok: false, error: `no daemon with id ${id}` };
    const alreadyRunning = await this.startEntry(entry);
    const updated = listDaemons().find((item) => item.id === id);
    if (!updated) return { ok: false, error: `no daemon with id ${id}` };
    const info = this.infoFor(updated);
    return { ok: true, data: { id, state: info.state, started: !alreadyRunning, desired_state: "running" } };
  }

  private startEntry(entry: DaemonEntry): Promise<boolean> {
    return this.enqueueLifecycle(entry.id, async () => {
      const updated = setDaemonDesiredState(entry.id, "running");
      if (!updated) return true;
      const slot = this.children.get(entry.id);
      if (slot) slot.entry = updated;
      if (slot && (slot.child.processState === "running" || slot.child.processState === "spawning") && !slot.blocked) return true;
      if (slot) {
        this.cancelRetry(slot);
        slot.blocked = false;
        slot.error = undefined;
        slot.entry = updated;
        if (slot.child.processState === "exited" || slot.child.pid === undefined) {
          slot.child.spawn();
          return false;
        }
        await slot.child.stop();
        if (this.children.get(entry.id) === slot && !this.shuttingDown && slot.entry.desired_state === "running") slot.child.spawn();
        return false;
      }
      if (!this.shuttingDown) this.createSlot(updated);
      return false;
    });
  }

  private async stopAll(): Promise<ControlReply<unknown>> {
    const stopped: string[] = [], alreadyStopped: string[] = [];
    for (const entry of listDaemons()) (await this.stopEntry(entry) ? stopped : alreadyStopped).push(entry.id);
    return { ok: true, data: { stopped, already_stopped: alreadyStopped } };
  }

  private async stopOne(id: string): Promise<ControlReply<unknown>> {
    const entry = listDaemons().find((item) => item.id === id);
    if (!entry) return { ok: false, error: `no daemon with id ${id}` };
    const stopped = await this.stopEntry(entry);
    const updated = listDaemons().find((item) => item.id === id);
    if (!updated) return { ok: false, error: `no daemon with id ${id}` };
    const info = this.infoFor(updated);
    return { ok: true, data: { id, state: info.state, stopped, desired_state: "stopped" } };
  }

  private stopEntry(entry: DaemonEntry): Promise<boolean> {
    return this.enqueueLifecycle(entry.id, async () => {
      const updated = setDaemonDesiredState(entry.id, "stopped");
      if (!updated) return false;
      const slot = this.children.get(entry.id);
      if (slot) slot.entry = updated;
      if (!slot) return false;
      this.cancelRetry(slot);
      this.cancelStabilityReset(slot);
      const wasLive = slot.child.processState === "running" || slot.child.processState === "spawning";
      await slot.child.stop();
      return wasLive;
    });
  }

  private async restartOne(id: string): Promise<ControlReply<unknown>> {
    const entry = listDaemons().find((item) => item.id === id);
    if (!entry) return { ok: false, error: `no daemon with id ${id}` };
    await this.restartEntry(entry);
    const updated = listDaemons().find((item) => item.id === id);
    if (!updated) return { ok: false, error: `no daemon with id ${id}` };
    const info = this.infoFor(updated);
    return { ok: true, data: { id, state: info.state, restarted: true, desired_state: "running" } };
  }

  private async restartAll(): Promise<ControlReply<unknown>> {
    const restarted: string[] = [];
    for (const entry of listDaemons()) { await this.restartEntry(entry); restarted.push(entry.id); }
    return { ok: true, data: { restarted } };
  }

  private restartEntry(entry: DaemonEntry): Promise<void> {
    return this.enqueueLifecycle(entry.id, async () => {
      const updated = setDaemonDesiredState(entry.id, "running");
      if (!updated) return;
      const existing = this.children.get(entry.id);
      if (existing) {
        this.cancelRetry(existing);
        this.cancelStabilityReset(existing);
        existing.blocked = false;
        existing.error = undefined;
        await existing.child.stop();
        if (this.children.get(entry.id) === existing) this.children.delete(entry.id);
      }
      if (!this.shuttingDown) this.createSlot(updated);
    });
  }

  private async send(id: string, text: string): Promise<ControlReply<unknown>> {
    const entry = listDaemons().find((item) => item.id === id);
    if (!entry) return { ok: false, error: `no daemon with id ${id}` };
    if (!existsSync(entry.cwd)) {
      return { ok: true, data: { id, accepted: false, delivered: false, code: "cwd_missing", error: "daemon cwd no longer exists" } };
    }
    const info = this.infoFor(entry);
    if (info.desired !== "running" || info.runtime !== "ready") {
      return { ok: true, data: { id, accepted: false, delivered: false, code: "runtime_not_ready", error: `daemon is ${info.health}` } };
    }
    const slot = this.children.get(id);
    if (!slot) return { ok: true, data: { id, accepted: false, delivered: false, code: "runtime_missing" } };
    const acceptance = await slot.child.sendPrompt(text);
    return { ok: true, data: {
      id,
      accepted: acceptance.accepted,
      delivered: acceptance.accepted,
      ...(acceptance.code ? { code: acceptance.code } : {}),
      ...(acceptance.error ? { error: acceptance.error } : {}),
    } };
  }

  private async register(cwd: string): Promise<ControlReply<unknown>> {
    try {
      const entry = addDaemon(cwd);
      await this.startEntry(entry);
      return { ok: true, data: { id: entry.id, cwd: entry.cwd, name: entry.name, desired_state: entry.desired_state } };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  private unregister(id: string): Promise<ControlReply<unknown>> {
    return this.enqueueLifecycle(id, async () => {
      const slot = this.children.get(id);
      if (slot) {
        this.cancelRetry(slot);
        this.cancelStabilityReset(slot);
        await slot.child.stop();
        if (this.children.get(id) === slot) this.children.delete(id);
      }
      try { return { ok: true, data: removeDaemon(id) }; }
      catch (error) { return { ok: false, error: (error as Error).message }; }
    });
  }

  private async unregisterCwd(cwd: string): Promise<ControlReply<unknown>> {
    const entry = findDaemonByCwd(cwd);
    if (!entry) return { ok: true, data: { removed: false } };
    return this.unregister(entry.id);
  }

  private cronAdd(request: Extract<ControlRequest, { op: "cron_add" }>): ControlReply<unknown> {
    const validation = validateSchedule(request.schedule, request.tz);
    if (!validation.ok) return { ok: false, error: validation.error ?? "invalid schedule" };
    const input: NewJobInput = { daemon_id: request.daemon_id, schedule: request.schedule, prompt: request.prompt };
    if (request.tz !== undefined) input.tz = request.tz;
    if (request.skip_if_busy !== undefined) input.skip_if_busy = request.skip_if_busy;
    if (request.catchup !== undefined) input.catchup = request.catchup;
    const job = addCronJob(input);
    this.scheduleCron(job);
    return { ok: true, data: { job: this.jobView(job) } };
  }

  private cronRemove(jobId: string): ControlReply<unknown> {
    const removed = removeCronJob(jobId);
    this.stopCron(jobId);
    return { ok: true, data: { removed } };
  }

  private cronEnable(jobId: string, enabled: boolean): ControlReply<unknown> {
    const updated = setJobEnabled(jobId, enabled);
    if (updated) {
      this.stopCron(jobId);
      const job = getCronJob(jobId);
      if (enabled && job) this.scheduleCron(job);
    }
    return { ok: true, data: { job_id: jobId, enabled, updated } };
  }

  private async cronRun(jobId: string): Promise<ControlReply<unknown>> {
    if (!getCronJob(jobId)) return { ok: false, error: `no cron job with id ${jobId}` };
    return { ok: true, data: { job_id: jobId, result: await this.fireJob(jobId, { manual: true }) } };
  }

  private jobView(job: CronJob): CronJobView {
    const next = nextRunFor(job);
    return { ...job, next_run: next?.toISOString() ?? null };
  }

  private reconcileCron(): void {
    for (const cron of this.cronJobs.values()) cron.stop();
    this.cronJobs.clear();
    for (const job of listCronJobs()) if (job.enabled) this.scheduleCron(job);
  }

  private scheduleCron(job: CronJob): void {
    this.stopCron(job.id);
    try {
      const options = job.tz ? { timezone: job.tz, name: job.id } : { name: job.id };
      this.cronJobs.set(job.id, new Cron(job.schedule, options, () => { void this.fireJob(job.id); }));
    } catch (error) {
      process.stderr.write(`[remote-pi-supervisord] cron schedule failed for ${job.id}: ${String(error)}\n`);
    }
  }

  private stopCron(jobId: string): void {
    const cron = this.cronJobs.get(jobId);
    if (cron) { cron.stop(); this.cronJobs.delete(jobId); }
  }

  private runCatchup(): void {
    for (const job of listCronJobs()) {
      if (!job.enabled || !job.catchup) continue;
      try {
        const cron = new Cron(job.schedule, job.tz ? { timezone: job.tz } : {});
        const previous = cron.previousRun();
        cron.stop();
        if (previous && previous.getTime() > (job.last_run ? Date.parse(job.last_run) : 0)) {
          void this.fireJob(job.id, { manual: true });
        }
      } catch { /* schedule was checked when added; corrupt persisted data simply skips */ }
    }
  }

  async fireJob(jobId: string, options: { manual?: boolean } = {}): Promise<CronResult | "missing"> {
    const job = getCronJob(jobId);
    if (!job) return "missing";
    let result: CronResult;
    if (!job.enabled && !options.manual) {
      result = "skipped_disabled";
    } else {
      const entry = listDaemons().find((item) => item.id === job.daemon_id);
      const cwdExists = !!entry && existsSync(entry.cwd);
      const slot = cwdExists && entry ? this.children.get(entry.id) : undefined;
      const info = cwdExists && entry ? this.infoFor(entry) : undefined;
      const busy = !!slot && info?.runtime === "ready" && job.skip_if_busy ? await slot.child.refreshBusy() : false;
      const action = decideFireAction({
        exists: cwdExists,
        desired: entry?.desired_state ?? "stopped",
        runtime: info?.runtime ?? "pending",
        health: info?.health ?? "failed",
        busy,
        skipIfBusy: job.skip_if_busy,
        retrying: info?.retrying ?? false,
      });
      if (action === "send") {
        result = slot && (await slot.child.sendPrompt(job.prompt)).accepted ? "accepted" : "rejected";
      } else {
        result = this.cronResultFor(action);
      }
    }
    const at = new Date().toISOString();
    recordRun(job.id, at, result);
    appendCronLog({ job_id: job.id, daemon_id: job.daemon_id, schedule: job.schedule, result, prompt: job.prompt });
    return result;
  }

  private cronResultFor(action: Exclude<FireAction, "send">): CronResult {
    switch (action) {
      case "skip_busy": return "skipped_busy";
      case "skip_desired_stopped": return "skipped_desired_stopped";
      case "skip_starting": return "skipped_starting";
      case "skip_retrying": return "skipped_retrying";
      case "skip_failed": return "skipped_failed";
      case "skip_blocked": return "skipped_blocked";
      case "skip_missing": return "skipped_missing";
    }
  }

  private spawnDesiredEntries(): void {
    for (const entry of listDaemons()) if (entry.desired_state === "running") this.createSlot(entry);
  }

  private enqueueLifecycle<T>(id: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.lifecycleQueues.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.lifecycleQueues.set(id, current);
    return previous.then(operation).finally(() => {
      release();
      if (this.lifecycleQueues.get(id) === current) this.lifecycleQueues.delete(id);
    });
  }

  private createSlot(entry: DaemonEntry): void {
    const config: LocalConfig = { agent_name: entry.name || defaultAgentName(entry.cwd), auto_start_relay: true };
    const childOptions: RpcChildOptions = { endpointId: entry.id, cwd: entry.cwd, config };
    if (this.opts.piBin) childOptions.piBin = this.opts.piBin;
    const child = this.opts.childFactory?.(childOptions) ?? new RpcChild(childOptions);
    const slot: ChildSlot = {
      entry,
      child,
      restartTimer: null,
      stabilityTimer: null,
      restartAttempt: 0,
      blocked: false,
      missingCwdObservations: 0,
      reconcileInProgress: false,
    };
    this.children.set(entry.id, slot);
    child.on("exit", (event: RpcChildExitEvent) => this.onChildExit(entry.id, slot, event));
    child.on("runtime_ready", () => this.onRuntimeReady(entry.id, slot));
    child.on("runtime_failed", (event: RuntimeFailedEvent) => this.onRuntimeFailed(entry.id, slot, event));
    child.spawn();
  }

  private onRuntimeReady(id: string, slot: ChildSlot): void {
    if (this.children.get(id) !== slot || this.shuttingDown || slot.entry.desired_state !== "running") return;
    if (slot.stabilityTimer) clearTimeout(slot.stabilityTimer);
    slot.stabilityTimer = setTimeout(() => {
      slot.stabilityTimer = null;
      if (this.children.get(id) === slot && slot.child.runtimeState === "ready" && !slot.blocked) slot.restartAttempt = 0;
    }, RESTART_STABILITY_MS);
    slot.stabilityTimer.unref();
  }

  private onRuntimeFailed(id: string, slot: ChildSlot, event: RuntimeFailedEvent): void {
    if (this.children.get(id) !== slot || this.shuttingDown || slot.entry.desired_state === "stopped") return;
    slot.error = { code: event.code, message: event.message, at: Date.now(), retryable: event.retryable, stage: event.stage ?? "runtime" };
    if (!event.retryable) {
      slot.blocked = true;
      this.cancelRetry(slot);
      this.cancelStabilityReset(slot);
      void this.enqueueLifecycle(id, () => this.children.get(id) === slot ? slot.child.stop() : undefined);
      return;
    }
    this.scheduleRetry(slot, "runtime failure");
    void this.enqueueLifecycle(id, () => this.children.get(id) === slot ? slot.child.stop() : undefined);
  }

  private onChildExit(id: string, slot: ChildSlot, event: RpcChildExitEvent): void {
    if (this.children.get(id) !== slot || this.shuttingDown || slot.entry.desired_state === "stopped" || slot.blocked) return;
    this.cancelStabilityReset(slot);
    if (event.code === EXIT_DAEMON_FRESH_SESSION) {
      void this.enqueueLifecycle(id, () => {
        if (this.children.get(id) !== slot || this.shuttingDown || slot.entry.desired_state !== "running" || slot.blocked) return;
        slot.restartAttempt = 0;
        slot.child.noteRestart();
        slot.child.spawn();
      });
      return;
    }
    if (!event.isCrash) return;
    slot.error ??= { code: "child_exited", message: `child exited (${String(event.code ?? event.signal)})`, at: Date.now(), retryable: true, stage: "process" };
    this.scheduleRetry(slot, "child exit");
  }

  private scheduleRetry(slot: ChildSlot, _reason: string): void {
    if (slot.restartTimer || slot.blocked || slot.entry.desired_state !== "running") return;
    if (slot.restartAttempt >= RESTART_BACKOFFS_MS.length) {
      slot.error = { code: "retry_exhausted", message: "transient restart budget exhausted", at: Date.now(), retryable: false, stage: "retry" };
      return;
    }
    const delay = RESTART_BACKOFFS_MS[slot.restartAttempt]!;
    slot.nextRetryAt = Date.now() + delay;
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = null;
      slot.nextRetryAt = undefined;
      void this.enqueueLifecycle(slot.entry.id, () => {
        if (this.children.get(slot.entry.id) !== slot || this.shuttingDown || slot.blocked || slot.entry.desired_state !== "running") return;
        slot.restartAttempt += 1;
        slot.child.noteRestart();
        slot.child.spawn();
      });
    }, delay);
  }

  private cancelRetry(slot: ChildSlot): void {
    if (slot.restartTimer) clearTimeout(slot.restartTimer);
    slot.restartTimer = null;
    slot.nextRetryAt = undefined;
  }

  private cancelStabilityReset(slot: ChildSlot): void {
    if (slot.stabilityTimer) clearTimeout(slot.stabilityTimer);
    slot.stabilityTimer = null;
  }

  private async reconcileRegistryCwds(): Promise<void> {
    if (this.reconcileRunning) return;
    this.reconcileRunning = true;
    try {
      for (const entry of listDaemons()) {
        const slot = this.children.get(entry.id);
        if (existsSync(entry.cwd)) {
          if (slot) slot.missingCwdObservations = 0;
          continue;
        }
        if (!slot) {
          removeDaemon(entry.id);
          continue;
        }
        slot.missingCwdObservations += 1;
        if (slot.missingCwdObservations < MISSING_CWD_CONFIRMATIONS || slot.reconcileInProgress) continue;
        slot.reconcileInProgress = true;
        this.cancelRetry(slot);
        await this.enqueueLifecycle(entry.id, async () => {
          if (this.children.get(entry.id) !== slot) return;
          await slot.child.stop();
          if (this.children.get(entry.id) === slot) this.children.delete(entry.id);
          removeDaemon(entry.id);
        });
      }
    } finally {
      this.reconcileRunning = false;
    }
  }
}

export function getSupervisorSockPath(): string { return supervisorSockPath(); }
