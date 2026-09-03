import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import { generateEd25519Keypair } from "../pairing/crypto.js";
import type { HostConnectOptions, RelayClient } from "../transport/relay_client.js";
import { RelayLifecycle, type RelayLifecycleDependencies, type RelayStartContext } from "./relay_lifecycle.js";

const OPTIONS: HostConnectOptions = {
  role: "host",
  endpointId: "endpoint-1",
  runtimeInstanceId: "runtime-1",
  metadata: { kind: "interactive" },
  authorizedOwnerIds: [],
};
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class MockRelay extends EventEmitter {
  private readonly connection = deferred<void>();
  private open = false;
  readonly connect = vi.fn(async (_options: HostConnectOptions) => {
    await this.connection.promise;
    this.open = true;
  });
  readonly close = vi.fn(() => { this.open = false; });
  readonly isOpen = vi.fn(() => this.open);
  complete(): void { this.connection.resolve(); }
  fail(error = new Error("connect failed")): void { this.connection.reject(error); }
}

function setup() {
  const identity = generateEd25519Keypair();
  const notifications: Array<{ message: string; kind?: string }> = [];
  const clients: MockRelay[] = [];
  let identityLoader = () => Promise.resolve(identity);
  let optionsBuilder = () => Promise.resolve(OPTIONS);
  const callbacks = {
    state: vi.fn(),
    connected: vi.fn(),
    disconnected: vi.fn(),
  };
  const deps: RelayLifecycleDependencies = {
    loadIdentity: vi.fn(() => identityLoader()),
    resolveRelayUrl: vi.fn(() => ({ url: "https://relay.example", source: "default" as const })),
    createClient: vi.fn(() => {
      const client = new MockRelay();
      clients.push(client);
      return client as unknown as RelayClient;
    }),
    buildConnectOptions: vi.fn(() => optionsBuilder()),
    handleIdentityError: vi.fn(() => false),
    describeConnection: ({ url }) => `Connecting to ${url}`,
    onStateChange: callbacks.state,
    onConnected: callbacks.connected,
    onDisconnected: callbacks.disconnected,
  };
  const lifecycle = new RelayLifecycle(deps);
  const ctx = {
    cwd: "/workspace",
    ui: { notify: (message: string, kind?: string) => notifications.push({ message, kind }) },
  } as unknown as RelayStartContext;
  return {
    lifecycle,
    ctx,
    clients,
    notifications,
    callbacks,
    deps,
    setIdentityLoader: (loader: typeof identityLoader) => { identityLoader = loader; },
    setOptionsBuilder: (builder: typeof optionsBuilder) => { optionsBuilder = builder; },
  };
}

let activeLifecycle: RelayLifecycle | null = null;
afterEach(() => {
  activeLifecycle?.stop();
  activeLifecycle = null;
  vi.useRealTimers();
});

function trackedSetup() {
  const fixture = setup();
  activeLifecycle = fixture.lifecycle;
  return fixture;
}

describe("RelayLifecycle", () => {
  test("concurrent starts share one initial attempt", async () => {
    const fixture = trackedSetup();
    const identityWait = deferred<ReturnType<typeof generateEd25519Keypair>>();
    fixture.setIdentityLoader(() => identityWait.promise);

    const first = fixture.lifecycle.start(fixture.ctx);
    const second = fixture.lifecycle.start(fixture.ctx);
    expect(second).toBe(first);
    expect(fixture.deps.loadIdentity).toHaveBeenCalledTimes(1);

    identityWait.resolve(generateEd25519Keypair());
    await flush();
    expect(fixture.clients).toHaveLength(1);
    fixture.clients[0]!.complete();
    await expect(first).resolves.toBe("completed");
    expect(fixture.lifecycle.status).toBe("connected");
  });

  test("stop cancels an identity wait without allowing its late result to mutate state", async () => {
    const fixture = trackedSetup();
    const identityWait = deferred<ReturnType<typeof generateEd25519Keypair>>();
    fixture.setIdentityLoader(() => identityWait.promise);

    const attempt = fixture.lifecycle.start(fixture.ctx);
    fixture.lifecycle.stop();
    await expect(attempt).resolves.toBe("cancelled");
    identityWait.resolve(generateEd25519Keypair());
    await flush();

    expect(fixture.lifecycle.state).toBe("idle");
    expect(fixture.clients).toEqual([]);
  });

  test("stop cancels options and connect waits and closes a pending candidate", async () => {
    const fixture = trackedSetup();
    const optionsWait = deferred<HostConnectOptions>();
    fixture.setOptionsBuilder(() => optionsWait.promise);
    const optionsAttempt = fixture.lifecycle.start(fixture.ctx);
    await flush();

    fixture.lifecycle.stop();
    await expect(optionsAttempt).resolves.toBe("cancelled");
    optionsWait.resolve(OPTIONS);
    await flush();
    expect(fixture.clients).toEqual([]);

    const connectAttempt = fixture.lifecycle.start(fixture.ctx);
    fixture.setOptionsBuilder(() => Promise.resolve(OPTIONS));
    await flush();
    expect(fixture.clients).toHaveLength(1);
    const candidate = fixture.clients[0]!;
    fixture.lifecycle.stop();
    await expect(connectAttempt).resolves.toBe("cancelled");
    expect(candidate.close).toHaveBeenCalledOnce();
    candidate.complete();
    await flush();
    expect(candidate.close).toHaveBeenCalledOnce();
    expect(fixture.lifecycle.relay).toBeNull();
  });

  test("a new start wins over a cancelled identity operation that settles late", async () => {
    const fixture = trackedSetup();
    const oldIdentity = deferred<ReturnType<typeof generateEd25519Keypair>>();
    fixture.setIdentityLoader(() => oldIdentity.promise);
    const oldAttempt = fixture.lifecycle.start(fixture.ctx);
    fixture.lifecycle.stop();
    await expect(oldAttempt).resolves.toBe("cancelled");

    fixture.setIdentityLoader(() => Promise.resolve(generateEd25519Keypair()));
    const nextAttempt = fixture.lifecycle.start(fixture.ctx);
    await flush();
    fixture.clients[0]!.complete();
    await expect(nextAttempt).resolves.toBe("completed");
    const active = fixture.lifecycle.relay;

    oldIdentity.resolve(generateEd25519Keypair());
    await flush();
    expect(fixture.lifecycle.relay).toBe(active);
    expect(fixture.clients).toHaveLength(1);
  });

  test("remote close reconnects after backoff and duplicate start reports reconnecting", async () => {
    vi.useFakeTimers();
    const fixture = trackedSetup();
    const firstAttempt = fixture.lifecycle.start(fixture.ctx);
    await flush();
    fixture.clients[0]!.complete();
    await firstAttempt;

    fixture.clients[0]!.emit("close");
    expect(fixture.lifecycle.status).toBe("reconnecting");
    expect(fixture.lifecycle.hasPendingReconnect).toBe(true);
    await fixture.lifecycle.start(fixture.ctx);
    expect(fixture.notifications.at(-1)?.message).toContain("reconnecting in background");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fixture.clients).toHaveLength(2);
    fixture.clients[1]!.complete();
    await flush();
    expect(fixture.lifecycle.status).toBe("connected");
    expect(fixture.callbacks.connected).toHaveBeenCalledTimes(2);
  });

  test("stop during reconnect options wait prevents candidate creation", async () => {
    vi.useFakeTimers();
    const fixture = trackedSetup();
    const firstAttempt = fixture.lifecycle.start(fixture.ctx);
    await flush();
    fixture.clients[0]!.complete();
    await firstAttempt;

    const reconnectOptions = deferred<HostConnectOptions>();
    fixture.setOptionsBuilder(() => reconnectOptions.promise);
    fixture.clients[0]!.emit("close");
    await vi.advanceTimersByTimeAsync(1_000);
    fixture.lifecycle.stop();
    reconnectOptions.resolve(OPTIONS);
    await flush();

    expect(fixture.clients).toHaveLength(1);
    expect(fixture.lifecycle.state).toBe("idle");
    expect(fixture.lifecycle.hasPendingReconnect).toBe(false);
  });

  test("stop during reconnect connect wait closes the candidate and rejects its late success", async () => {
    vi.useFakeTimers();
    const fixture = trackedSetup();
    const firstAttempt = fixture.lifecycle.start(fixture.ctx);
    await flush();
    fixture.clients[0]!.complete();
    await firstAttempt;

    fixture.clients[0]!.emit("close");
    await vi.advanceTimersByTimeAsync(1_000);
    const candidate = fixture.clients[1]!;
    fixture.lifecycle.stop();
    expect(candidate.close).toHaveBeenCalledOnce();
    candidate.complete();
    await flush();

    expect(candidate.close).toHaveBeenCalledOnce();
    expect(fixture.lifecycle.relay).toBeNull();
    expect(fixture.lifecycle.state).toBe("idle");
  });
});
