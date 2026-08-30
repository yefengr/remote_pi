import { afterEach, describe, expect, test, vi } from "vitest";
import type { RemoteCommandDependencies } from "./commands.js";

const callSupervisor = vi.fn().mockResolvedValue({ daemons: [] });
vi.mock("./client.js", () => ({
  callSupervisor,
  supervisorOnline: vi.fn().mockResolvedValue(true),
  SupervisorOfflineError: class SupervisorOfflineError extends Error {},
}));

const { runDirectCli } = await import("./commands.js");
const originalArgv = [...process.argv];

afterEach(() => {
  process.argv = [...originalArgv];
  callSupervisor.mockClear();
  vi.restoreAllMocks();
});

describe("direct daemon CLI", () => {
  test("dispatches daemon status to the supervisor list operation", async () => {
    process.argv = [process.execPath, "remote-pi", "daemon", "status"];
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    runDirectCli({} as RemoteCommandDependencies, true);

    await vi.waitFor(() => expect(callSupervisor).toHaveBeenCalledWith({ op: "list" }));
  });
});
