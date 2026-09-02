import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { join } from "node:path";
import { Supervisor, decideFireAction, getSupervisorSockPath } from "./supervisor.js";
import { RpcChild, type RpcChildOptions } from "./rpc_child.js";
import { addDaemon, listDaemons, setDaemonDesiredState } from "./registry.js";
import { addJob } from "./cron_registry.js";
import { readCronLog } from "./cron_log.js";
import { encodeRequest, parseReply, type ControlReply, type ControlRequest } from "./control_protocol.js";

let home: string;
let supervisor: Supervisor | null = null;

type StopGate = { entered: () => void; release: Promise<void> };

class LifecycleChild extends RpcChild {
  processState: "absent" | "spawning" | "running" | "exited" = "absent";
  runtimeState: "pending" | "ready" | "failed" = "pending";
  relayState: "disconnected" | "connecting" | "connected" | "reconnecting" = "disconnected";
  state: "stopped" | "starting" | "running" | "crashed" | "blocked" = "stopped";
  pid: number | undefined;
  startedAt: number | undefined;
  uptimeMs: number | undefined;
  runtimeInstanceId: string | undefined;
  sessionId: string | undefined;
  restartCount = 0;
  private stopGateUsed = false;

  constructor(
    options: RpcChildOptions,
    private readonly events: string[],
    private readonly stopGate?: StopGate,
  ) { super(options); }

  override spawn(): void {
    this.pid = 10_000 + this.events.filter((event) => event.startsWith("spawn:")).length;
    this.startedAt = Date.now();
    this.uptimeMs = 0;
    this.runtimeInstanceId = `runtime-${this.pid}`;
    this.processState = "running";
    this.runtimeState = "pending";
    this.relayState = "connecting";
    this.state = "starting";
    this.events.push(`spawn:${this.pid}`);
  }

  override async stop(): Promise<void> {
    const pid = this.pid;
    if (pid === undefined) return;
    if (this.stopGate && !this.stopGateUsed) {
      this.stopGateUsed = true;
      this.stopGate.entered();
      await this.stopGate.release;
    }
    if (this.pid !== pid) return;
    this.events.push(`stop:${pid}`);
    this.processState = "exited";
    this.runtimeState = "pending";
    this.relayState = "disconnected";
    this.state = "stopped";
    this.pid = undefined;
    this.startedAt = undefined;
    this.uptimeMs = undefined;
  }
}

function queuedLifecycle(supervisor: Supervisor, id: string): Promise<void> | undefined {
  return (supervisor as unknown as { lifecycleQueues: Map<string, Promise<void>> }).lifecycleQueues.get(id);
}

async function waitForQueueChange(supervisor: Supervisor, id: string, previous: Promise<void> | undefined): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (queuedLifecycle(supervisor, id) !== previous) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`lifecycle operation for ${id} was not queued`);
}

function ask<R = ControlReply<unknown>>(request: ControlRequest): Promise<R> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: getSupervisorSockPath() });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      try { resolve(parseReply(buffer.slice(0, newline)) as R); } catch (error) { reject(error); }
    });
    socket.on("error", reject);
    socket.write(encodeRequest(request));
  });
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "pi-supervisor-v2-"));
  process.env["REMOTE_PI_HOME"] = home;
  supervisor = new Supervisor({ piBin: process.execPath, reconcileIntervalMs: 60_000 });
  await supervisor.start();
});
afterEach(async () => {
  await supervisor?.stop();
  supervisor = null;
  delete process.env["REMOTE_PI_HOME"];
  rmSync(home, { recursive: true, force: true });
});

describe("orthogonal daemon lifecycle", () => {
  test("register creates desired-running registration with persistent opaque id", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-supervisor-reg-"));
    const reply = await ask<ControlReply<{ id: string; desired_state: string }>>({ op: "register", cwd });
    expect(reply).toMatchObject({ ok: true, data: { desired_state: "running" } });
    if (reply.ok) expect(reply.data!.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test("serializes concurrent restarts without orphaning an old child", async () => {
    await supervisor!.stop();
    const cwd = mkdtempSync(join(tmpdir(), "pi-supervisor-concurrent-restart-"));
    const entry = addDaemon(cwd);
    const events: string[] = [];
    supervisor = new Supervisor({
      reconcileIntervalMs: 60_000,
      childFactory: (options) => new LifecycleChild(options, events),
    });
    await supervisor.start();

    await Promise.all([
      ask({ op: "restart", id: entry.id }),
      ask({ op: "restart", id: entry.id }),
    ]);
    const status = await ask<ControlReply<{ daemons: Array<Record<string, unknown>> }>>({ op: "status" });
    const daemon = status.ok ? status.data!.daemons.find((item) => item["daemon_id"] === entry.id) : undefined;
    expect(daemon).toMatchObject({ desired: "running", process: "running", runtime: "pending" });
    expect(events).toEqual(["spawn:10000", "stop:10000", "spawn:10001", "stop:10001", "spawn:10002"]);

    await supervisor.stop();
    expect(events).toEqual(["spawn:10000", "stop:10000", "spawn:10001", "stop:10001", "spawn:10002", "stop:10002"]);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("runs a start requested during stop after that stop completes", async () => {
    await supervisor!.stop();
    const cwd = mkdtempSync(join(tmpdir(), "pi-supervisor-concurrent-start-stop-"));
    const entry = addDaemon(cwd);
    const events: string[] = [];
    let signalStopEntered!: () => void;
    let releaseStop!: () => void;
    const stopEntered = new Promise<void>((resolve) => { signalStopEntered = resolve; });
    const stopRelease = new Promise<void>((resolve) => { releaseStop = resolve; });
    supervisor = new Supervisor({
      reconcileIntervalMs: 60_000,
      childFactory: (options) => new LifecycleChild(options, events, { entered: signalStopEntered, release: stopRelease }),
    });
    await supervisor.start();

    const stopping = ask({ op: "stop", id: entry.id });
    await stopEntered;
    const stopQueue = queuedLifecycle(supervisor, entry.id);
    const starting = ask({ op: "start", id: entry.id });
    await waitForQueueChange(supervisor, entry.id, stopQueue);
    releaseStop();
    await Promise.all([stopping, starting]);

    const status = await ask<ControlReply<{ daemons: Array<Record<string, unknown>> }>>({ op: "status" });
    const daemon = status.ok ? status.data!.daemons.find((item) => item["daemon_id"] === entry.id) : undefined;
    expect(daemon).toMatchObject({ desired: "running", process: "running", runtime: "pending" });
    expect(events).toEqual(["spawn:10000", "stop:10000", "spawn:10001"]);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("ignores queued retry and crash callbacks after their slot is replaced", async () => {
    await supervisor!.stop();
    const cwd = mkdtempSync(join(tmpdir(), "pi-supervisor-stale-slot-"));
    const entry = addDaemon(cwd);
    const events: string[] = [];
    const children: LifecycleChild[] = [];
    let signalStopEntered!: () => void;
    let releaseStop!: () => void;
    const stopEntered = new Promise<void>((resolve) => { signalStopEntered = resolve; });
    const stopRelease = new Promise<void>((resolve) => { releaseStop = resolve; });
    supervisor = new Supervisor({
      reconcileIntervalMs: 60_000,
      childFactory: (options) => {
        const child = new LifecycleChild(options, events, children.length === 0 ? { entered: signalStopEntered, release: stopRelease } : undefined);
        children.push(child);
        return child;
      },
    });
    await supervisor.start();
    const oldSlot = (supervisor as unknown as {
      children: Map<string, { restartTimer: ReturnType<typeof setTimeout> | null }>;
    }).children.get(entry.id)!;
    children[0]!.emit("runtime_failed", { stage: "extension", code: "transient_failure", retryable: true });
    expect(oldSlot.restartTimer).not.toBeNull();
    await stopEntered;
    const failureStopQueue = queuedLifecycle(supervisor, entry.id);
    const restarting = ask({ op: "restart", id: entry.id });
    await waitForQueueChange(supervisor, entry.id, failureStopQueue);
    children[0]!.emit("exit", { code: 42, signal: null, isCrash: true });
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    expect(oldSlot.restartTimer).toBeNull();
    releaseStop();
    await restarting;

    children[0]!.emit("runtime_failed", { stage: "extension", code: "stale_failure", retryable: false });
    children[0]!.emit("exit", { code: 1, signal: null, isCrash: true });

    const status = await ask<ControlReply<{ daemons: Array<Record<string, unknown>> }>>({ op: "status" });
    const daemon = status.ok ? status.data!.daemons.find((item) => item["daemon_id"] === entry.id) : undefined;
    expect(daemon).toMatchObject({ desired: "running", process: "running", runtime: "pending" });
    expect(daemon).not.toHaveProperty("last_error_code");
    expect(events).toEqual(["spawn:10000", "stop:10000", "spawn:10001"]);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("ignores a queued cwd reconcile after restart replaces its slot", async () => {
    await supervisor!.stop();
    const cwd = mkdtempSync(join(tmpdir(), "pi-supervisor-stale-reconcile-"));
    const entry = addDaemon(cwd);
    const events: string[] = [];
    let signalStopEntered!: () => void;
    let releaseStop!: () => void;
    const stopEntered = new Promise<void>((resolve) => { signalStopEntered = resolve; });
    const stopRelease = new Promise<void>((resolve) => { releaseStop = resolve; });
    supervisor = new Supervisor({
      reconcileIntervalMs: 60_000,
      childFactory: (options) => new LifecycleChild(options, events, { entered: signalStopEntered, release: stopRelease }),
    });
    await supervisor.start();

    const restarting = ask({ op: "restart", id: entry.id });
    await stopEntered;
    rmSync(cwd, { recursive: true, force: true });
    await ask({ op: "list" });
    const restartQueue = queuedLifecycle(supervisor, entry.id);
    const reconciling = ask({ op: "list" });
    await waitForQueueChange(supervisor, entry.id, restartQueue);
    releaseStop();
    await Promise.all([restarting, reconciling]);

    const status = await ask<ControlReply<{ daemons: Array<Record<string, unknown>> }>>({ op: "status" });
    const daemon = status.ok ? status.data!.daemons.find((item) => item["daemon_id"] === entry.id) : undefined;
    expect(daemon).toMatchObject({ registration: "missing", desired: "running", process: "running" });
    expect(events).toEqual(["spawn:10000", "stop:10000", "spawn:10001"]);
  });

  test("shutdown closes an idle partial control socket without delaying child stop", async () => {
    await supervisor!.stop();
    const cwd = mkdtempSync(join(tmpdir(), "pi-supervisor-idle-socket-shutdown-"));
    const entry = addDaemon(cwd);
    const events: string[] = [];
    supervisor = new Supervisor({
      reconcileIntervalMs: 60_000,
      childFactory: (options) => new LifecycleChild(options, events),
    });
    await supervisor.start();
    const idle = createConnection({ path: getSupervisorSockPath() });
    await new Promise<void>((resolve, reject) => {
      idle.once("connect", resolve);
      idle.once("error", reject);
    });
    const idleClosed = new Promise<void>((resolve) => idle.once("close", () => resolve()));
    idle.write('{"op":"status"');

    await supervisor.stop();
    await idleClosed;

    expect(events).toEqual(["spawn:10000", "stop:10000"]);
    expect(idle.destroyed).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("waits for an active lifecycle operation before supervisor shutdown", async () => {
    await supervisor!.stop();
    const cwd = mkdtempSync(join(tmpdir(), "pi-supervisor-queued-shutdown-"));
    const entry = addDaemon(cwd);
    const events: string[] = [];
    let signalStopEntered!: () => void;
    let releaseStop!: () => void;
    const stopEntered = new Promise<void>((resolve) => { signalStopEntered = resolve; });
    const stopRelease = new Promise<void>((resolve) => { releaseStop = resolve; });
    supervisor = new Supervisor({
      reconcileIntervalMs: 60_000,
      childFactory: (options) => new LifecycleChild(options, events, { entered: signalStopEntered, release: stopRelease }),
    });
    await supervisor.start();

    const stopping = ask({ op: "stop", id: entry.id });
    await stopEntered;
    const stopQueue = queuedLifecycle(supervisor, entry.id);
    const starting = ask({ op: "start", id: entry.id });
    await waitForQueueChange(supervisor, entry.id, stopQueue);
    let shutdownComplete = false;
    const shutdown = supervisor.stop().then(() => { shutdownComplete = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(shutdownComplete).toBe(false);
    releaseStop();
    await Promise.all([stopping, starting, shutdown]);

    expect(listDaemons().find((item) => item.id === entry.id)?.desired_state).toBe("running");
    expect(events).toEqual(["spawn:10000", "stop:10000", "spawn:10001", "stop:10001"]);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("code 42 follows normal crash backoff instead of a fresh-session respawn", async () => {
    await supervisor!.stop();
    const cwd = mkdtempSync(join(tmpdir(), "pi-supervisor-code-42-"));
    const entry = addDaemon(cwd);
    const events: string[] = [];
    const children: LifecycleChild[] = [];
    supervisor = new Supervisor({
      reconcileIntervalMs: 60_000,
      childFactory: (options) => {
        const child = new LifecycleChild(options, events);
        children.push(child);
        return child;
      },
    });
    await supervisor.start();

    children[0]!.emit("exit", { code: 42, signal: null, isCrash: true });
    const slot = (supervisor as unknown as { children: Map<string, { restartTimer: ReturnType<typeof setTimeout> | null }> }).children.get(entry.id)!;
    expect(slot.restartTimer).not.toBeNull();
    expect(events).toEqual(["spawn:10000"]);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("status separates process lifecycle from runtime health", async () => {
    const entry = addDaemon(mkdtempSync(join(tmpdir(), "pi-supervisor-status-")));
    const reply = await ask<ControlReply<{ daemons: Array<Record<string, unknown>> }>>({ op: "status" });
    const daemon = reply.ok ? reply.data!.daemons.find((item) => item["daemon_id"] === entry.id) : undefined;
    expect(daemon).toMatchObject({
      registration: "registered",
      desired: "running",
      process: "absent",
      runtime: "pending",
      health: "failed",
      endpoint_id: entry.id,
      kind: "daemon",
    });
  });

  test("start and stop persist desired state", async () => {
    const entry = addDaemon(mkdtempSync(join(tmpdir(), "pi-supervisor-desired-")));
    const start = await ask<ControlReply<{ desired_state: string }>>({ op: "start", id: entry.id });
    expect(start).toMatchObject({ ok: true, data: { desired_state: "running" } });
    const stop = await ask<ControlReply<{ desired_state: string }>>({ op: "stop", id: entry.id });
    expect(stop).toMatchObject({ ok: true, data: { desired_state: "stopped" } });
    expect(listDaemons().find((item) => item.id === entry.id)?.desired_state).toBe("stopped");
  });

  test("supervisor startup spawns only desired-running registrations", async () => {
    const stopped = addDaemon(mkdtempSync(join(tmpdir(), "pi-supervisor-stopped-")));
    setDaemonDesiredState(stopped.id, "stopped");
    await supervisor!.stop();
    supervisor = new Supervisor({ piBin: process.execPath, reconcileIntervalMs: 60_000 });
    await supervisor.start();
    const reply = await ask<ControlReply<{ daemons: Array<Record<string, unknown>> }>>({ op: "status" });
    const daemon = reply.ok ? reply.data!.daemons.find((item) => item["daemon_id"] === stopped.id) : undefined;
    expect(daemon).toMatchObject({ desired: "stopped", process: "absent", health: "stopped" });
  });

  test("send rejects unready runtime rather than treating stdin write as delivery", async () => {
    const entry = addDaemon(mkdtempSync(join(tmpdir(), "pi-supervisor-send-")));
    const reply = await ask<ControlReply<{ accepted: boolean; code: string }>>({ op: "send", id: entry.id, text: "hello" });
    expect(reply).toMatchObject({ ok: true, data: { accepted: false, code: "runtime_not_ready" } });
  });

  test("removes stale cwd during a control-path reconcile", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-supervisor-stale-"));
    const entry = addDaemon(cwd);
    rmSync(cwd, { recursive: true, force: true });
    await ask({ op: "list" });
    expect(listDaemons().find((item) => item.id === entry.id)).toBeUndefined();
  });
});

describe("cron gate", () => {
  test("has no wake action and gates by desired/readiness/health", () => {
    expect(decideFireAction({ exists: true, desired: "stopped", runtime: "ready", health: "stopped", busy: false, skipIfBusy: true, retrying: false })).toBe("skip_desired_stopped");
    expect(decideFireAction({ exists: true, desired: "running", runtime: "pending", health: "starting", busy: false, skipIfBusy: true, retrying: false })).toBe("skip_starting");
    expect(decideFireAction({ exists: true, desired: "running", runtime: "ready", health: "degraded", busy: false, skipIfBusy: true, retrying: false })).toBe("send");
  });

  test("manual run cannot wake a stopped daemon and records audit", async () => {
    const entry = addDaemon(mkdtempSync(join(tmpdir(), "pi-supervisor-cron-")));
    setDaemonDesiredState(entry.id, "stopped");
    const job = addJob({ daemon_id: entry.id, schedule: "0 9 * * *", prompt: "ping" });
    const reply = await ask<ControlReply<{ result: string }>>({ op: "cron_run", job_id: job.id });
    expect(reply).toMatchObject({ ok: true, data: { result: "skipped_desired_stopped" } });
    expect(readCronLog({ jobId: job.id }).at(-1)).toMatchObject({ result: "skipped_desired_stopped", fired: false });
  });

  test("protocol rejects old wake request at type boundary", () => {
    const req: Extract<ControlRequest, { op: "cron_add" }> = { op: "cron_add", daemon_id: "d", schedule: "0 9 * * *", prompt: "p" };
    expect("wake" in req).toBe(false);
  });
});
