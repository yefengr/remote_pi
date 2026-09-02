import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const home = process.env.HOME || "/home/pi";
const workspace = "/workspace";
const socketPath = `${home}/.pi/remote/e2e-interactive.sock`;
const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR || `${home}/.pi/agent/sessions`;
const controlCapabilityPath = `${home}/.pi/remote/e2e-control-capability`;
const endpointId = process.env.REMOTE_PI_ENDPOINT_ID || "3a4c750b-2ecf-4f3d-9876-1ccf2d631115";
const controlPort = Number(process.env.INTERACTIVE_CONTROL_PORT || "8787");
let child = null;
let pendingRestart = false;
let closing = false;
let state = {
  running: false,
  rpcReady: false,
  runtimeReady: false,
  relay: "disconnected",
  sessionId: null,
  endpointId,
  runtimeId: null,
  deviceId: null,
  pairingToken: null,
  pairingExpiresAt: null,
  lastError: null,
};
let stdoutBuffer = "";
let stderrTail = "";
let controlCapability;

function safeString(value) {
  return typeof value === "string" ? value.slice(0, 512) : undefined;
}

function updateFromLine(line, expectedRuntimeId) {
  let value;
  try { value = JSON.parse(line); } catch { return; }
  if (value?.type === "response" && value.command === "get_state" && value.success === true) {
    state.rpcReady = true;
    if (typeof value.data?.sessionId === "string") state.sessionId = value.data.sessionId;
  }
  const entry = value?.type === "entry_appended" ? value.entry : value?.type === "message_start" ? value.message : null;
  const custom = entry?.details && typeof entry.details === "object" ? entry : null;
  const statusDetails = value?.type === "extension_ui_request" && value.method === "setStatus" && value.statusKey === "remote-pi:control" && typeof value.statusText === "string"
    ? (() => { try { return JSON.parse(value.statusText); } catch { return null; } })() : null;
  const runtime = custom?.customType === "remote-pi:runtime-ready" ? custom.details : statusDetails?.type === "runtime_ready" ? statusDetails : null;
  if (runtime && typeof runtime === "object") {
    const isCurrentRuntime = runtime.control_protocol_version === 2
      && runtime.endpoint_id === endpointId
      && runtime.runtime_instance_id === expectedRuntimeId;
    if (isCurrentRuntime) {
      state.runtimeReady = true;
      state.runtimeId = expectedRuntimeId;
      state.endpointId = endpointId;
      state.sessionId = safeString(runtime.session_id) || state.sessionId;
    }
  }
  if (custom?.customType === "remote-pi:session-changed") {
    state.sessionId = safeString(custom.details.session_id) || state.sessionId;
    state.runtimeId = safeString(custom.details.runtime_instance_id) || state.runtimeId;
  }
  if (custom?.customType === "remote-pi:relay-state") {
    state.relay = safeString(custom.details.state) || state.relay;
  }
  if (custom?.customType === "remote-pi:pair-code") {
    const uri = safeString(custom.details.uri);
    const token = safeString(custom.details.token);
    if (uri && token) {
      try {
        const parsed = new URL(uri);
        const encoded = parsed.searchParams.get("epk");
        if (encoded) {
          const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
          state.deviceId = Buffer.from(base64, "base64").toString("base64");
          state.pairingToken = token;
          state.pairingExpiresAt = typeof custom.details.expiresAt === "number" ? custom.details.expiresAt : null;
          state.endpointId = safeString(custom.details.endpointId) || state.endpointId;
        }
      } catch { /* pairing material remains unavailable until a valid event arrives */ }
    }
  }
  if (statusDetails?.type === "relay_state") {
    state.relay = safeString(statusDetails.state) || state.relay;
  }
  const direct = entry?.customType === "remote-pi:relay-state" ? entry.details : null;
  if (direct && typeof direct === "object") {
    state.relay = safeString(direct.state) || state.relay;
  }
}

function start() {
  if (closing || child) return;
  const runtimeId = randomUUID();
  state = { ...state, running: true, rpcReady: false, runtimeReady: false, relay: "connecting", runtimeId, lastError: null };
  const nextChild = spawn("pi", ["--mode", "rpc", "--approve", "--continue", "--name", "e2e-interactive"], {
    cwd: workspace,
    env: {
      ...process.env,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      REMOTE_PI_ALLOW_FILE_IDENTITY: "1",
      REMOTE_PI_DAEMON: "1",
      REMOTE_PI_ENDPOINT_ID: endpointId,
      REMOTE_PI_RUNTIME_INSTANCE_ID: runtimeId,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child = nextChild;
  let childStdoutBuffer = "";
  nextChild.stdout.on("data", (chunk) => {
    if (child !== nextChild) return;
    childStdoutBuffer += chunk.toString();
    let index;
    while ((index = childStdoutBuffer.indexOf("\n")) >= 0) {
      if (child !== nextChild) return;
      const line = childStdoutBuffer.slice(0, index);
      childStdoutBuffer = childStdoutBuffer.slice(index + 1);
      if (line.trim()) updateFromLine(line, runtimeId);
    }
  });
  nextChild.stderr.on("data", (chunk) => {
    if (child !== nextChild) return;
    stderrTail = (stderrTail + chunk.toString()).slice(-1024);
  });
  nextChild.once("exit", (code, signal) => {
    if (child !== nextChild) return;
    child = null;
    state = { ...state, running: false, rpcReady: false, runtimeReady: false, relay: "disconnected", lastError: code === 0 ? null : `pi exited (${String(code ?? signal)})` };
    const restart = pendingRestart && !closing;
    pendingRestart = false;
    if (restart) start();
  });
  send({ id: `ready-${randomUUID()}`, type: "get_state" });
}

function send(frame) {
  if (!child?.stdin?.writable) throw new Error("interactive Pi is not running");
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

function stop(reason = "shutdown") {
  if (!child) return;
  if (reason === "peer_stop") send({ id: `stop-${randomUUID()}`, type: "prompt", message: "\u0000remote-pi-ctrl:relay:off" });
  else if (reason === "shutdown") child.kill("SIGTERM");
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

function response(socket, status, payload) {
  const body = JSON.stringify(payload);
  socket.end(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

function parseRequest(data) {
  const [head, body = ""] = data.split("\r\n\r\n");
  const [method = "", path = ""] = head.split("\r\n")[0]?.split(" ") || [];
  let json = {};
  try { json = body ? JSON.parse(body) : {}; } catch { json = {}; }
  return { method, path, json };
}

await mkdir(`${home}/.pi/remote`, { recursive: true });
controlCapability = await loadControlCapability();
await mkdir(sessionDir, { recursive: true });
await mkdir(`${workspace}/.pi/remote-pi`, { recursive: true });
await writeFile(`${workspace}/.pi/remote-pi/config.json`, JSON.stringify({ agent_name: "e2e-interactive", auto_start_relay: true }));

const handleRequest = (method, path, json, capability) => {
  if (method === "GET" && path === "/health") return [200, { ok: true }];
  if (method === "GET" && path === "/state") {
    const { deviceId: _deviceId, pairingToken: _pairingToken, ...publicState } = state;
    return [200, { ...publicState, ready: state.rpcReady && state.runtimeReady && state.relay === "connected" }];
  }
  if ((method === "GET" && path === "/private/pairing") || method === "POST") {
    if (!hasControlCapability(capability)) return [403, { ok: false }];
  }
  if (method === "GET" && path === "/private/pairing") {
    if (!state.deviceId || !state.pairingToken || !state.runtimeId) return [409, { ok: false }];
    return [200, { ok: true, device_id: state.deviceId, endpoint_id: state.endpointId, runtime_instance_id: state.runtimeId, token: state.pairingToken }];
  }
  if (method === "POST" && path === "/rpc") {
    try { send(json); return [202, { ok: true }]; }
    catch (error) { return [409, { ok: false, error: String(error) }]; }
  }
  if (method === "POST" && path === "/control") {
    const action = json.action;
    if (action === "restart") {
      if (closing) return [409, { ok: false }];
      if (child) {
        pendingRestart = true;
        stop("shutdown");
      } else {
        start();
      }
      return [202, { ok: true }];
    }
    if (action === "pair") {
      try { state.pairingToken = null; send({ id: `pair-${randomUUID()}`, type: "prompt", message: "/remote-pi pair --ttl 600" }); return [202, { ok: true }]; }
      catch (error) { return [409, { ok: false, error: String(error) }]; }
    }
    if (action === "revoke" && typeof json.owner_id === "string") {
      try { send({ id: `revoke-${randomUUID()}`, type: "prompt", message: `/remote-pi revoke ${json.owner_id.slice(0, 8)}` }); return [202, { ok: true }]; }
      catch (error) { return [409, { ok: false, error: String(error) }]; }
    }
    if (action === "peer_stop") { try { stop("peer_stop"); return [202, { ok: true }]; } catch (error) { return [409, { ok: false, error: String(error) }]; } }
    if (action === "shutdown") { stop("shutdown"); return [202, { ok: true }]; }
  }
  return [404, { ok: false }];
};

const httpServer = createServer((request, responseObject) => {
  let data = "";
  request.on("data", (chunk) => { data += chunk.toString(); });
  request.on("end", () => {
    let json = {};
    try { json = data ? JSON.parse(data) : {}; } catch { json = {}; }
    const [status, payload] = handleRequest(request.method || "", request.url || "", json, request.headers["x-e2e-control-capability"]);
    const body = JSON.stringify(payload);
    responseObject.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    responseObject.end(body);
  });
});
httpServer.listen(controlPort, "0.0.0.0");
function closeAll() {
  if (closing) return;
  closing = true;
  pendingRestart = false;
  stop("shutdown");
  httpServer.close(() => process.exit(0));
}
process.on("SIGTERM", closeAll);
process.on("SIGINT", closeAll);
start();
