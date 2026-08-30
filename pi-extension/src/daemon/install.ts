import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execCommand as _exec, execElevatedWindows as _execElevatedWindows, tryExecCommand as _tryExec } from "./install-runtime.js";

export { buildElevatedCmd } from "./install-runtime.js";
export {
  buildCmdShim, isOnPath, linkCliBinaries, unlinkCliBinaries, userLocalBinDir,
} from "./cli-links.js";
export type { LinkBinariesResult, UnlinkBinariesResult } from "./cli-links.js";

/**
 * Generates and activates a system service for `pi-supervisord` so the
 * daemon fleet survives reboots (plan/26 W3).
 *
 * Platform support:
 *   - **macOS**: writes `~/Library/LaunchAgents/dev.remotepi.supervisord.plist`
 *     and runs `launchctl bootstrap gui/<uid> <plist>` (modern API) with a
 *     fallback to `launchctl load` for older macOS.
 *   - **Linux**: writes `~/.config/systemd/user/remote-pi-supervisord.service`
 *     and runs `systemctl --user daemon-reload && systemctl --user enable
 *     --now remote-pi-supervisord.service`.
 *
 * Uninstall reverses both. Idempotent — re-running install over an existing
 * unit refreshes it (paths could have changed if user moved node_modules).
 *
 * **What does NOT happen here**: the actual `npm install -g @yefengr/remote-pi` step.
 * The user has to make the supervisor bin reachable on disk before install
 * can wire up the service. The `findSupervisorScript` resolver detects
 * common cases (npm global, pnpm global, local dev clone) and yields a
 * clear error otherwise.
 */

// ── Platform detection ─────────────────────────────────────────────────────

export type SupervisorPlatform = "macos" | "linux" | "windows" | "unsupported";

export function detectPlatform(): SupervisorPlatform {
  switch (platform()) {
    case "darwin": return "macos";
    case "linux": return "linux";
    case "win32": return "windows";
    default: return "unsupported";
  }
}

// ── Path resolution ────────────────────────────────────────────────────────

/**
 * Absolute path to the supervisor's compiled entry. We resolve from
 * `import.meta.url` (this file's location) since wherever the daemon
 * module lives, `bin/supervisord.js` is a sibling of `daemon/` under
 * `dist/`.
 *
 * After build: `dist/daemon/install.js` → `dist/bin/supervisord.js`.
 * In dev (`tsx`): same path resolution still lands inside `src/`, which
 * isn't directly runnable by `node` — dev install isn't expected.
 */
export function findSupervisorScript(): string {
  const here = fileURLToPath(import.meta.url);          // dist/daemon/install.js
  const daemonDir = dirname(here);                       // dist/daemon
  const distRoot = dirname(daemonDir);                   // dist
  return resolve(distRoot, "bin/supervisord.js");
}

/**
 * Absolute path to the extension's CLI entry (`dist/index.js`). This is
 * the file we symlink to `~/.local/bin/remote-pi` so the user can run
 * `remote-pi <subcommand>` from any shell after installing the extension
 * through Pi (`pi install npm:@yefengr/remote-pi`).
 *
 * Same resolution strategy as `findSupervisorScript`: from
 * `dist/daemon/install.js` → `dist/index.js`.
 */
export function findRemotePiScript(): string {
  const here = fileURLToPath(import.meta.url);          // dist/daemon/install.js
  const daemonDir = dirname(here);                       // dist/daemon
  const distRoot = dirname(daemonDir);                   // dist
  return resolve(distRoot, "index.js");
}

export function findNodeBinary(): string {
  // `process.execPath` is always absolute and points at the current Node
  // binary. Embedding it in the service unit means the user gets the
  // exact same Node version they invoked `remote-pi install` with — no
  // PATH ambiguity at boot time.
  return process.execPath;
}

export function findTemplate(name: "systemd" | "launchd" | "taskscheduler" | "vbs-launcher"): string {
  // Templates ship next to the compiled `dist/` (via `files` in package.json).
  // From `dist/daemon/install.js` go up two levels and into
  // `service-templates/`. In the published npm tarball the layout is the
  // same — `service-templates/` is sibling to `dist/`.
  const here = fileURLToPath(import.meta.url);          // dist/daemon/install.js
  const pkgRoot = resolve(dirname(dirname(dirname(here))));  // package root
  const file =
    name === "systemd" ? "systemd.service.template" :
    name === "launchd" ? "launchd.plist.template" :
    name === "vbs-launcher" ? "task-launcher.vbs.template" :
    "task-scheduler.xml.template";
  return resolve(pkgRoot, "service-templates", file);
}

// ── Service paths ──────────────────────────────────────────────────────────

export function systemdUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", "remote-pi-supervisord.service");
}

export function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", "dev.remotepi.supervisord.plist");
}

export const LAUNCHD_LABEL = "dev.remotepi.supervisord";
/** systemd --user unit name (with `.service`) for the supervisor. */
export const SYSTEMD_UNIT = "remote-pi-supervisord.service";
/** Windows Task Scheduler task name (plan/40). */
export const WINDOWS_TASK_NAME = "RemotePiSupervisor";

/** Path of the rendered Task Scheduler XML (input to `schtasks /Create /XML`). */
export function taskXmlPath(): string {
  return join(homedir(), ".pi", "remote", "RemotePiSupervisor.xml");
}

/**
 * Path of the rendered VBScript launcher the Task Scheduler action invokes
 * via `wscript.exe` (plan/40, Windows). Launching node through this hidden
 * wrapper is what keeps the supervisor from flashing a console window.
 */
export function vbsLauncherPath(): string {
  return join(homedir(), ".pi", "remote", "RemotePiSupervisorLauncher.vbs");
}

/**
 * Combined stdout/stderr log for the Windows supervisor. The Task Scheduler
 * launches it hidden via wscript, so without this redirect its output (and the
 * forwarded daemon-child stderr) would vanish — mirrors launchd/systemd, which
 * already log to `~/.pi/remote/supervisord.log`.
 */
export function supervisordLogPath(): string {
  return join(homedir(), ".pi", "remote", "supervisord.log");
}

// ── Template rendering ─────────────────────────────────────────────────────

export interface RenderVars {
  node: string;
  supervisor: string;
  home: string;
  user: string;
  /** PATH inherited so `pi --mode rpc` resolves the same way it does
   *  interactively. We snapshot `process.env.PATH` at install time. */
  path: string;
  /** Windows only: absolute path of the VBScript launcher the Task Scheduler
   *  action runs via `wscript.exe`. Empty on POSIX (templates ignore `{VBS}`). */
  vbs: string;
  /** Windows only: combined stdout/stderr log the hidden supervisor appends to.
   *  Empty on POSIX (templates ignore `{LOG}`). */
  logPath: string;
}

export function defaultRenderVars(): RenderVars {
  return {
    node: findNodeBinary(),
    supervisor: findSupervisorScript(),
    home: homedir(),
    user: userInfo().username,
    path: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    vbs: vbsLauncherPath(),
    logPath: supervisordLogPath(),
  };
}

/** Replace `{NODE}` / `{SUPERVISOR}` / `{USER}` / `{HOME}` / `{PATH}` / `{VBS}` / `{LOG}`. */
export function renderTemplate(template: string, vars: RenderVars): string {
  return template
    .replace(/\{NODE\}/g, vars.node)
    .replace(/\{SUPERVISOR\}/g, vars.supervisor)
    .replace(/\{USER\}/g, vars.user)
    .replace(/\{HOME\}/g, vars.home)
    .replace(/\{PATH\}/g, vars.path)
    .replace(/\{VBS\}/g, vars.vbs)
    .replace(/\{LOG\}/g, vars.logPath);
}

// ── Install / uninstall API ────────────────────────────────────────────────

export interface InstallResult {
  platform: SupervisorPlatform;
  unitPath: string;
  /** Lines describing each step taken — surfaced to the user via notify. */
  log: string[];
}

/**
 * Writes the unit/plist, runs the platform's activation command. Throws
 * on unsupported OS or when the supervisor script isn't found.
 *
 * Idempotent: re-running re-writes the unit (paths could have changed)
 * and re-activates via the platform tool's idempotent flag.
 */
export function installService(vars: RenderVars = defaultRenderVars()): InstallResult {
  const plat = detectPlatform();
  const log: string[] = [];

  if (plat === "unsupported") {
    throw new Error(`unsupported platform: ${platform()}. Only macOS, Linux, and Windows.`);
  }

  // Sanity: supervisor script must exist on disk.
  if (!existsSync(vars.supervisor)) {
    throw new Error(
      `supervisor script not found at ${vars.supervisor}. ` +
      "Run `pnpm build` (dev) or `npm install -g @yefengr/remote-pi` (prod) first.",
    );
  }

  const templateName = plat === "macos" ? "launchd" : plat === "linux" ? "systemd" : "taskscheduler";
  const templatePath = findTemplate(templateName);
  if (!existsSync(templatePath)) {
    throw new Error(`service template missing: ${templatePath}`);
  }
  const tpl = readFileSync(templatePath, "utf8");
  const rendered = renderTemplate(tpl, vars);

  const unitPath = plat === "macos" ? launchdPlistPath() : plat === "linux" ? systemdUnitPath() : taskXmlPath();
  mkdirSync(dirname(unitPath), { recursive: true });
  if (plat === "windows") {
    // `schtasks /Create /XML` requires UTF-16LE + BOM. A UTF-8 file fails with
    // "(1,40)::ERROR: unable to switch the encoding" — the bytes must match the
    // template's `encoding="UTF-16"` declaration. (plan/40 risk #5.)
    const bom = Buffer.from([0xff, 0xfe]); // UTF-16LE byte-order mark
    writeFileSync(unitPath, Buffer.concat([bom, Buffer.from(rendered, "utf16le")]));
  } else {
    writeFileSync(unitPath, rendered);  // launchd/systemd → UTF-8
  }
  log.push(`wrote ${unitPath}`);

  if (plat === "macos") {
    // Unload first in case a stale entry exists from a prior install —
    // `launchctl bootstrap` errors out otherwise. `bootout` is the modern
    // API; `unload` is the legacy fallback. Either may fail silently.
    const uid = userInfo().uid;
    _tryExec("launchctl", ["bootout", `gui/${uid}`, unitPath], log);
    _tryExec("launchctl", ["unload", unitPath], log);
    _exec("launchctl", ["bootstrap", `gui/${uid}`, unitPath], log);
    log.push(`activated via launchctl bootstrap gui/${uid}`);
  } else if (plat === "linux") {
    _exec("systemctl", ["--user", "daemon-reload"], log);
    _exec("systemctl", ["--user", "enable", "--now", "remote-pi-supervisord.service"], log);
    log.push("activated via systemctl --user enable --now");
  } else {
    // windows — Task Scheduler (plan/40). The action runs `wscript.exe
    // <launcher.vbs>` (not node directly) so the supervisor starts hidden,
    // with no console window. Render + write that launcher first.
    const vbsTpl = findTemplate("vbs-launcher");
    if (!existsSync(vbsTpl)) throw new Error(`vbs launcher template missing: ${vbsTpl}`);
    const vbsPath = vars.vbs;
    writeFileSync(vbsPath, renderTemplate(readFileSync(vbsTpl, "utf8"), vars));
    log.push(`wrote ${vbsPath}`);

    // Only `schtasks /Create` modifies the root task store → that single op
    // needs admin (elevate it via UAC). `/End` (stop a prior instance) and
    // `/Run` (start it) act on a task we already own and work un-elevated — the
    // very ops `remote-pi restart-supervisor` runs without elevation. Keeping
    // them un-elevated narrows the admin surface to the one operation that
    // truly requires it.
    _tryExec("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME], log);
    _execElevatedWindows([
      `schtasks /Create /XML "${unitPath}" /TN ${WINDOWS_TASK_NAME} /F`,
    ], log);
    _exec("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME], log);
    log.push(`activated via schtasks /Create (elevated) + /Run (${WINDOWS_TASK_NAME})`);
  }

  return { platform: plat, unitPath, log };
}

export interface UninstallResult {
  platform: SupervisorPlatform;
  unitPath: string;
  removed: boolean;
  log: string[];
}

export function uninstallService(): UninstallResult {
  const plat = detectPlatform();
  const log: string[] = [];

  if (plat === "unsupported") {
    throw new Error(`unsupported platform: ${platform()}. Only macOS, Linux, and Windows.`);
  }

  const unitPath = plat === "macos" ? launchdPlistPath() : plat === "linux" ? systemdUnitPath() : taskXmlPath();

  if (plat === "macos") {
    const uid = userInfo().uid;
    _tryExec("launchctl", ["bootout", `gui/${uid}`, unitPath], log);
    _tryExec("launchctl", ["unload", unitPath], log);
    log.push("deactivated via launchctl bootout");
  } else if (plat === "linux") {
    _tryExec("systemctl", ["--user", "disable", "--now", "remote-pi-supervisord.service"], log);
    log.push("deactivated via systemctl --user disable --now");
  } else {
    // windows — Task Scheduler (plan/40): stop + delete the task. Only
    // `/Delete` modifies the root task store → that's the op that needs admin.
    // `/End` stops the running task and works un-elevated (own task), like
    // restart-supervisor. `exit /b 0` keeps uninstall best-effort: a missing
    // task (already removed) is success, not an error.
    _tryExec("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME], log);
    _execElevatedWindows([
      `schtasks /Delete /TN ${WINDOWS_TASK_NAME} /F`,
      `exit /b 0`,
    ], log);
    log.push(`deactivated via elevated schtasks /Delete (${WINDOWS_TASK_NAME})`);
  }

  let removed = false;
  if (existsSync(unitPath)) {
    try { unlinkSync(unitPath); removed = true; log.push(`removed ${unitPath}`); }
    catch (e) { log.push(`failed to remove ${unitPath}: ${String(e)}`); }
  }

  // Windows: also drop the hidden VBScript launcher we wrote alongside the XML.
  if (plat === "windows") {
    const vbsPath = vbsLauncherPath();
    if (existsSync(vbsPath)) {
      try { unlinkSync(vbsPath); log.push(`removed ${vbsPath}`); }
      catch (e) { log.push(`failed to remove ${vbsPath}: ${String(e)}`); }
    }
  }

  if (plat === "linux") {
    _tryExec("systemctl", ["--user", "daemon-reload"], log);
  }

  // Hint about the label for users that want to verify manually.
  if (plat === "macos") log.push(`(label: ${LAUNCHD_LABEL})`);

  return { platform: plat, unitPath, removed, log };
}
