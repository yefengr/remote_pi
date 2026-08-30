import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  addDaemon,
  findDaemonByCwd,
  listDaemons,
  loadRegistry,
  normalizeCwd,
  registryPath,
  removeDaemon,
  saveRegistry,
  setDaemonDesiredState,
  RegistrySchemaError,
} from "./registry.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pi-reg-v2-"));
  process.env["REMOTE_PI_HOME"] = home;
});
afterEach(() => {
  delete process.env["REMOTE_PI_HOME"];
  rmSync(home, { recursive: true, force: true });
});

function writeRaw(value: unknown): void {
  mkdirSync(join(home, ".pi", "remote"), { recursive: true });
  writeFileSync(registryPath(), JSON.stringify(value));
}

describe("daemon registry v2", () => {
  test("missing registry is an empty v2 registry", () => {
    expect(loadRegistry()).toEqual({ version: 2, daemons: [] });
  });

  test("add persists an opaque stable id, real cwd, desired running and created_at", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-reg-add-"));
    const added = addDaemon(dir, "Worker");
    expect(added).toMatchObject({ cwd: realpathSync(dir), name: "Worker", desired_state: "running" });
    expect(added.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(added.created_at).toBeGreaterThan(0);
    const disk = JSON.parse(readFileSync(registryPath(), "utf8"));
    expect(disk).toEqual({ version: 2, daemons: [added] });
  });

  test("normalizes symlink cwd before persisting", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-reg-link-"));
    const real = join(root, "real");
    const link = join(root, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    expect(addDaemon(link).cwd).toBe(realpathSync(real));
    expect(() => addDaemon(real)).toThrow(/already registered/i);
  });

  test("rejects an existing non-realpath cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-reg-invalid-realpath-"));
    const real = join(root, "real");
    const link = join(root, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    writeRaw({ version: 2, daemons: [{ id: "123e4567-e89b-42d3-a456-426614174000", cwd: link, name: "x", desired_state: "running", created_at: 1 }] });
    expect(() => loadRegistry()).toThrow(/realpath/i);
  });

  test("set desired state persists without changing registration identity", () => {
    const entry = addDaemon(mkdtempSync(join(tmpdir(), "pi-reg-state-")));
    const stopped = setDaemonDesiredState(entry.id, "stopped");
    expect(stopped).toMatchObject({ id: entry.id, desired_state: "stopped" });
    expect(listDaemons()).toEqual([stopped]);
  });

  test("remove uses persistent id rather than cwd-derived identity", () => {
    const first = addDaemon(mkdtempSync(join(tmpdir(), "pi-reg-rm-a-")));
    addDaemon(mkdtempSync(join(tmpdir(), "pi-reg-rm-b-")));
    expect(removeDaemon(first.id)).toMatchObject({ removed: true, cwd: first.cwd });
    expect(listDaemons()).toHaveLength(1);
  });

  test("finds a registration by canonical cwd for external teardown", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-reg-find-cwd-"));
    const entry = addDaemon(dir);
    expect(findDaemonByCwd(dir)).toEqual(entry);
    expect(findDaemonByCwd(join(dir, "missing"))).toBeUndefined();
  });

  test("existing malformed JSON throws a structured error and is not overwritten", () => {
    mkdirSync(join(home, ".pi", "remote"), { recursive: true });
    writeFileSync(registryPath(), "{bad json");
    expect(() => loadRegistry()).toThrow(RegistrySchemaError);
    expect(() => addDaemon(mkdtempSync(join(tmpdir(), "pi-reg-safe-")))).toThrow(RegistrySchemaError);
    expect(readFileSync(registryPath(), "utf8")).toBe("{bad json");
  });

  test("old cwd-only schema is rejected instead of silently migrated", () => {
    writeRaw({ daemons: [{ cwd: "/tmp/old" }] });
    try { loadRegistry(); throw new Error("expected schema rejection"); }
    catch (error) {
      expect(error).toBeInstanceOf(RegistrySchemaError);
      expect((error as RegistrySchemaError).code).toBe("registry_schema_unsupported");
    }
  });

  test("rejects malformed v2 entries", () => {
    writeRaw({ version: 2, daemons: [{ id: "not-an-id", cwd: "/tmp/x", name: "x", desired_state: "running", created_at: 1 }] });
    expect(() => loadRegistry()).toThrow(/opaque UUID/i);
  });

  test("save validates before writing", () => {
    expect(() => saveRegistry({ version: 2, daemons: [
      // @ts-expect-error intentionally invalid entry
      { id: "x" },
    ] })).toThrow(RegistrySchemaError);
    expect(existsSync(registryPath())).toBe(false);
  });
});

describe("normalizeCwd", () => {
  test("canonicalizes absolute and relative existing paths", () => {
    expect(isAbsolute(normalizeCwd("."))).toBe(true);
    expect(normalizeCwd(".")).toBe(realpathSync("."));
  });
  test("rejects empty or nonexistent paths", () => {
    expect(() => normalizeCwd("")).toThrow(/required/i);
    expect(() => normalizeCwd("/no/such/path/registry-v2")).toThrow();
  });
});
