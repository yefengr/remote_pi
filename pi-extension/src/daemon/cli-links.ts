import { delimiter, join } from "node:path";
import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { findNodeBinary, findRemotePiScript, findSupervisorScript } from "./install.js";

export interface LinkBinariesResult {
  binDir: string;
  links: Array<{ name: string; path: string; target: string }>;
  onPath: boolean;
  log: string[];
}

export function userLocalBinDir(home: string = homedir()): string {
  return join(home, ".local", "bin");
}

export function isOnPath(dir: string, envPath: string = process.env["PATH"] ?? ""): boolean {
  const target = dir.replace(/\/+$/, "");
  return envPath.split(delimiter).some((entry) => entry.replace(/\/+$/, "") === target);
}

export function linkCliBinaries(
  home: string = homedir(),
  paths: { remotePi?: string; supervisord?: string } = {},
  opts: { node?: string; mutatePath?: boolean } = {},
): LinkBinariesResult {
  const binDir = userLocalBinDir(home);
  if (platform() === "win32") return linkCliBinariesWindows(binDir, paths, opts);

  const log: string[] = [];
  mkdirSync(binDir, { recursive: true });
  log.push(`ensured ${binDir}`);
  const remotePi = paths.remotePi ?? findRemotePiScript();
  const supervisord = paths.supervisord ?? findSupervisorScript();
  assertScriptsExist(remotePi, supervisord);
  try { chmodSync(remotePi, 0o755); } catch { /* best-effort */ }
  try { chmodSync(supervisord, 0o755); } catch { /* best-effort */ }

  const links: LinkBinariesResult["links"] = [
    { name: "remote-pi", path: join(binDir, "remote-pi"), target: remotePi },
    { name: "pi-supervisord", path: join(binDir, "pi-supervisord"), target: supervisord },
  ];
  for (const link of links) replaceSymlink(link.path, link.target, log);
  const onPath = isOnPath(binDir);
  if (!onPath) log.push(`WARNING: ${binDir} is not on $PATH. Add this line to your shell rc: export PATH="$HOME/.local/bin:$PATH"`);
  return { binDir, links, onPath, log };
}

function assertScriptsExist(remotePi: string, supervisord: string): void {
  if (!existsSync(remotePi)) throw new Error(`remote-pi script not found at ${remotePi}. Run \`pnpm build\` (dev) or reinstall the extension.`);
  if (!existsSync(supervisord)) throw new Error(`supervisor script not found at ${supervisord}. Run \`pnpm build\` (dev) or reinstall the extension.`);
}

function linkCliBinariesWindows(
  binDir: string,
  paths: { remotePi?: string; supervisord?: string },
  opts: { node?: string; mutatePath?: boolean },
): LinkBinariesResult {
  const log: string[] = [];
  mkdirSync(binDir, { recursive: true });
  log.push(`ensured ${binDir}`);
  const node = opts.node ?? findNodeBinary();
  const remotePi = paths.remotePi ?? findRemotePiScript();
  const supervisord = paths.supervisord ?? findSupervisorScript();
  assertScriptsExist(remotePi, supervisord);
  const links: LinkBinariesResult["links"] = [
    { name: "remote-pi.cmd", path: join(binDir, "remote-pi.cmd"), target: remotePi },
    { name: "pi-supervisord.cmd", path: join(binDir, "pi-supervisord.cmd"), target: supervisord },
  ];
  for (const link of links) { writeFileSync(link.path, buildCmdShim(node, link.target)); log.push(`wrote ${link.path}`); }
  const onPath = isOnPath(binDir);
  if (!onPath && opts.mutatePath !== false) {
    try { addUserPath(binDir); log.push(`added ${binDir} to your user PATH — open a NEW terminal for \`remote-pi\` to resolve.`); }
    catch (error) { log.push(`WARNING: ${binDir} is not on PATH and auto-add failed (${String(error)}). Add it manually: setx PATH "%PATH%;${binDir}"`); }
  }
  return { binDir, links, onPath, log };
}

export function buildCmdShim(node: string, target: string): string {
  return `@echo off\r\n"${node}" "${target}" %*\r\n`;
}

function addUserPath(dir: string): void {
  const literal = `'${dir.replace(/'/g, "''")}'`;
  execFileSync("powershell", [
    "-NoProfile", "-NonInteractive", "-Command",
    `$d = ${literal}; ` +
    "$p = [Environment]::GetEnvironmentVariable('Path','User'); " +
    "if (-not $p) { $p = '' }; " +
    "$parts = $p.Split(';') | Where-Object { $_ -ne '' }; " +
    "if ($parts -notcontains $d) { [Environment]::SetEnvironmentVariable('Path', (($parts + $d) -join ';'), 'User') }",
  ], { stdio: ["ignore", "pipe", "pipe"] });
}

export interface UnlinkBinariesResult {
  binDir: string;
  removed: Array<{ name: string; path: string; existed: boolean }>;
  log: string[];
}

export function unlinkCliBinaries(home: string = homedir()): UnlinkBinariesResult {
  const binDir = userLocalBinDir(home);
  const log: string[] = [];
  const names = platform() === "win32" ? ["remote-pi.cmd", "pi-supervisord.cmd"] : ["remote-pi", "pi-supervisord"];
  const removed: UnlinkBinariesResult["removed"] = [];
  for (const name of names) {
    const path = join(binDir, name);
    let existed = false;
    try { lstatSync(path); existed = true; } catch { /* absent */ }
    if (existed) {
      try { unlinkSync(path); log.push(`removed ${path}`); }
      catch (error) { log.push(`failed to remove ${path}: ${String(error)}`); existed = false; }
    }
    removed.push({ name, path, existed });
  }
  return { binDir, removed, log };
}

function replaceSymlink(linkPath: string, target: string, log: string[]): void {
  let existing: string | null = null;
  try { existing = readlinkSync(linkPath); } catch { /* not a symlink */ }
  if (existing === target) { log.push(`symlink ${linkPath} → ${target} (unchanged)`); return; }
  try { unlinkSync(linkPath); } catch { /* absent */ }
  symlinkSync(target, linkPath);
  log.push(`symlink ${linkPath} → ${target}`);
}
