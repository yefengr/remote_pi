import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addJob, cronRegistryPath, getJob, listJobs, loadCronRegistry, nextRunFor, recordRun, saveCronRegistry, validateSchedule } from "./cron_registry.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "pi-cron-v2-")); process.env["REMOTE_PI_HOME"] = home; });
afterEach(() => { delete process.env["REMOTE_PI_HOME"]; rmSync(home, { recursive: true, force: true }); });

describe("wake-free cron registry", () => {
  test("adds only scheduler fields, never a wake lifecycle escape hatch", () => {
    const job = addJob({ daemon_id: "daemon", schedule: "0 9 * * *", prompt: "hi", catchup: true });
    expect(job).toMatchObject({ daemon_id: "daemon", enabled: true, skip_if_busy: true, catchup: true });
    expect("wake" in job).toBe(false);
    expect(JSON.parse(readFileSync(cronRegistryPath(), "utf8")).jobs[0]).not.toHaveProperty("wake");
  });

  test("rejects old persisted wake jobs rather than migrating their behavior", () => {
    saveCronRegistry({ jobs: [
      // @ts-expect-error deliberately old schema
      { id: "j_old", daemon_id: "d", schedule: "0 9 * * *", prompt: "p", enabled: true, skip_if_busy: true, wake: true, catchup: false, created_at: "x" },
    ] });
    expect(loadCronRegistry()).toEqual({ jobs: [] });
  });

  test("records outcomes and calculates next run", () => {
    const job = addJob({ daemon_id: "d", schedule: "0 9 * * *", prompt: "p" });
    recordRun(job.id, "2026-01-01T00:00:00.000Z", "skipped_desired_stopped");
    expect(getJob(job.id)).toMatchObject({ last_status: "skipped_desired_stopped" });
    expect(nextRunFor(job)).toBeInstanceOf(Date);
  });

  test("validates min schedule interval", () => {
    expect(validateSchedule("0 9 * * *").ok).toBe(true);
    expect(validateSchedule("* * * * * *").ok).toBe(false);
  });

  test("missing registry remains empty", () => expect(listJobs()).toEqual([]));
});
