import { describe, expect, test } from "vitest";
import type { Extension } from "@earendil-works/pi-coding-agent";
import { evaluateDaemonPreflight, runDaemonPreflight, type PreflightServices } from "./preflight.js";

const PACKAGE_ROOT = "/packages/remote-pi";

function extension(overrides: Partial<Extension> = {}): Extension {
  return {
    path: "/extensions/extension.js",
    resolvedPath: "/extensions/extension.js",
    sourceInfo: { path: "/extensions/extension.js", source: "local", scope: "user", origin: "top-level" },
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
    ...overrides,
  };
}

function services(extensions: readonly Extension[] = [], errors: readonly { path: string; error: string }[] = []): PreflightServices {
  return {
    diagnostics: [],
    resourceLoader: { getExtensions: () => ({ extensions, errors }) },
    settingsManager: { drainErrors: () => [] },
    modelRegistry: { getError: () => undefined },
  };
}

const remote = () => extension({
  resolvedPath: "/packages/remote-pi/dist/index.js",
  sourceInfo: {
    path: "/packages/remote-pi/dist/index.js",
    source: "@yefengr/remote-pi@0.7.4",
    scope: "user",
    origin: "package",
    baseDir: "/packages/remote-pi",
  },
});

describe("daemon SDK preflight", () => {
  test("blocks when no configured Remote Pi Extension is discovered", () => {
    expect(evaluateDaemonPreflight(services([extension()]), PACKAGE_ROOT)).toMatchObject({
      ok: false, code: "remote_pi_extension_missing",
    });
  });

  test("accepts exactly one Remote Pi package source", () => {
    expect(evaluateDaemonPreflight(services([remote()]), PACKAGE_ROOT)).toEqual({ ok: true });
  });

  test("blocks duplicate Remote Pi sources without leaking filesystem paths", () => {
    const result = evaluateDaemonPreflight(services([remote(), remote()]), PACKAGE_ROOT);
    expect(result).toMatchObject({ ok: false, code: "duplicate_remote_pi_extension" });
    if (!result.ok) {
      expect(result.sources).toEqual(["user:package:@yefengr/remote-pi", "user:package:@yefengr/remote-pi"]);
      expect(JSON.stringify(result)).not.toContain("/packages/");
    }
  });

  test("blocks Pi extension diagnostics before source selection", () => {
    expect(evaluateDaemonPreflight(services([remote()], [{ path: "/secret/path", error: "bad extension" }]), PACKAGE_ROOT)).toMatchObject({
      ok: false, code: "extension_diagnostic",
    });
  });

  test("classifies discovery and schema exceptions as deterministic preflight failures", async () => {
    await expect(runDaemonPreflight({
      cwd: process.cwd(),
      discover: async () => { throw new Error("settings secret must not leak"); },
    })).resolves.toEqual({ ok: false, code: "preflight_failed", message: "Pi SDK resource discovery failed" });
  });
});
