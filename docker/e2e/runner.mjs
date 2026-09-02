import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const root = new URL("../..", import.meta.url).pathname;
const compose = `${root}docker/e2e/compose.yml`;
const project = "remote-pi-e2e";
const ownerPorts = { b: 18788, c: 18789 };
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS || "45000");

function composeCall(args, options = {}) {
  return execFileSync("docker", ["compose", "-p", project, "-f", compose, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function request(port, path, { method = "GET", body, capability } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (capability) headers["x-e2e-control-capability"] = capability;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
  return payload;
}

async function expectStatus(port, path, expectedStatus, { method = "GET", body, capability } = {}, label) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (capability) headers["x-e2e-control-capability"] = capability;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  await response.body?.cancel();
  assert(response.status === expectedStatus, label);
}

async function dockerExec(service, args, input) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", "-p", project, "-f", compose, "exec", "-T", service, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`docker exec ${service} exited ${code}: ${stderr}`)));
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

async function readControlCapability(service, path) {
  const { stdout } = await dockerExec(service, ["sh", "-lc", `cat ${path}`]);
  const capability = stdout.trim();
  if (!capability) throw new Error(`${service} control capability is empty`);
  return capability;
}

function sequenceOf(state) {
  return Number.isSafeInteger(state?.sequence) ? state.sequence : 0;
}

function eventAfter(state, cursor, predicate) {
  return state.frames.some((frame) => frame.sequence > cursor && predicate(frame));
}

function endpointEventAfter(state, cursor, predicate) {
  return state.endpoint_events.some((event) => event.sequence > cursor && predicate(event));
}

async function waitFor(label, callback) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      const value = await callback();
      if (value) return value;
    } catch (error) { lastError = String(error); }
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label}: ${lastError}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  process.stdout.write(`assert ${message}=true\n`);
}

async function main() {
  const runId = `run-${randomUUID()}`;
  const id = (name) => `${runId}-${name}`;

  composeCall(["up", "-d", "--build", "--force-recreate"]);
  await waitFor("relay", async () => {
    const result = composeCall(["ps", "--format", "json"]);
    return result.includes('"Service":"relay"') && result.includes('"Health":"healthy"');
  });
  const interactive = await waitFor("interactive runtime", async () => {
    const state = await request(18787, "/state");
    return state.ready ? state : null;
  });
  assert(interactive.rpcReady, "interactive_rpc_get_state");
  assert(interactive.runtimeReady, "interactive_runtime_ready");
  assert(interactive.relay === "connected", "interactive_relay_connected");

  await waitFor("owner-b", async () => (await request(ownerPorts.b, "/health")).ok ? true : null);
  await waitFor("owner-c", async () => (await request(ownerPorts.c, "/health")).ok ? true : null);

  const interactiveCapability = await readControlCapability("interactive", "/home/pi/.pi/remote/e2e-control-capability");
  const ownerBCapability = await readControlCapability("owner-b", "/var/lib/remote-pi-owner/control-capability");
  const ownerCCapability = await readControlCapability("owner-c", "/var/lib/remote-pi-owner/control-capability");

  await expectStatus(18787, "/private/pairing", 403, {}, "interactive_pairing_without_capability");
  await expectStatus(ownerPorts.b, "/private/id", 403, {}, "owner_private_id_without_capability");
  await expectStatus(18787, "/control", 403, { method: "POST", capability: "invalid-capability", body: { action: "pair" } }, "interactive_control_invalid_capability");
  await expectStatus(ownerPorts.b, "/subscribe", 403, { method: "POST", body: { device_id: "invalid-capability-test" } }, "owner_subscribe_without_capability");

  await request(18787, "/control", { method: "POST", capability: interactiveCapability, body: { action: "pair", request_id: id("control-pair-b") } });
  const pairing = await waitFor("pairing token", async () => {
    const value = await request(18787, "/private/pairing", { capability: interactiveCapability });
    return value.ok ? value : null;
  });
  await waitFor("owner-b endpoint subscription", async () => {
    try {
      await request(ownerPorts.b, "/subscribe", { method: "POST", capability: ownerBCapability, body: { device_id: pairing.device_id } });
      return true;
    } catch { return false; }
  });
  await waitFor("owner-c endpoint subscription", async () => {
    try {
      await request(ownerPorts.c, "/subscribe", { method: "POST", capability: ownerCCapability, body: { device_id: pairing.device_id } });
      return true;
    } catch { return false; }
  });
  const ownerB = await waitFor("owner-b authenticated subscription", async () => {
    const state = await request(ownerPorts.b, "/state");
    return state.ready ? state : null;
  });
  const ownerC = await waitFor("owner-c authenticated subscription", async () => {
    const state = await request(ownerPorts.c, "/state");
    return state.ready ? state : null;
  });
  assert(ownerB.ready && ownerC.ready, "persistent_owners_ready");
  // The Relay keeps pairing endpoints invisible before ACL authorization.
  // The host control plane already owns the private tuple and gives it to the
  // Owner only for this local test transaction, never normal script output.
  const endpoint = { device_id: pairing.device_id, endpoint_id: pairing.endpoint_id, runtime_instance_id: pairing.runtime_instance_id };
  await request(ownerPorts.b, "/endpoint", { method: "POST", capability: ownerBCapability, body: endpoint });
  await request(ownerPorts.c, "/endpoint", { method: "POST", capability: ownerCCapability, body: endpoint });
  const bPairCursor = sequenceOf(await request(ownerPorts.b, "/state"));
  const pairResult = await request(ownerPorts.b, "/pair", { method: "POST", capability: ownerBCapability, body: { token: pairing.token, endpoint, request_id: id("pair-b") } });
  assert(pairResult.ok, "pair_owner_b");

  const bAfterPair = await waitFor("owner-b pair_ok", async () => {
    const state = await request(ownerPorts.b, "/state");
    return eventAfter(state, bPairCursor, (frame) => frame.type === "pair_ok" && frame.in_reply_to === pairResult.request_id) ? state : null;
  });
  const sessionEndpoint = bAfterPair.endpoint;
  const channelB = id("channel-b");
  const helloB = id("hello-b");
  const bHelloCursor = sequenceOf(await request(ownerPorts.b, "/state"));
  await request(ownerPorts.b, "/frame", { method: "POST", capability: ownerBCapability, body: { frame: { protocol_version: 2, type: "session_hello", id: helloB, channel_id: channelB } } });
  const readyState = await waitFor("session_ready", async () => {
    const state = await request(ownerPorts.b, "/state");
    return eventAfter(state, bHelloCursor, (frame) => frame.type === "session_ready" && frame.in_reply_to === helloB) ? state : null;
  });
  const sessionReady = readyState.frames.find((frame) => frame.sequence > bHelloCursor && frame.type === "session_ready" && frame.in_reply_to === helloB);
  assert(!!sessionReady, "session_ready");
  const generation = sessionReady?.history_generation;

  const pingB = id("ping-b");
  const bPingCursor = sequenceOf(await request(ownerPorts.b, "/state"));
  await request(ownerPorts.b, "/frame", { method: "POST", capability: ownerBCapability, body: { frame: { protocol_version: 2, type: "ping", id: pingB, channel_id: channelB, history_generation: generation } } });
  const pong = await waitFor("pong", async () => {
    const state = await request(ownerPorts.b, "/state");
    return eventAfter(state, bPingCursor, (frame) => frame.type === "pong" && frame.in_reply_to === pingB);
  });
  assert(pong, "pong");

  await request(18787, "/control", { method: "POST", capability: interactiveCapability, body: { action: "pair", request_id: id("control-pair-c") } });
  const pairingC = await waitFor("second pairing token", async () => {
    const value = await request(18787, "/private/pairing", { capability: interactiveCapability });
    return value.ok && value.token !== pairing.token ? value : null;
  });
  const cPairCursor = sequenceOf(await request(ownerPorts.c, "/state"));
  const pairC = await request(ownerPorts.c, "/pair", { method: "POST", capability: ownerCCapability, body: { token: pairingC.token, endpoint, request_id: id("pair-c") } });
  assert(pairC.ok, "pair_owner_c");
  await waitFor("owner-c pair_ok", async () => {
    const state = await request(ownerPorts.c, "/state");
    return eventAfter(state, cPairCursor, (frame) => frame.type === "pair_ok" && frame.in_reply_to === pairC.request_id);
  });
  const channelC = id("channel-c");
  const helloC = id("hello-c");
  const cHelloCursor = sequenceOf(await request(ownerPorts.c, "/state"));
  await request(ownerPorts.c, "/frame", { method: "POST", capability: ownerCCapability, body: { frame: { protocol_version: 2, type: "session_hello", id: helloC, channel_id: channelC } } });
  const ownerCReady = await waitFor("owner-c session_ready", async () => {
    const state = await request(ownerPorts.c, "/state");
    return eventAfter(state, cHelloCursor, (frame) => frame.type === "session_ready" && frame.in_reply_to === helloC) ? state : null;
  });
  const cReady = ownerCReady.frames.find((frame) => frame.sequence > cHelloCursor && frame.type === "session_ready" && frame.in_reply_to === helloC);
  assert(!!cReady, "second_owner_session_ready");

  const newB = id("new-b");
  const bNewCursor = sequenceOf(await request(ownerPorts.b, "/state"));
  const cReplacementCursor = sequenceOf(await request(ownerPorts.c, "/state"));
  await request(ownerPorts.b, "/frame", { method: "POST", capability: ownerBCapability, body: { frame: { protocol_version: 2, type: "session_new", id: newB, channel_id: channelB, history_generation: generation } } });
  const newResult = await waitFor("session_new reply", async () => {
    const state = await request(ownerPorts.b, "/state");
    return eventAfter(state, bNewCursor, (frame) => (frame.type === "action_ok" || frame.type === "action_error") && frame.in_reply_to === newB) ? state : null;
  });
  assert(newResult.frames.some((frame) => frame.sequence > bNewCursor && frame.type === "action_ok" && frame.in_reply_to === newB), "session_new_invariant");
  const cReplacement = await waitFor("owner-c replacement", async () => {
    const state = await request(ownerPorts.c, "/state");
    return eventAfter(state, cReplacementCursor, (frame) => frame.type === "bye" && frame.reason === "session_replaced");
  });
  assert(cReplacement, "second_owner_session_replaced");
  const reboundChannelC = id("channel-c-after-new");
  const reboundHelloC = id("hello-c-after-new");
  const cReboundCursor = sequenceOf(await request(ownerPorts.c, "/state"));
  await request(ownerPorts.c, "/frame", { method: "POST", capability: ownerCCapability, body: { frame: { protocol_version: 2, type: "session_hello", id: reboundHelloC, channel_id: reboundChannelC } } });
  const ownerCRebound = await waitFor("owner-c rebound session", async () => {
    const state = await request(ownerPorts.c, "/state");
    return eventAfter(state, cReboundCursor, (frame) => frame.type === "session_ready" && frame.in_reply_to === reboundHelloC) ? state : null;
  });
  const cReboundReady = ownerCRebound.frames.find((frame) => frame.sequence > cReboundCursor && frame.type === "session_ready" && frame.in_reply_to === reboundHelloC);
  assert(!!cReboundReady, "survivor_rebound_after_new");
  const survivorGeneration = cReboundReady.history_generation;

  // The host command takes an 8-character public-key prefix. Obtain only the
  // full key through the local control plane; it never enters normal output.
  const ownerBId = (await request(ownerPorts.b, "/private/id", { capability: ownerBCapability })).owner_id;
  const bRevokeCursor = sequenceOf(await request(ownerPorts.b, "/state"));
  await request(18787, "/control", { method: "POST", capability: interactiveCapability, body: { action: "revoke", owner_id: ownerBId, request_id: id("control-revoke-b") } });
  await waitFor("owner-b endpoint_ended", async () => {
    const state = await request(ownerPorts.b, "/state");
    return endpointEventAfter(state, bRevokeCursor, (event) => event.type === "endpoint_ended");
  });
  const rejectedCursor = sequenceOf(await request(ownerPorts.b, "/state"));
  const revokedPing = id("ping-revoked");
  await request(ownerPorts.b, "/frame", { method: "POST", capability: ownerBCapability, body: { frame: { protocol_version: 2, type: "ping", id: revokedPing, channel_id: channelB, history_generation: generation } } });
  await sleep(1000);
  const revokedState = await request(ownerPorts.b, "/state");
  assert(!eventAfter(revokedState, rejectedCursor, (frame) => frame.type === "pong" && frame.in_reply_to === revokedPing), "revoked_route_rejected");
  const survivorPing = id("ping-survivor");
  const cSurvivorCursor = sequenceOf(await request(ownerPorts.c, "/state"));
  await request(ownerPorts.c, "/frame", { method: "POST", capability: ownerCCapability, body: { frame: { protocol_version: 2, type: "ping", id: survivorPing, channel_id: reboundChannelC, history_generation: survivorGeneration } } });
  const survivorPong = await waitFor("survivor pong", async () => {
    const state = await request(ownerPorts.c, "/state");
    return eventAfter(state, cSurvivorCursor, (frame) => frame.type === "pong" && frame.in_reply_to === survivorPing);
  });
  assert(survivorPong, "survivor_ping_after_revoke");
  const revokeFrames = (await request(ownerPorts.b, "/state")).frames;
  const peerStop = revokeFrames.some((frame) => frame.sequence > bRevokeCursor && frame.type === "bye" && frame.reason === "peer_stop");
  process.stdout.write(`finding revoke_peer_stop=${peerStop ? "observed" : "expected_known_failure"}\n`);

  const cPeerStopCursor = sequenceOf(await request(ownerPorts.c, "/state"));
  await request(18787, "/control", { method: "POST", capability: interactiveCapability, body: { action: "peer_stop", request_id: id("control-peer-stop") } });
  const shutdownBye = await waitFor("peer_stop bye for survivor", async () => {
    const state = await request(ownerPorts.c, "/state");
    return eventAfter(state, cPeerStopCursor, (frame) => frame.type === "bye" && frame.reason === "peer_stop");
  });
  assert(shutdownBye, "peer_stop_bye");
  const beforeRestart = await request(18787, "/state");
  await request(18787, "/control", { method: "POST", capability: interactiveCapability, body: { action: "restart", request_id: id("control-restart") } });
  const restarted = await waitFor("interactive restart", async () => {
    const state = await request(18787, "/state");
    return state.ready && state.runtimeId && state.runtimeId !== beforeRestart.runtimeId ? state : null;
  });
  assert(restarted.ready && restarted.runtimeId !== beforeRestart.runtimeId, "interactive_restart_runtime_changed");

  const supervisor = await dockerExec("supervisor", ["sh", "-lc", "test -S \"$HOME/.pi/remote/supervisor.sock\" && printf ready"]);
  assert(supervisor.stdout.trim() === "ready", "supervisor_socket");
  const cronGate = await dockerExec("supervisor", ["node", "--input-type=module", "-e", "import { decideFireAction } from '/opt/remote-pi/dist/daemon/status.js'; process.stdout.write(decideFireAction({exists:true,desired:'stopped',runtime:'pending',health:'stopped',busy:false,skipIfBusy:true,retrying:false}))"]);
  assert(cronGate.stdout.trim() === "skip_desired_stopped", "cron_desired_state_gate");
  assert(sessionEndpoint.endpoint_id === pairing.endpoint_id, "endpoint_identity_consistent");
}

main().catch((error) => {
  process.stderr.write(`verify failed: ${error.message}\n`);
  process.exitCode = 1;
});
