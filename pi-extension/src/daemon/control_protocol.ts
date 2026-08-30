import type { CronJob } from "./cron_registry.js";
import type { CronLogEntry } from "./cron_log.js";

/** Legacy CLI summary; new callers should use the orthogonal fields on DaemonInfo. */
export type DaemonState = "stopped" | "starting" | "running" | "crashed" | "blocked";
export type RegistrationState = "registered" | "missing";
export type DesiredState = "running" | "stopped";
export type ProcessState = "absent" | "spawning" | "running" | "exited";
export type RuntimeState = "pending" | "ready" | "failed";
export type RelayState = "disconnected" | "connecting" | "connected" | "reconnecting";
export type HealthState = "stopped" | "starting" | "healthy" | "degraded" | "failed" | "blocked";

/**
 * Status output keeps registration, desired lifecycle, OS process, RPC runtime,
 * relay connectivity and derived health separate. `id` / `state` are retained
 * only for the current CLI consumers while they are migrated.
 */
export interface DaemonInfo {
  daemon_id: string;
  /** Compatibility alias for daemon_id. */
  id: string;
  endpoint_id: string;
  runtime_instance_id?: string;
  registration: RegistrationState;
  desired: DesiredState;
  process: ProcessState;
  runtime: RuntimeState;
  relay: RelayState;
  health: HealthState;
  /** Compatibility summary; never use it to infer health. */
  state: DaemonState;
  cwd: string;
  name: string;
  kind: "daemon";
  pid?: number;
  started_at?: number;
  uptime?: number;
  /** Compatibility alias for uptime (seconds). */
  uptime_s?: number;
  restart_count: number;
  startup_stage: string;
  last_error_code?: string;
  last_error_message?: string;
  last_error_at?: number;
  retrying: boolean;
  next_retry_at?: number;
  /** Compatibility alias for relay. */
  relay_state: RelayState;
}

export type ControlRequest =
  | { op: "list" }
  | { op: "status" }
  | { op: "start_all" }
  | { op: "start"; id: string }
  | { op: "stop_all" }
  | { op: "stop"; id: string }
  | { op: "restart_all" }
  | { op: "restart"; id: string }
  | { op: "send"; id: string; text: string }
  | { op: "register"; cwd: string }
  | { op: "unregister"; id: string }
  | { op: "unregister_cwd"; cwd: string }
  | { op: "cron_add"; daemon_id: string; schedule: string; prompt: string; tz?: string; skip_if_busy?: boolean; catchup?: boolean }
  | { op: "cron_list" }
  | { op: "cron_remove"; job_id: string }
  | { op: "cron_enable"; job_id: string; enabled: boolean }
  | { op: "cron_run"; job_id: string }
  | { op: "cron_log"; job_id?: string; tail?: number };

export type ControlReply<T = unknown> =
  | { ok: true; data?: T }
  | { ok: false; error: string };

export interface ControlReplyShapes {
  list: { daemons: DaemonInfo[] };
  status: { daemons: DaemonInfo[] };
  start_all: { started: string[]; already_running: string[] };
  start: { id: string; state: DaemonState; started: boolean; desired_state: DesiredState };
  stop_all: { stopped: string[]; already_stopped: string[] };
  stop: { id: string; state: DaemonState; stopped: boolean; desired_state: DesiredState };
  restart_all: { restarted: string[] };
  restart: { id: string; state: DaemonState; restarted: boolean; desired_state: DesiredState };
  send: { id: string; accepted: boolean; delivered: boolean; code?: string; error?: string };
  register: { id: string; cwd: string; name: string; desired_state: DesiredState };
  unregister: { removed: boolean; cwd?: string };
  unregister_cwd: { removed: boolean; cwd?: string };
  cron_add: { job: CronJobView };
  cron_list: { jobs: CronJobView[] };
  cron_remove: { removed: boolean };
  cron_enable: { job_id: string; enabled: boolean; updated: boolean };
  cron_run: { job_id: string; result: string };
  cron_log: { entries: CronLogEntry[] };
}

export type CronJobView = CronJob & { next_run?: string | null };
export type ControlReplyFor<Op extends ControlRequest["op"]> =
  Op extends keyof ControlReplyShapes ? ControlReplyShapes[Op] : never;

const TRAILING_NEWLINE = "\n";

export function encodeRequest(req: ControlRequest): string {
  return JSON.stringify(req) + TRAILING_NEWLINE;
}

export function encodeReply<T>(reply: ControlReply<T>): string {
  return JSON.stringify(reply) + TRAILING_NEWLINE;
}

export function parseRequest(line: string): ControlRequest {
  let obj: unknown;
  try { obj = JSON.parse(line); }
  catch (error) { throw new Error(`malformed control request: ${(error as Error).message}`); }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("control request must be a JSON object");
  }
  if (typeof (obj as { op?: unknown }).op !== "string") {
    throw new Error("control request missing string `op` field");
  }
  return obj as ControlRequest;
}

export function parseReply(line: string): ControlReply<unknown> {
  let obj: unknown;
  try { obj = JSON.parse(line); }
  catch (error) { throw new Error(`malformed control reply: ${(error as Error).message}`); }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("control reply must be a JSON object");
  }
  if (typeof (obj as { ok?: unknown }).ok !== "boolean") {
    throw new Error("control reply missing boolean `ok` field");
  }
  return obj as ControlReply<unknown>;
}
