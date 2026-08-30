import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { join } from "node:path";
import { Supervisor, decideFireAction, getSupervisorSockPath } from "./supervisor.js";
import type { DaemonPreflightResult } from "./preflight.js";
import { addDaemon, listDaemons, setDaemonDesiredState } from "./registry.js";
import { addJob } from "./cron_registry.js";
import { readCronLog } from "./cron_log.js";
import { encodeRequest, parseReply, type ControlReply, type ControlRequest } from "./control_protocol.js";

let home: string;
let supervisor: Supervisor | null = null;

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
  supervisor = new Supervisor({ extensionPath: "/ignored", piBin: process.execPath, reconcileIntervalMs: 60_000 });
  await supervisor.start();
});
afterEach(async () => {
  await supervisor?.stop();
  supervisor = null;
  delete process.env["REMOTE_PI_HOME"];
  rmSync(home, { recursive: true, force: true });
});

describe("SDK preflight supervisor gate", () => {
  test("blocks a desired-running entry without spawning its Pi child", async () => {
    await supervisor!.stop();
    let preflightCalls = 0;
    const blocked: DaemonPreflightResult = {
      ok: false,
      code: "remote_pi_extension_missing",
      message: "No configured Remote Pi Extension was discovered",
    };
    supervisor = new Supervisor({
      extensionPath: "/ignored",
      piBin: process.execPath,
      reconcileIntervalMs: 60_000,
      preflight: async () => { preflightCalls += 1; return blocked; },
    });
    await supervisor.start();
    const entry = addDaemon(mkdtempSync(join(tmpdir(), "pi-supervisor-preflight-")));
    const start = await ask<ControlReply<{ id: string }>>({ op: "start", id: entry.id });
    expect(start).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const status = await ask<ControlReply<{ daemons: Array<Record<string, unknown>> }>>({ op: "status" });
    const daemon = status.ok ? status.data!.daemons.find((item) => item["daemon_id"] === entry.id) : undefined;
    expect(preflightCalls).toBe(1);
    expect(daemon).toMatchObject({ process: "absent", runtime: "pending", health: "blocked", last_error_code: "remote_pi_extension_missing" });
  });

  test("merges concurrent entry preflights before spawning", async () => {
    await supervisor!.stop();
    let resolvePreflight: ((result: DaemonPreflightResult) => void) | undefined;
    let preflightCalls = 0;
    const pending = new Promise<DaemonPreflightResult>((resolve) => { resolvePreflight = resolve; });
    supervisor = new Supervisor({
      extensionPath: "/ignored",
      piBin: process.execPath,
      reconcileIntervalMs: 60_000,
      preflight: async () => { preflightCalls += 1; return pending; },
    });
    await supervisor.start();
    const entry = addDaemon(mkdtempSync(join(tmpdir(), "pi-supervisor-preflight-merge-")));
    await Promise.all([
      ask({ op: "start", id: entry.id }),
      ask({ op: "start", id: entry.id }),
    ]);
    expect(preflightCalls).toBe(1);
    resolvePreflight!({ ok: false, code: "preflight_failed", message: "test" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

describe("orthogonal daemon lifecycle", () => {
  test("register creates desired-running registration with persistent opaque id", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-supervisor-reg-"));
    const reply = await ask<ControlReply<{ id: string; desired_state: string }>>({ op: "register", cwd });
    expect(reply).toMatchObject({ ok: true, data: { desired_state: "running" } });
    if (reply.ok) expect(reply.data!.id).toMatch(/^[0-9a-f-]{36}$/i);
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
    supervisor = new Supervisor({ extensionPath: "/ignored", piBin: process.execPath, reconcileIntervalMs: 60_000 });
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
