import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RemoteCommandDependencies } from "./commands.js";

const peers = vi.hoisted(() => [] as { name: string; remote_epk: string; paired_at: string }[]);
const removePeer = vi.hoisted(() => vi.fn(async (ownerId: string) => {
  const index = peers.findIndex((peer) => peer.remote_epk === ownerId);
  if (index < 0) return false;
  peers.splice(index, 1);
  return true;
}));
vi.mock("../pairing/storage.js", () => ({
  addPeer: vi.fn(),
  listPeers: vi.fn(() => Promise.resolve([...peers])),
  removePeer,
}));

const callSupervisor = vi.fn().mockResolvedValue({ daemons: [] });
vi.mock("./client.js", () => ({
  callSupervisor,
  supervisorOnline: vi.fn().mockResolvedValue(true),
  SupervisorOfflineError: class SupervisorOfflineError extends Error {},
}));

const { registerCommands, runDirectCli } = await import("./commands.js");
const originalArgv = [...process.argv];

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

function commandContext() {
  return { cwd: "/tmp/remote-pi-command-test", ui: { notify: vi.fn() } };
}

function registerPair(deps: RemoteCommandDependencies): { handler: CommandHandler; revokeHandler: CommandHandler; sent: unknown[] } {
  const commands = new Map<string, CommandHandler>();
  const sent: unknown[] = [];
  const pi = {
    registerCommand: vi.fn((name: string, definition: { handler: CommandHandler }) => commands.set(name, definition.handler)),
    sendMessage: vi.fn((message: unknown) => sent.push(message)),
  } as unknown as ExtensionAPI;
  const boundDeps = { ...deps, piApi: () => pi };
  registerCommands(pi, boundDeps);
  return { handler: commands.get("remote-pi pair")!, revokeHandler: commands.get("remote-pi revoke")!, sent };
}

function dependencies(overrides: Partial<RemoteCommandDependencies> = {}): RemoteCommandDependencies {
  return {
    start: vi.fn().mockResolvedValue("completed"),
    waitForInitialRelay: vi.fn().mockResolvedValue("completed"),
    stop: vi.fn(),
    state: vi.fn(() => "started"),
    relayStatus: vi.fn(() => "connected"),
    relayUrl: vi.fn(() => "https://relay.example.test"),
    endpointIdentity: vi.fn(() => ({ endpointId: "11f4842b-726f-4c2d-8c86-c66ddf1f1d7a", runtimeInstanceId: "42f4842b-726f-4c2d-8c86-c66ddf1f1d7a" })),
    activeOwnerCount: vi.fn(() => 0),
    isOwnerActive: vi.fn(() => false),
    closeOwner: vi.fn(),
    updateEndpoint: vi.fn().mockResolvedValue(undefined),
    displayName: vi.fn(() => "Local Pi"),
    keypair: vi.fn(() => ({ publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(64).fill(2) })),
    hasRelay: vi.fn(() => true),
    piApi: vi.fn(() => null),
    setCommandContext: vi.fn(),
    runInternalSessionNew: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

afterEach(() => {
  peers.length = 0;
  removePeer.mockClear();
  process.argv = [...originalArgv];
  callSupervisor.mockClear();
  vi.restoreAllMocks();
});

describe("pair command", () => {
  test("reports reconnecting without generating a QR", async () => {
    const deps = dependencies({ hasRelay: vi.fn(() => false), relayStatus: vi.fn(() => "reconnecting") });
    const { handler, sent } = registerPair(deps);
    const ctx = commandContext();

    await handler("", ctx as unknown as ExtensionCommandContext);

    expect(deps.waitForInitialRelay).toHaveBeenCalledOnce();
    expect(sent).toEqual([]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("[remote-pi] Pair requires a Relay connection; current state: reconnecting.", "warning");
  });

  test("reports unavailable device identity without a Relay-only error", async () => {
    const deps = dependencies({ state: vi.fn(() => "idle"), keypair: vi.fn(() => null), hasRelay: vi.fn(() => false) });
    const { handler, sent } = registerPair(deps);
    const ctx = commandContext();

    await handler("", ctx as unknown as ExtensionCommandContext);

    expect(deps.start).toHaveBeenCalledOnce();
    expect(sent).toEqual([]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("[remote-pi] Pair requires an available device identity.", "warning");
  });

  test("reports the current Relay status when the initial attempt is cancelled", async () => {
    const deps = dependencies({ waitForInitialRelay: vi.fn().mockResolvedValue("cancelled"), keypair: vi.fn(() => null), relayStatus: vi.fn(() => "disconnected") });
    const { handler, sent } = registerPair(deps);
    const ctx = commandContext();

    await handler("", ctx as unknown as ExtensionCommandContext);

    expect(sent).toEqual([]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("[remote-pi] Pair requires a Relay connection; current state: disconnected.", "warning");
  });
});

describe("revoke command", () => {
  test("closes the target before updating Relay ACL", async () => {
    const ownerId = Buffer.alloc(32, 7).toString("base64");
    peers.push({ name: "Owner B", remote_epk: ownerId, paired_at: "now" });
    const calls: string[] = [];
    const deps = dependencies({
      closeOwner: vi.fn(() => { calls.push("closeOwner"); }),
      updateEndpoint: vi.fn(async () => { calls.push("updateEndpoint"); }),
    });
    const { revokeHandler } = registerPair(deps);

    await revokeHandler(ownerId.slice(0, 8), commandContext() as unknown as ExtensionCommandContext);

    expect(removePeer).toHaveBeenCalledWith(ownerId);
    expect(deps.closeOwner).toHaveBeenCalledWith(ownerId, "peer_stop");
    expect(removePeer.mock.invocationCallOrder[0]).toBeLessThan((deps.closeOwner as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!);
    expect(calls).toEqual(["closeOwner", "updateEndpoint"]);
  });

  test("updates Relay ACL when the revoked Owner has no active binding", async () => {
    const ownerId = Buffer.alloc(32, 7).toString("base64");
    peers.push({ name: "Offline Owner", remote_epk: ownerId, paired_at: "now" });
    const deps = dependencies();
    const { revokeHandler } = registerPair(deps);

    await revokeHandler(ownerId.slice(0, 8), commandContext() as unknown as ExtensionCommandContext);

    expect(deps.closeOwner).toHaveBeenCalledWith(ownerId, "peer_stop");
    expect(deps.updateEndpoint).toHaveBeenCalledOnce();
  });
});

describe("direct daemon CLI", () => {
  test("dispatches daemon status to the supervisor list operation", async () => {
    process.argv = [process.execPath, "remote-pi", "daemon", "status"];
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    runDirectCli({} as RemoteCommandDependencies, true);

    await vi.waitFor(() => expect(callSupervisor).toHaveBeenCalledWith({ op: "list" }));
  });
});
