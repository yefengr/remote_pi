import type {
  DaemonInfo,
  DaemonState,
  DesiredState,
  HealthState,
  ProcessState,
  RelayState,
  RuntimeState,
} from "./control_protocol.js";

export interface DaemonStatusError {
  code: string;
  message?: string;
  at: number;
  stage: string;
}

/**
 * Immutable supervisor data used to derive externally visible daemon status.
 * It intentionally contains no ChildSlot or RpcChild references.
 */
export interface DaemonStatusSnapshot {
  id: string;
  cwd: string;
  name: string;
  registration: "registered" | "missing";
  desired: DesiredState;
  process: ProcessState;
  runtime: RuntimeState;
  relay: RelayState;
  runtimeInstanceId?: string;
  pid?: number;
  startedAt?: number;
  uptimeMs?: number;
  restartCount: number;
  retrying: boolean;
  nextRetryAt?: number;
  blocked: boolean;
  error?: DaemonStatusError;
}

export function healthFor(snapshot: DaemonStatusSnapshot): HealthState {
  if (snapshot.desired === "stopped" && !snapshot.pid) return "stopped";
  if (snapshot.blocked) return "blocked";
  if (snapshot.process === "absent" || snapshot.process === "exited" || snapshot.retrying || snapshot.runtime === "failed") return "failed";
  if (snapshot.runtime !== "ready" || snapshot.process !== "running") return "starting";
  return snapshot.relay === "connected" ? "healthy" : "degraded";
}

export function legacyState(snapshot: Pick<DaemonStatusSnapshot, "desired" | "process" | "runtime">, health: HealthState): DaemonState {
  if (health === "blocked") return "blocked";
  if (snapshot.desired === "stopped" && (snapshot.process === "absent" || snapshot.process === "exited")) return "stopped";
  if (snapshot.process === "spawning" || snapshot.runtime === "pending") return "starting";
  if (snapshot.process === "running") return "running";
  return "crashed";
}

export function startupStage(snapshot: Pick<DaemonStatusSnapshot, "process" | "runtime">): string {
  if (snapshot.process === "spawning") return "spawn";
  if (snapshot.runtime === "pending") return "rpc_readiness";
  if (snapshot.runtime === "ready") return "ready";
  return "unknown";
}

/** Cron has no lifecycle wake path. It may only send or skip. */
export type FireAction = "send" | "skip_busy" | "skip_desired_stopped" | "skip_starting" | "skip_retrying" | "skip_failed" | "skip_blocked" | "skip_missing";

export function decideFireAction(input: {
  exists: boolean;
  desired: DesiredState;
  runtime: RuntimeState;
  health: HealthState;
  busy: boolean;
  skipIfBusy: boolean;
  retrying: boolean;
}): FireAction {
  if (!input.exists) return "skip_missing";
  if (input.desired === "stopped") return "skip_desired_stopped";
  if (input.health === "blocked") return "skip_blocked";
  if (input.retrying) return "skip_retrying";
  if (input.runtime === "failed" || input.health === "failed") return "skip_failed";
  if (input.runtime !== "ready") return "skip_starting";
  if (input.skipIfBusy && input.busy) return "skip_busy";
  return "send";
}

export function infoFor(snapshot: DaemonStatusSnapshot): DaemonInfo {
  const health = healthFor(snapshot);
  const info: DaemonInfo = {
    daemon_id: snapshot.id,
    id: snapshot.id,
    endpoint_id: snapshot.id,
    ...(snapshot.runtimeInstanceId ? { runtime_instance_id: snapshot.runtimeInstanceId } : {}),
    registration: snapshot.registration,
    desired: snapshot.desired,
    process: snapshot.process,
    runtime: snapshot.runtime,
    relay: snapshot.relay,
    relay_state: snapshot.relay,
    health,
    state: legacyState(snapshot, health),
    cwd: snapshot.cwd,
    name: snapshot.name,
    kind: "daemon",
    restart_count: snapshot.restartCount,
    startup_stage: snapshot.error?.stage ?? startupStage(snapshot),
    retrying: snapshot.retrying,
    ...(snapshot.nextRetryAt ? { next_retry_at: snapshot.nextRetryAt } : {}),
    ...(snapshot.error ? {
      last_error_code: snapshot.error.code,
      ...(snapshot.error.message ? { last_error_message: snapshot.error.message } : {}),
      last_error_at: snapshot.error.at,
    } : {}),
  };
  if (snapshot.pid !== undefined) info.pid = snapshot.pid;
  if (snapshot.startedAt !== undefined) info.started_at = snapshot.startedAt;
  if (snapshot.uptimeMs !== undefined) {
    info.uptime = snapshot.uptimeMs;
    info.uptime_s = Math.floor(snapshot.uptimeMs / 1000);
  }
  return info;
}
