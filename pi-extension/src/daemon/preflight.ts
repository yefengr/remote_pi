import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionServices,
  getAgentDir,
  type AgentSessionServices,
  type AgentSessionRuntimeDiagnostic,
  type Extension,
} from "@earendil-works/pi-coding-agent";

const REMOTE_PI_PACKAGE = "@yefengr/remote-pi";

export type PreflightBlockedCode =
  | "remote_pi_extension_missing"
  | "duplicate_remote_pi_extension"
  | "extension_diagnostic"
  | "preflight_failed";

export type DaemonPreflightResult =
  | { ok: true }
  | {
    ok: false;
    code: PreflightBlockedCode;
    message: string;
    /** Safe package identities only; never raw paths, URLs, or diagnostics. */
    sources?: string[];
  };

export interface PreflightServices {
  diagnostics: readonly AgentSessionRuntimeDiagnostic[];
  resourceLoader: {
    getExtensions(): {
      extensions: readonly Extension[];
      errors: readonly { path: string; error: string }[];
    };
  };
  settingsManager?: { drainErrors(): readonly unknown[] };
  modelRegistry?: { getError(): string | undefined };
}

export interface DaemonPreflightOptions {
  cwd: string;
  agentDir?: string;
  /** Tests inject discovery; production always uses Pi's SDK service factory. */
  discover?: (options: { cwd: string; agentDir: string }) => Promise<PreflightServices>;
  /** Tests may substitute the installed Remote Pi package root. */
  packageRoot?: string;
}

let offlineDiscoveryDepth = 0;
let previousOfflineValue: string | undefined;

/**
 * Pi 0.79's resource loader can install missing configured packages unless
 * PI_OFFLINE is set. The guard is reference-counted because supervisors can
 * preflight separate entries concurrently. Discovery remains local-only.
 */
async function withOfflineDiscovery<T>(action: () => Promise<T>): Promise<T> {
  if (offlineDiscoveryDepth === 0) {
    previousOfflineValue = process.env["PI_OFFLINE"];
    process.env["PI_OFFLINE"] = "1";
  }
  offlineDiscoveryDepth += 1;
  try {
    return await action();
  } finally {
    offlineDiscoveryDepth -= 1;
    if (offlineDiscoveryDepth === 0) {
      if (previousOfflineValue === undefined) delete process.env["PI_OFFLINE"];
      else process.env["PI_OFFLINE"] = previousOfflineValue;
      previousOfflineValue = undefined;
    }
  }
}

function packageNameAt(path: string): string | undefined {
  let current = path;
  try {
    if (!statSync(current).isDirectory()) current = dirname(current);
  } catch {
    current = dirname(current);
  }
  while (true) {
    const manifest = resolve(current, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
        return typeof parsed.name === "string" ? parsed.name : undefined;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function isRemotePiPackageSource(source: string | undefined): boolean {
  if (!source) return false;
  const spec = source.startsWith("npm:") ? source.slice("npm:".length) : source;
  return spec === REMOTE_PI_PACKAGE || spec.startsWith(`${REMOTE_PI_PACKAGE}@`);
}

function isPathWithin(path: string, root: string): boolean {
  const child = resolve(path);
  const parent = resolve(root);
  const remainder = relative(parent, child);
  return remainder === "" || (!remainder.startsWith("..") && !remainder.includes("../"));
}

function installedPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function isRemotePiExtension(extension: Extension, packageRoot: string): boolean {
  if (isRemotePiPackageSource(extension.sourceInfo.source)) return true;
  if (extension.sourceInfo.baseDir && packageNameAt(extension.sourceInfo.baseDir) === REMOTE_PI_PACKAGE) return true;
  if (packageNameAt(extension.resolvedPath) === REMOTE_PI_PACKAGE) return true;
  return isPathWithin(extension.resolvedPath, packageRoot) && packageNameAt(packageRoot) === REMOTE_PI_PACKAGE;
}

function safeSource(extension: Extension): string {
  const scope = extension.sourceInfo.scope === "project" || extension.sourceInfo.scope === "user"
    ? extension.sourceInfo.scope
    : "temporary";
  return `${scope}:package:${REMOTE_PI_PACKAGE}`;
}

/**
 * Classifies already-discovered Pi services. Kept pure with injected service
 * data so source identity and blocked-state rules have deterministic tests.
 */
export function evaluateDaemonPreflight(services: PreflightServices, packageRoot = installedPackageRoot()): DaemonPreflightResult {
  const extensions = services.resourceLoader.getExtensions();
  const diagnosticErrors = services.diagnostics.filter((diagnostic) => diagnostic.type === "error");
  if (extensions.errors.length > 0 || diagnosticErrors.length > 0) {
    return {
      ok: false,
      code: "extension_diagnostic",
      message: `Pi reported ${extensions.errors.length + diagnosticErrors.length} extension diagnostic error(s)`,
    };
  }
  if ((services.settingsManager?.drainErrors().length ?? 0) > 0 || services.modelRegistry?.getError()) {
    return { ok: false, code: "preflight_failed", message: "Pi settings or model configuration is invalid" };
  }

  const remoteExtensions = extensions.extensions.filter((extension) => isRemotePiExtension(extension, packageRoot));
  if (remoteExtensions.length === 0) {
    return { ok: false, code: "remote_pi_extension_missing", message: "No configured Remote Pi Extension was discovered" };
  }
  if (remoteExtensions.length > 1) {
    return {
      ok: false,
      code: "duplicate_remote_pi_extension",
      message: `Found ${remoteExtensions.length} configured Remote Pi Extension sources`,
      sources: remoteExtensions.map(safeSource),
    };
  }
  return { ok: true };
}

/**
 * Runs the same SettingsManager/package/resource discovery Pi performs before
 * RPC startup. It creates services only: no AgentSession or model runtime is
 * created, and the SDK exposes no service-level dispose operation to call.
 */
export async function runDaemonPreflight(options: DaemonPreflightOptions): Promise<DaemonPreflightResult> {
  try {
    const agentDir = options.agentDir ?? getAgentDir();
    const discover = options.discover ?? (async ({ cwd, agentDir: resolvedAgentDir }) =>
      createAgentSessionServices({ cwd, agentDir: resolvedAgentDir }));
    const services = await withOfflineDiscovery(() => discover({ cwd: options.cwd, agentDir }));
    return evaluateDaemonPreflight(services, options.packageRoot);
  } catch {
    return { ok: false, code: "preflight_failed", message: "Pi SDK resource discovery failed" };
  }
}
