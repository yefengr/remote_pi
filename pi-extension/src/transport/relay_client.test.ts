import { describe, expect, test, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { generateEd25519Keypair } from "../pairing/crypto.js";

const wsRef: { current: MockWS | null } = { current: null };

class MockWS extends EventEmitter {
  static OPEN = 1;
  readyState = MockWS.OPEN;
  readonly sent: string[] = [];

  constructor(_url: string) {
    super();
    wsRef.current = this;
    setTimeout(() => this.emit("open"), 0);
  }

  send(data: string): void { this.sent.push(data); }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  terminate(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

vi.mock("ws", () => ({ default: MockWS }));

const { RelayClient } = await import("./relay_client.js");

function currentWs(): MockWS {
  if (!wsRef.current) throw new Error("no MockWS instance created yet");
  return wsRef.current;
}

function simulateChallenge(ws: MockWS, nonceByte = 0xab): void {
  const nonce = Buffer.alloc(32, nonceByte);
  ws.emit("message", Buffer.from(JSON.stringify({ type: "challenge", nonce: nonce.toString("base64") })));
}

async function connectWithAuth(
  client: InstanceType<typeof RelayClient>,
  options: Parameters<InstanceType<typeof RelayClient>["connect"]>[0] = { role: "owner" },
  nonceByte = 0xab,
): Promise<void> {
  const p = client.connect(options);
  await vi.waitFor(() => expect(currentWs().sent.length).toBeGreaterThan(0));
  simulateChallenge(currentWs(), nonceByte);
  await p;
}

const HOST_OPTIONS = {
  role: "host" as const,
  endpointId: "11111111-1111-4111-8111-111111111111",
  runtimeInstanceId: "22222222-2222-4222-8222-222222222222",
  metadata: { kind: "daemon" as const, name: "worker", pid: 42 },
  authorizedOwnerIds: ["AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI="],
};

describe("RelayClient", () => {
  let keypair: ReturnType<typeof generateEd25519Keypair>;

  beforeEach(() => {
    keypair = generateEd25519Keypair();
    wsRef.current = null;
  });

  test("isOpen reflects the real WebSocket lifecycle", async () => {
    const client = new RelayClient("ws://localhost:9999", keypair);
    expect(client.isOpen()).toBe(false);
    await connectWithAuth(client);
    expect(client.isOpen()).toBe(true);
    client.close();
    expect(client.isOpen()).toBe(false);
  });

  test("Host hello carries endpoint identity, metadata, and Owner ACL", async () => {
    const client = new RelayClient("ws://localhost:9999", keypair);
    await connectWithAuth(client, HOST_OPTIONS);
    const hello = JSON.parse(currentWs().sent[0]!) as Record<string, unknown>;
    expect(hello).toEqual(expect.objectContaining({
      type: "hello",
      protocol_version: 2,
      role: "host",
      pubkey: Buffer.from(keypair.publicKey).toString("base64"),
      endpoint_id: HOST_OPTIONS.endpointId,
      runtime_instance_id: HOST_OPTIONS.runtimeInstanceId,
      metadata: HOST_OPTIONS.metadata,
      authorized_owner_ids: HOST_OPTIONS.authorizedOwnerIds,
    }));
    client.close();
  });

  test("Owner hello contains only its authenticated identity", async () => {
    const client = new RelayClient("ws://localhost:9999", keypair);
    await connectWithAuth(client);
    expect(JSON.parse(currentWs().sent[0]!)).toEqual({
      type: "hello",
      protocol_version: 2,
      role: "owner",
      pubkey: Buffer.from(keypair.publicKey).toString("base64"),
    });
    client.close();
  });

  test("connect: sends auth with 64-byte Ed25519 signature", async () => {
    const client = new RelayClient("ws://localhost:9999", keypair);
    await connectWithAuth(client, HOST_OPTIONS);
    const auth = JSON.parse(currentWs().sent[1]!) as { type: string; sig: string };
    expect(auth.type).toBe("auth");
    expect(Buffer.from(auth.sig, "base64")).toHaveLength(64);
    client.close();
  });

  test("connect: challenge is not forwarded but complete route JSON is", async () => {
    const client = new RelayClient("ws://localhost:9999", keypair);
    const received: string[] = [];
    client.on("message", (line) => received.push(line));
    await connectWithAuth(client, HOST_OPTIONS);

    const route = JSON.stringify({
      type: "route",
      purpose: "session",
      device_id: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
      endpoint_id: HOST_OPTIONS.endpointId,
      runtime_instance_id: HOST_OPTIONS.runtimeInstanceId,
      source_owner_id: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
      ct: "AAAA",
    });
    currentWs().emit("message", Buffer.from(route));
    expect(received).toEqual([route]);
    client.close();
  });

  test("send writes raw route JSON to the WebSocket", async () => {
    const client = new RelayClient("ws://localhost:9999", keypair);
    await connectWithAuth(client, HOST_OPTIONS);
    const outer = JSON.stringify({ type: "route", purpose: "session", ct: "BQID" });
    client.send(outer);
    expect(currentWs().sent.at(-1)).toBe(outer);
    client.close();
  });

  async function connectFake(client: InstanceType<typeof RelayClient>): Promise<void> {
    const p = client.connect(HOST_OPTIONS);
    await vi.advanceTimersByTimeAsync(1);
    simulateChallenge(currentWs());
    await p;
  }

  test("liveness force-closes after silence past the timeout", async () => {
    vi.useFakeTimers();
    try {
      const client = new RelayClient("ws://localhost:9999", keypair);
      await connectFake(client);
      let closed = false;
      client.on("close", () => { closed = true; });
      await vi.advanceTimersByTimeAsync(90_000);
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("liveness accepts relay pings", async () => {
    vi.useFakeTimers();
    try {
      const client = new RelayClient("ws://localhost:9999", keypair);
      await connectFake(client);
      let closed = false;
      client.on("close", () => { closed = true; });
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(25_000);
        currentWs().emit("ping");
      }
      expect(closed).toBe(false);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
