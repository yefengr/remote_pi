import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { Cron } from "croner";

export const MIN_INTERVAL_MS = 60_000;

/** A scheduled prompt. Cron never owns a daemon's lifecycle. */
export interface CronJob {
  id: string;
  daemon_id: string;
  schedule: string;
  tz?: string;
  prompt: string;
  enabled: boolean;
  skip_if_busy: boolean;
  catchup: boolean;
  created_at: string;
  last_run?: string;
  last_status?: string;
}

export interface CronRegistry { jobs: CronJob[]; }

function cronPath(): string {
  const root = process.env["REMOTE_PI_HOME"] || homedir();
  return join(root, ".pi", "remote", "cron.json");
}

export function cronRegistryPath(): string { return cronPath(); }

/** Old wake-bearing jobs are intentionally not carried into the new contract. */
export function loadCronRegistry(): CronRegistry {
  if (!existsSync(cronPath())) return { jobs: [] };
  try {
    const parsed = JSON.parse(readFileSync(cronPath(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { jobs?: unknown }).jobs)) return { jobs: [] };
    return { jobs: (parsed as { jobs: unknown[] }).jobs.flatMap((item) => {
      const job = coerceJob(item);
      return job ? [job] : [];
    }) };
  } catch {
    return { jobs: [] };
  }
}

export function saveCronRegistry(registry: CronRegistry): void {
  mkdirSync(dirname(cronPath()), { recursive: true });
  writeFileSync(cronPath(), JSON.stringify(registry, null, 2) + "\n");
}

export function listJobs(): CronJob[] { return loadCronRegistry().jobs; }
export function getJob(id: string): CronJob | undefined { return listJobs().find((job) => job.id === id); }

export interface NewJobInput {
  daemon_id: string;
  schedule: string;
  prompt: string;
  tz?: string;
  skip_if_busy?: boolean;
  catchup?: boolean;
}

export function addJob(input: NewJobInput): CronJob {
  const registry = loadCronRegistry();
  const job: CronJob = {
    id: freshId(registry.jobs),
    daemon_id: input.daemon_id,
    schedule: input.schedule,
    prompt: input.prompt,
    enabled: true,
    skip_if_busy: input.skip_if_busy ?? true,
    catchup: input.catchup ?? false,
    created_at: new Date().toISOString(),
  };
  if (input.tz) job.tz = input.tz;
  registry.jobs.push(job);
  saveCronRegistry(registry);
  return job;
}

export function removeJob(id: string): boolean {
  const registry = loadCronRegistry();
  const index = registry.jobs.findIndex((job) => job.id === id);
  if (index < 0) return false;
  registry.jobs.splice(index, 1);
  saveCronRegistry(registry);
  return true;
}

export function setJobEnabled(id: string, enabled: boolean): boolean {
  const registry = loadCronRegistry();
  const job = registry.jobs.find((item) => item.id === id);
  if (!job) return false;
  job.enabled = enabled;
  saveCronRegistry(registry);
  return true;
}

export function recordRun(id: string, at: string, status: string): void {
  const registry = loadCronRegistry();
  const job = registry.jobs.find((item) => item.id === id);
  if (!job) return;
  job.last_run = at;
  job.last_status = status;
  saveCronRegistry(registry);
}

export interface ScheduleValidation {
  ok: boolean;
  error?: string;
  intervalMs?: number;
}

export function validateSchedule(schedule: string, tz?: string): ScheduleValidation {
  let cron: Cron;
  try { cron = new Cron(schedule, tz ? { timezone: tz } : {}); }
  catch (error) { return { ok: false, error: `invalid cron expression: ${(error as Error).message}` }; }
  try {
    const first = cron.nextRun();
    const second = first ? cron.nextRun(first) : null;
    if (!first || !second) return { ok: false, error: "schedule has no upcoming runs" };
    const intervalMs = second.getTime() - first.getTime();
    if (intervalMs < MIN_INTERVAL_MS) {
      return { ok: false, intervalMs, error: `schedule too frequent: ~${Math.round(intervalMs / 1000)}s between runs (minimum is 60s)` };
    }
    return { ok: true, intervalMs };
  } finally {
    cron.stop();
  }
}

export function nextRunFor(job: CronJob): Date | null {
  try {
    const cron = new Cron(job.schedule, job.tz ? { timezone: job.tz } : {});
    const next = cron.nextRun();
    cron.stop();
    return next;
  } catch {
    return null;
  }
}

function freshId(existing: CronJob[]): string {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const id = `j_${randomBytes(4).toString("hex")}`;
    if (!existing.some((job) => job.id === id)) return id;
  }
  throw new Error("cron id space exhausted");
}

function coerceJob(value: unknown): CronJob | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  // No dual-read/migration of wake: old records are deliberately excluded.
  if (Object.hasOwn(raw, "wake")) return null;
  if (typeof raw["id"] !== "string" || typeof raw["daemon_id"] !== "string" || typeof raw["schedule"] !== "string" || typeof raw["prompt"] !== "string") return null;
  const job: CronJob = {
    id: raw["id"],
    daemon_id: raw["daemon_id"],
    schedule: raw["schedule"],
    prompt: raw["prompt"],
    enabled: raw["enabled"] !== false,
    skip_if_busy: raw["skip_if_busy"] !== false,
    catchup: raw["catchup"] === true,
    created_at: typeof raw["created_at"] === "string" ? raw["created_at"] : new Date(0).toISOString(),
  };
  if (typeof raw["tz"] === "string") job.tz = raw["tz"];
  if (typeof raw["last_run"] === "string") job.last_run = raw["last_run"];
  if (typeof raw["last_status"] === "string") job.last_status = raw["last_status"];
  return job;
}
