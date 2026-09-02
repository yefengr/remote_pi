import { afterEach, describe, expect, test } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _npmShimTarget,
  busyTransition,
  parseRuntimeEvent,
  RPC_CONTROL_STATUS_KEY,
  resolvePiSpawn,
  rpcSpawnArgs,
  RpcChild,
} from "./rpc_child.js";

function rpcStub(cwd: string): string {
  const bin = join(cwd, "rpc-stub.mjs");
  writeFileSync(bin,
    "#!/usr/bin/env node\n" +
    "process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>{b+=c;let n;while((n=b.indexOf('\\n'))>=0){const l=b.slice(0,n);b=b.slice(n+1);try{const x=JSON.parse(l);if(x.type==='prompt')process.stdout.write(JSON.stringify({type:'response',id:x.id,command:'prompt',success:true})+'\\n')}catch{}}});setInterval(()=>{},1e9);\n",
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe("rpc spawn", () => {
  test("does not pass the extension with -e and always continues the existing session", () => {
    expect(rpcSpawnArgs("daemon")).toEqual([
      "--mode", "rpc", "--approve", "--continue", "--name", "daemon",
    ]);
  });

  test("parses Windows npm shim target", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-shim-"));
    try {
      const target = join(root, "cli.js");
      writeFileSync(target, "// cli");
      const shim = join(root, "pi.cmd");
      writeFileSync(shim, '"%_prog%" "%dp0%\\cli.js" %*\r\n');
      expect(_npmShimTarget(shim)).toBe(target);
      expect(resolvePiSpawn(shim, "win32", "node.exe")).toEqual({ command: "node.exe", prefixArgs: [target] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

const ENDPOINT_ID = "123e4567-e89b-42d3-a456-426614174000";

function extensionReady(child: RpcChild, sessionId = "s"): string {
  return JSON.stringify({
    type: "runtime_ready",
    control_protocol_version: 2,
    endpoint_id: ENDPOINT_ID,
    runtime_instance_id: child.runtimeInstanceId,
    session_id: sessionId,
  });
}

describe("structured RPC lifecycle", () => {
  test("recognizes direct and custom structured lifecycle events", () => {
    expect(parseRuntimeEvent('{"type":"runtime_ready","endpoint_id":"e","runtime_instance_id":"r","session_id":"s"}')).toMatchObject({
      type: "runtime_ready", event: { endpoint_id: "e", runtime_instance_id: "r", session_id: "s" },
    });
    expect(parseRuntimeEvent('{"type":"runtime_failed","code":"config_invalid","retryable":false}')).toMatchObject({
      type: "runtime_failed", event: { code: "config_invalid", retryable: false },
    });
    expect(parseRuntimeEvent('{"type":"entry_appended","entry":{"customType":"remote-pi:relay-state","details":{"status":"reconnecting"}}}')).toEqual({
      type: "relay_state_changed", event: { state: "reconnecting" },
    });
    expect(parseRuntimeEvent(JSON.stringify({
      type: "extension_ui_request",
      method: "setStatus",
      statusKey: RPC_CONTROL_STATUS_KEY,
      statusText: JSON.stringify({
        type: "runtime_ready",
        control_protocol_version: 2,
        endpoint_id: ENDPOINT_ID,
        runtime_instance_id: "runtime-1",
        session_id: "session-1",
      }),
    }))).toMatchObject({
      type: "runtime_ready",
      event: { endpoint_id: ENDPOINT_ID, runtime_instance_id: "runtime-1", session_id: "session-1" },
    });
  });

  test("does not parse stderr, arbitrary text, or unrelated RPC status as a lifecycle event", () => {
    expect(parseRuntimeEvent("remote-pi failed to start")).toBeNull();
    expect(parseRuntimeEvent('{"type":"runtime_failed","code":"x"}')).toBeNull();
    expect(parseRuntimeEvent('{"type":"extension_ui_request","method":"setStatus","statusKey":"other","statusText":"{\\"type\\":\\"runtime_ready\\"}"}')).toBeNull();
    expect(parseRuntimeEvent(JSON.stringify({
      type: "extension_ui_request", method: "setStatus", statusKey: RPC_CONTROL_STATUS_KEY, statusText: "not-json",
    }))).toBeNull();
  });

  test("requires both Pi RPC and Extension structured readiness", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-ready-"));
    const child = new RpcChild({ endpointId: ENDPOINT_ID, piBin: rpcStub(cwd), cwd, readinessTimeoutMs: 100 });
    child.spawn();
    expect(child.runtimeState).toBe("pending");
    await new Promise((resolve) => setTimeout(resolve, 20));
    child._ingestStdoutForTest('{"type":"response","id":"ready","command":"get_state","success":true,"data":{"sessionId":"s","isStreaming":false}}');
    expect(child.runtimeState).toBe("pending");
    child._ingestStdoutForTest(extensionReady(child));
    expect(await child.ready()).toBe(true);
    expect(child.runtimeState).toBe("ready");
    expect(child.sessionId).toBe("s");
    await child.stop();
    rmSync(cwd, { recursive: true, force: true });
  });

  test("blocks when host RPC is ready but the configured Extension is not", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-extension-not-ready-"));
    const child = new RpcChild({ endpointId: ENDPOINT_ID, piBin: rpcStub(cwd), cwd, readinessTimeoutMs: 30 });
    const failed = new Promise<Record<string, unknown>>((resolve) => child.once("runtime_failed", resolve));
    child.spawn();
    child._ingestStdoutForTest('{"type":"response","id":"ready","command":"get_state","success":true,"data":{"sessionId":"s","isStreaming":false}}');
    await expect(failed).resolves.toMatchObject({
      stage: "extension",
      code: "extension_not_ready",
      retryable: false,
    });
    expect(child.runtimeState).toBe("failed");
    expect(child.state).toBe("blocked");
    await child.stop();
    rmSync(cwd, { recursive: true, force: true });
  });

  test("runtime_failed remains deterministic and exposes retryability", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-failed-"));
    const child = new RpcChild({ piBin: rpcStub(cwd), cwd });
    child._ingestStdoutForTest('{"type":"runtime_failed","stage":"extension","code":"duplicate_extension","retryable":false}');
    expect(child.runtimeState).toBe("failed");
    expect(child.state).toBe("blocked");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("correlates prompt acceptance instead of accepting stdin write", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-prompt-"));
    const child = new RpcChild({ endpointId: ENDPOINT_ID, piBin: rpcStub(cwd), cwd });
    child.spawn();
    await new Promise((resolve) => setTimeout(resolve, 20));
    child._ingestStdoutForTest(extensionReady(child));
    child._ingestStdoutForTest('{"type":"response","id":"ready","command":"get_state","success":true,"data":{"sessionId":"s","isStreaming":false}}');
    await child.ready();
    const sent = child.sendPrompt("hi", "prompt-1", 500);
    child._ingestStdoutForTest('{"type":"response","id":"prompt-1","command":"prompt","success":true}');
    await expect(sent).resolves.toEqual({ accepted: true });
    await child.stop();
    rmSync(cwd, { recursive: true, force: true });
  });

  test("blocks a mismatched Extension runtime identity", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-identity-mismatch-"));
    const child = new RpcChild({ endpointId: ENDPOINT_ID, piBin: rpcStub(cwd), cwd });
    child.spawn();
    child._ingestStdoutForTest(JSON.stringify({
      type: "runtime_ready",
      control_protocol_version: 2,
      endpoint_id: ENDPOINT_ID,
      runtime_instance_id: "123e4567-e89b-42d3-a456-426614174099",
    }));
    expect(child.runtimeState).toBe("failed");
    expect(child.state).toBe("blocked");
    await child.stop();
    rmSync(cwd, { recursive: true, force: true });
  });

  test("busy markers remain only a busy hint", () => {
    expect(busyTransition('{"type":"message_start"}')).toBe(true);
    expect(busyTransition('{"type":"message_end"}')).toBe(false);
  });

  test.skipIf(process.platform === "win32")("deliberate stop is not a crash", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-stop-"));
    const bin = join(cwd, "sleep.sh");
    writeFileSync(bin, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(bin, 0o755);
    const child = new RpcChild({ piBin: bin, cwd });
    const exited = new Promise<{ isCrash: boolean }>((resolve) => child.once("exit", resolve));
    child.spawn();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await child.stop();
    await expect(exited).resolves.toMatchObject({ isCrash: false });
    rmSync(cwd, { recursive: true, force: true });
  });
});
