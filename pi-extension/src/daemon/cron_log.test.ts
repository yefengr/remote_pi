import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCronLog, firedFor, readCronLog } from "./cron_log.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "pi-cron-log-")); process.env["REMOTE_PI_HOME"] = home; });
afterEach(() => { delete process.env["REMOTE_PI_HOME"]; rmSync(home, { recursive: true, force: true }); });

describe("cron audit", () => {
  test("records accepted RPC dispatch separately from skipped desired state", () => {
    appendCronLog({ job_id: "j", daemon_id: "d", schedule: "* * * * *", result: "accepted", prompt: "hello" });
    appendCronLog({ job_id: "j", daemon_id: "d", schedule: "* * * * *", result: "skipped_desired_stopped", prompt: "hello" });
    expect(readCronLog().map((entry) => [entry.result, entry.fired])).toEqual([
      ["accepted", true],
      ["skipped_desired_stopped", false],
    ]);
  });

  test("filters, tails and truncates preview", () => {
    appendCronLog({ job_id: "j1", daemon_id: "d", schedule: "s", result: "skipped_blocked", prompt: "x".repeat(100) });
    appendCronLog({ job_id: "j2", daemon_id: "d", schedule: "s", result: "rejected", prompt: "p" });
    expect(readCronLog({ jobId: "j1", tail: 1 })[0]).toMatchObject({ result: "skipped_blocked", prompt_preview: "x".repeat(80) });
  });

  test("only accepted RPC responses count as fired", () => {
    expect(firedFor("accepted")).toBe(true);
    expect(firedFor("rejected")).toBe(false);
    expect(firedFor("skipped_retrying")).toBe(false);
  });
});
