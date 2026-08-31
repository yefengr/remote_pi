import assert from "node:assert/strict";
import { test } from "node:test";
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

  await assert.rejects(client.connect(), /factory failed/);
  assert.equal(client.state, "closed");
  assert.equal(client.sendControl({ type: "subscribe_endpoints", device_ids: [] }), false);
});

test("closes with an application code and a UTF-8 byte-limited reason on invalid challenge", async () => {
  const socket = new FakeWebSocket();
  const client = await createClient(socket);
  const connection = client.connect();
  socket.open();
  socket.message(JSON.stringify({ type: "unexpected" }));
  await assert.rejects(connection, /Expected Relay challenge/);
  assert.equal(client.state, "closed");
  assert.equal(socket.closeCalls[0]?.code, 4002);
  assert.ok((socket.closeCalls[0]?.reason ? new TextEncoder().encode(socket.closeCalls[0].reason).length : 0) <= 123);
});

test("cleans up when hello send fails", async () => {
  const socket = new FakeWebSocket();
  socket.throwOnSend = true;
  const client = await createClient(socket);
  const connection = client.connect();
  socket.open();
  await assert.rejects(connection, /send failed/);
  assert.equal(client.state, "closed");
  assert.equal(socket.closeCalls[0]?.code, 4002);
  assert.equal(client.sendControl({ type: "subscribe_endpoints", device_ids: [] }), false);
});

test("cleans up when an unauthenticated socket errors", async () => {
  const socket = new FakeWebSocket();
  const client = await createClient(socket);
  const connection = client.connect();
  socket.error();
  await assert.rejects(connection, /Relay WebSocket error/);
  assert.equal(client.state, "closed");
  assert.equal(socket.closeCalls[0]?.code, 4002);
});

test("does not mark authentication complete when auth send fails", async () => {
  const socket = new FakeWebSocket();
  const client = await createClient(socket);
  const connection = client.connect();
  socket.open();
  socket.throwOnSend = true;
  socket.message(challenge());
  await assert.rejects(connection, /send failed/);
  assert.equal(client.state, "closed");
  assert.equal(socket.closeCalls[0]?.code, 4002);
});

test("truncates a multibyte close reason without splitting UTF-8", async () => {
  const socket = new FakeWebSocket();
  const client = await createClient(socket);
  client.connect().catch(() => {});
  client.close(1002, "界".repeat(100));
  const reason = socket.closeCalls[0]?.reason ?? "";
  assert.ok(new TextEncoder().encode(reason).length <= 123);
  assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(encodeUtf8(reason)));
  assert.notEqual(socket.closeCalls[0]?.code, 1002);
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

  assert.equal(client.state, "open");
  assert.equal(client.sendControl({ type: "subscribe_endpoints", device_ids: ["device"] }), true);
  assert.equal(first.sent.filter((frame) => frame.includes("subscribe_endpoints")).length, 0);
});
