import { createServer } from "node:http";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import WebSocket from "ws";
import * as ed from "@noble/ed25519";

ed.hashes.sha512 = (...messages) => {
  const hash = createHash("sha512");
  for (const message of messages) hash.update(message);
  return new Uint8Array(hash.digest());
};

const ownerName = process.env.OWNER_NAME || "owner";
const port = Number(process.env.OWNER_PORT || "8788");
const relayUrl = process.env.RELAY_URL || "ws://relay:3000";
const stateDir = process.env.OWNER_STATE_DIR || "/var/lib/remote-pi-owner";
const identityPath = `${stateDir}/identity.json`;
const controlCapabilityPath = `${stateDir}/control-capability`;

let secretKey;
let ownerId;
let ws = null;
let connected = false;
let awaitingConfirmation = false;
let endpoint = null;
let subscribedDeviceId = null;
let endpointEvents = [];
let frames = [];
let waiters = [];
let sequence = 0;
let controlCapability;

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function opaqueId(value) {
  return typeof value === "string" ? fingerprint(value) : null;
}

function nextSequence() {
  sequence += 1;
  return sequence;
}

function record(event, eventSequence = nextSequence()) {
  const safe = {
    sequence: eventSequence,
    at: Date.now(),
    kind: event.kind,
    type: event.type,
    id: event.id,
    in_reply_to: event.in_reply_to,
    reason: event.reason,
    code: event.code,
    endpoint_id: event.endpoint_id,
    runtime_instance_id: event.runtime_instance_id,
    device_fingerprint: opaqueId(event.device_id),
    source_fingerprint: opaqueId(event.source_owner_id),
    target_fingerprint: opaqueId(event.target_owner_id),
    history_generation: event.history_generation,
  };
  frames = [...frames.slice(-199), safe];
  for (const waiter of waiters.splice(0)) waiter();
}

function awaitEvent(predicate, timeoutMs = 5000) {
  if (frames.some(predicate)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    waiters.push(() => {
      clearTimeout(timer);
      resolve(frames.some(predicate));
    });
  });
}

async function loadIdentity() {
  await mkdir(stateDir, { recursive: true });
  try {
    const parsed = JSON.parse(await readFile(identityPath, "utf8"));
    if (typeof parsed.secretKey === "string") {
      secretKey = Buffer.from(parsed.secretKey, "base64");
      ownerId = Buffer.from(ed.getPublicKey(secretKey)).toString("base64");
      return;
    }
  } catch { /* persistent identity is created below */ }
  secretKey = new Uint8Array(createHash("sha256").update(`${ownerName}:${randomUUID()}`).digest());
  ownerId = Buffer.from(ed.getPublicKey(secretKey)).toString("base64");
  await writeFile(identityPath, JSON.stringify({ secretKey: Buffer.from(secretKey).toString("base64") }), { mode: 0o600 });
}

async function loadControlCapability() {
  try {
    const value = (await readFile(controlCapabilityPath, "utf8")).trim();
    if (value) {
      await chmod(controlCapabilityPath, 0o600);
      return value;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const value = randomBytes(32).toString("base64url");
  await writeFile(controlCapabilityPath, `${value}\n`, { mode: 0o600 });
  await chmod(controlCapabilityPath, 0o600);
  return value;
}

function hasControlCapability(value) {
  if (typeof value !== "string" || !controlCapability) return false;
  const received = Buffer.from(value);
  const expected = Buffer.from(controlCapability);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function requiresControlCapability(req) {
  return (req.method === "GET" && req.url === "/private/id") || req.method === "POST";
}

function send(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("owner relay connection is unavailable");
  ws.send(JSON.stringify(payload));
}

function sendRoute(purpose, target, frame) {
  if (!endpoint) throw new Error("no discovered endpoint");
  const ct = Buffer.from(JSON.stringify(frame)).toString("base64");
  send({
    type: "route",
    purpose,
    device_id: endpoint.device_id,
    endpoint_id: endpoint.endpoint_id,
    runtime_instance_id: endpoint.runtime_instance_id,
    ...(target ? { target_owner_id: target } : {}),
    ct,
  });
}

function decodeRoute(outer) {
  try {
    const frame = JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8"));
    record({ ...outer, ...frame, history_generation: frame.history_generation, kind: "frame" });
    return frame;
  } catch {
    record({ ...outer, kind: "invalid_route" });
    return null;
  }
}

function onMessage(raw) {
  let message;
  try { message = JSON.parse(raw.toString()); } catch { return; }
  if (message.type === "challenge") {
    const nonce = Buffer.from(message.nonce, "base64");
    awaitingConfirmation = true;
    connected = false;
    ws.send(JSON.stringify({ type: "auth", sig: Buffer.from(ed.sign(nonce, secretKey)).toString("base64") }));
    send({ type: "subscribe_endpoints", device_ids: subscribedDeviceId ? [subscribedDeviceId] : [] });
    return;
  }
  if (message.type === "endpoints") {
    const item = Array.isArray(message.endpoints) ? message.endpoints[0] : null;
    if (item) endpoint = { device_id: message.device_id, ...item };
    awaitingConfirmation = false;
    connected = true;
    record({ ...message, kind: "endpoints", endpoint_id: item?.endpoint_id, runtime_instance_id: item?.runtime_instance_id });
    return;
  }
  if (message.type === "endpoint_announced" || message.type === "endpoint_updated") {
    endpoint = { device_id: message.device_id, endpoint_id: message.endpoint_id, runtime_instance_id: message.runtime_instance_id, metadata: message.metadata };
    const eventSequence = nextSequence();
    endpointEvents = [...endpointEvents.slice(-99), { sequence: eventSequence, type: message.type, endpoint_id: message.endpoint_id, runtime_instance_id: message.runtime_instance_id, device_fingerprint: fingerprint(message.device_id) }];
    record({ ...message, kind: "endpoint" }, eventSequence);
    return;
  }
  if (message.type === "endpoint_ended") {
    const eventSequence = nextSequence();
    endpointEvents = [...endpointEvents.slice(-99), { sequence: eventSequence, type: message.type, endpoint_id: message.endpoint_id, runtime_instance_id: message.runtime_instance_id, device_fingerprint: fingerprint(message.device_id) }];
    record({ ...message, kind: "endpoint" }, eventSequence);
    // Retain the last endpoint tuple only for the verify harness to prove the
    // Relay rejects a post-revoke route; it is never treated as discoverable.
    return;
  }
  if (message.type === "route") decodeRoute(message);
}

function connect() {
  connected = false;
  awaitingConfirmation = false;
  ws = new WebSocket(relayUrl);
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "hello", protocol_version: 2, role: "owner", pubkey: ownerId }));
  });
  ws.on("message", onMessage);
  ws.on("close", () => {
    connected = false;
    awaitingConfirmation = false;
    setTimeout(connect, 500).unref();
  });
  ws.on("error", () => {
    connected = false;
    awaitingConfirmation = false;
  });

}

async function json(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function publicState() {
  return {
    owner: ownerName,
    ready: connected,
    owner_fingerprint: fingerprint(ownerId),
    endpoint: endpoint ? { endpoint_id: endpoint.endpoint_id, runtime_instance_id: endpoint.runtime_instance_id, device_fingerprint: fingerprint(endpoint.device_id) } : null,
    endpoint_events: endpointEvents,
    sequence,
    frames,
  };
}

async function handler(req, res) {
  try {
    if (req.method === "GET" && req.url === "/health") return respond(res, 200, { ok: true, ready: connected });
    if (req.method === "GET" && req.url === "/state") return respond(res, 200, publicState());
    if (requiresControlCapability(req) && !hasControlCapability(req.headers["x-e2e-control-capability"])) return respond(res, 403, { ok: false });
    if (req.method === "GET" && req.url === "/private/id") return respond(res, 200, { owner_id: ownerId });
    const body = await json(req);
    if (req.method === "POST" && req.url === "/subscribe") {
      if (typeof body.device_id !== "string") return respond(res, 400, { ok: false });
      subscribedDeviceId = body.device_id;
      send({ type: "subscribe_endpoints", device_ids: [body.device_id] });
      return respond(res, 202, { ok: true });
    }
    if (req.method === "POST" && req.url === "/endpoint") {
      if (typeof body.device_id !== "string" || typeof body.endpoint_id !== "string" || typeof body.runtime_instance_id !== "string") return respond(res, 400, { ok: false });
      endpoint = { device_id: body.device_id, endpoint_id: body.endpoint_id, runtime_instance_id: body.runtime_instance_id };
      return respond(res, 202, { ok: true });
    }
    if (req.method === "POST" && req.url === "/pair") {
      if (body.endpoint && typeof body.endpoint === "object") endpoint = body.endpoint;
      const id = typeof body.request_id === "string" ? body.request_id : `pair-${randomUUID()}`;
      sendRoute("pairing", null, { protocol_version: 2, type: "pair_request", id, token: body.token, device_name: ownerName });
      return respond(res, 202, { ok: true, request_id: id });
    }
    if (req.method === "POST" && req.url === "/frame") {
      const frame = body.frame;
      if (!frame || typeof frame !== "object" || typeof frame.type !== "string") return respond(res, 400, { ok: false });
      sendRoute(frame.type === "pair_request" ? "pairing" : "session", null, frame);
      return respond(res, 202, { ok: true });
    }
    return respond(res, 404, { ok: false });
  } catch (error) {
    return respond(res, 409, { ok: false, error: String(error) });
  }
}

function respond(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

await loadIdentity();
controlCapability = await loadControlCapability();
connect();
createServer((req, res) => void handler(req, res)).listen(port, "0.0.0.0");
