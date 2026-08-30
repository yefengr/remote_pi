import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Every result documents a gate decision or the RPC acceptance outcome. */
export type CronResult =
  | "accepted"
  | "rejected"
  | "skipped_busy"
  | "skipped_disabled"
  | "skipped_missing"
  | "skipped_desired_stopped"
  | "skipped_starting"
  | "skipped_retrying"
  | "skipped_failed"
  | "skipped_blocked";

export interface CronLogEntry {
  ts: number;
  job_id: string;
  daemon_id: string;
  schedule: string;
  fired: boolean;
  result: CronResult;
  prompt_preview: string;
}

const PREVIEW_LEN = 80;

function logPath(): string {
  const root = process.env["REMOTE_PI_HOME"] || homedir();
  return join(root, ".pi", "remote", "cron.jsonl");
}

export function cronLogPath(): string { return logPath(); }
export function firedFor(result: CronResult): boolean { return result === "accepted"; }

export function appendCronLog(entry: {
  job_id: string;
  daemon_id: string;
  schedule: string;
  result: CronResult;
  prompt: string;
}): void {
  const line = JSON.stringify({
    ts: Date.now(),
    job_id: entry.job_id,
    daemon_id: entry.daemon_id,
    schedule: entry.schedule,
    fired: firedFor(entry.result),
    result: entry.result,
    prompt_preview: entry.prompt.slice(0, PREVIEW_LEN),
  } satisfies CronLogEntry) + "\n";
  try {
    mkdirSync(dirname(logPath()), { recursive: true });
    appendFileSync(logPath(), line, "utf8");
  } catch {
    // Auditing must not turn an already-completed scheduler decision into a retry.
  }
}

export function readCronLog(opts: { jobId?: string; tail?: number } = {}): CronLogEntry[] {
  if (!existsSync(logPath())) return [];
  let raw: string;
  try { raw = readFileSync(logPath(), "utf8"); } catch { return []; }
  const entries: CronLogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as CronLogEntry;
      if (opts.jobId && entry.job_id !== opts.jobId) continue;
      entries.push(entry);
    } catch {
      // Skip malformed historical lines.
    }
  }
  return opts.tail !== undefined && opts.tail >= 0 && entries.length > opts.tail
    ? entries.slice(entries.length - opts.tail)
    : entries;
}
