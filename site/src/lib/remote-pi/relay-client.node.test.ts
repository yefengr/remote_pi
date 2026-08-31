import { expect, test } from "vitest";
import { generateOwnerKeyPair } from "./crypto";
import { encodeBase64, encodeUtf8 } from "./encoding";
import { RelayClient, type WebSocketLike } from "./relay-client";

class FakeWebSocket implements WebSocketLike {
  readonly readyState = 1;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  throwOnSend = false;
  throwOnClose = false;

  send(data: string): void {
    if (this.throwOnSend) throw new Error("send failed");
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.throwOnClose) throw new Error("close failed");
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  message(data: string): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  error(): void {
    this.onerror?.(new Event("error"));
  }
}

async function createClient(socket: FakeWebSocket): Promise<RelayClient> {
  const identity = await generateOwnerKeyPair();
  return new RelayClient({
    relayUrl: "https://relay.example.test",
    identity,
    webSocketFactory: () => socket,
  });
}

function challenge(): string {
  return JSON.stringify({ type: "challenge", nonce: encodeBase64(new Uint8Array(32)) });
}

test("cleans up when the WebSocket factory throws synchronously", async () => {
  const identity = await generateOwnerKeyPair();
  const client = new RelayClient({
    relayUrl: "https://relay.example.test",
    identity,
    webSocketFactory: () => { throw new Error("factory failed"); },
  });

  await expect(client.connect()).rejects.toThrow(/factory failed/);
  expect(client.state).toBe("closed");
  expect(client.sendControl({ type: "subscribe_endpoints", device_ids: [] })).toBe(false);
});

test("closes with an application code and a UTF-8 byte-limited reason on invalid challenge", async () => {
  const socket = new FakeWebSocket();
  const client = await createClient(socket);
  const connection = client.connect();
  socket.open();
  socket.message(JSON.stringify({ type: "unexpected" }));
  await expect(connection).rejects.toThrow(/Expected Relay challenge/);
  expect(client.state).toBe("closed");
  expect(socket.closeCalls[0]?.code).toBe(4002);
  expect((socket.closeCalls[0]?.reason ? new TextEncoder().encode(socket.closeCalls[0].reason).length : 0) <= 123).toBe(true);
});

test("cleans up when hello send fails", async () => {
  const socket = new FakeWebSocket();
  socket.throwOnSend = true;
  const client = await createClient(socket);
  const connection = client.connect();
  socket.open();
  await expect(connection).rejects.toThrow(/send failed/);
  expect(client.state).toBe("closed");
  expect(socket.closeCalls[0]?.code).toBe(4002);
  expect(client.sendControl({ type: "subscribe_endpoints", device_ids: [] })).toBe(false);
});

test("cleans up when an unauthenticated socket errors", async () => {
  const socket = new FakeWebSocket();
  const client = await createClient(socket);
  const connection = client.connect();
  socket.error();
  await expect(connection).rejects.toThrow(/Relay WebSocket error/);
  expect(client.state).toBe("closed");
  expect(socket.closeCalls[0]?.code).toBe(4002);
});

test("does not mark authentication complete when auth send fails", async () => {
  const socket = new FakeWebSocket();
  const client = await createClient(socket);
  const connection = client.connect();
  socket.open();
  socket.throwOnSend = true;
  socket.message(challenge());
  await expect(connection).rejects.toThrow(/send failed/);
  expect(client.state).toBe("closed");
  expect(socket.closeCalls[0]?.code).toBe(4002);
});

test("truncates a multibyte close reason without splitting UTF-8", async () => {
  const socket = new FakeWebSocket();
  const client = await createClient(socket);
  client.connect().catch(() => {});
  client.close(1002, "界".repeat(100));
  const reason = socket.closeCalls[0]?.reason ?? "";
  expect(new TextEncoder().encode(reason).length <= 123).toBe(true);
  expect(() => new TextDecoder("utf-8", { fatal: true }).decode(encodeUtf8(reason))).not.toThrow();
  expect(socket.closeCalls[0]?.code).not.toBe(1002);
});

test("ignores delayed callbacks from an old socket after a new connection starts", async () => {
  const first = new FakeWebSocket();
  const second = new FakeWebSocket();
  const identity = await generateOwnerKeyPair();
  const sockets = [first, second];
  const client = new RelayClient({
    relayUrl: "https://relay.example.test",
    identity,
    webSocketFactory: () => sockets.shift() ?? second,
  });
  const firstConnection = client.connect();
  first.open();
  first.message(challenge());
  await firstConnection;

  client.close();
  const secondConnection = client.connect();
  second.open();
  first.error();
  first.onclose?.(new Event("close") as CloseEvent);
  second.message(challenge());
  await secondConnection;

  expect(client.state).toBe("open");
  expect(client.sendControl({ type: "subscribe_endpoints", device_ids: ["device"] })).toBe(true);
  expect(first.sent.filter((frame) => frame.includes("subscribe_endpoints"))).toHaveLength(0);
});
