import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const LOCAL_DIR = ".pi/remote-pi";
const LOCAL_FILE = "config.json";
const DIRECT_CONFIG_ENV = "REMOTE_PI_DIRECT_CONFIG";

export interface LocalConfig {
  agent_name?: string;
  /** Whether an interactive Pi starts its Relay endpoint automatically. */
  auto_start_relay?: boolean;
}

function pathFor(cwd: string): string {
  return join(cwd, LOCAL_DIR, LOCAL_FILE);
}

function parseLocalConfig(raw: string): LocalConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  const config: LocalConfig = {};
  if (typeof source["agent_name"] === "string" && source["agent_name"].trim()) {
    config.agent_name = source["agent_name"].trim();
  }
  if (typeof source["auto_start_relay"] === "boolean") {
    config.auto_start_relay = source["auto_start_relay"];
  }
  return config;
}

function directConfig(): LocalConfig | null {
  const raw = process.env[DIRECT_CONFIG_ENV];
  if (!raw || raw.trim().length === 0) return null;
  return parseLocalConfig(raw);
}

export function localConfigExists(cwd: string): boolean {
  return directConfig() !== null || existsSync(pathFor(cwd));
}

export function loadLocalConfig(cwd: string): LocalConfig {
  const direct = directConfig();
  if (direct) return direct;

  const path = pathFor(cwd);
  if (!existsSync(path)) return {};
  try {
    return parseLocalConfig(readFileSync(path, "utf8")) ?? {};
  } catch {
    return {};
  }
}

export function saveLocalConfig(cwd: string, patch: Partial<LocalConfig>): void {
  const path = pathFor(cwd);
  const current = loadLocalConfig(cwd);
  const next: LocalConfig = { ...current, ...patch };
  if (typeof next.auto_start_relay !== "boolean") next.auto_start_relay = true;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[remote-pi] could not persist local config ${path}: ${message}`);
  }
}

/** Default display name when none is configured. */
export function defaultAgentName(cwd: string): string {
  return basename(cwd) || "agent";
}

/** Resolves the default for omitted config values. */
export function effectiveAutoStartRelay(config: LocalConfig): boolean {
  return config.auto_start_relay !== false;
}
