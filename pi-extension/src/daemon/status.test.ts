import { describe, expect, test } from "vitest";
import { infoFor, legacyState } from "./status.js";

describe("legacy daemon state", () => {
  test("reports stopped when desired is stopped and the process is absent or exited", () => {
    expect(legacyState({ desired: "stopped", process: "absent", runtime: "pending" }, "stopped")).toBe("stopped");
    expect(legacyState({ desired: "stopped", process: "exited", runtime: "pending" }, "failed")).toBe("stopped");
  });

  test("preserves independent health fields for a stopped exited process", () => {
    const info = infoFor({
      id: "daemon-1",
      cwd: "/tmp/daemon",
      name: "daemon",
      registration: "registered",
      desired: "stopped",
      process: "exited",
      runtime: "pending",
      relay: "disconnected",
      restartCount: 0,
      retrying: false,
      blocked: false,
    });

    expect(info).toMatchObject({
      desired: "stopped",
      process: "exited",
      runtime: "pending",
      health: "stopped",
      state: "stopped",
    });
  });
});
