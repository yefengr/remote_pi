import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function execCommand(cmd: string, args: string[], log: string[]): void {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (out.trim()) log.push(`$ ${cmd} ${args.join(" ")}\n${out.trim()}`);
    else log.push(`$ ${cmd} ${args.join(" ")}`);
  } catch (error) {
    const err = error as { stderr?: Buffer | string; status?: number; message: string };
    const stderr = typeof err.stderr === "string" ? err.stderr : err.stderr?.toString() ?? "";
    throw new Error(
      `\`${cmd} ${args.join(" ")}\` exited ${err.status ?? "?"}\n${stderr.trim() || err.message}`,
    );
  }
}

/** Cleanup commands may fail when the service is not currently installed. */
export function tryExecCommand(cmd: string, args: string[], log: string[]): void {
  try { execCommand(cmd, args, log); } catch { /* expected cleanup failure */ }
}

/** Build the elevated Windows batch script. Kept pure for cross-platform tests. */
export function buildElevatedCmd(lines: string[], logFile: string): string {
  const redirect = ` >> "${logFile}" 2>&1`;
  const body = lines.map((line) =>
    /^\s*(if|exit|rem|@)/i.test(line) ? line : line + redirect,
  );
  return ["@echo off", ...body].join("\r\n") + "\r\n";
}

function readIfExists(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

/** Run a schtasks sequence through one UAC prompt and surface its output. */
export function execElevatedWindows(lines: string[], log: string[]): void {
  const base = join(tmpdir(), `remote-pi-elevate-${process.pid}`);
  const cmdPath = `${base}.cmd`;
  const logFile = `${base}.log`;
  writeFileSync(cmdPath, buildElevatedCmd(lines, logFile));
  try { unlinkSync(logFile); } catch { /* none yet */ }

  let thrown: unknown = null;
  try {
    execFileSync("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      `$p = Start-Process -FilePath cmd.exe -ArgumentList '/c','"${cmdPath}"' ` +
      "-Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode",
    ], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    thrown = error;
  }

  const output = readIfExists(logFile).trim();
  if (output) log.push(output);
  try { unlinkSync(cmdPath); } catch { /* best-effort */ }
  try { unlinkSync(logFile); } catch { /* best-effort */ }

  if (thrown) {
    throw new Error(
      "administrator privileges required — the UAC prompt was declined or the " +
      "schtasks operation failed. Run the command again and accept the Windows " +
      `elevation prompt.${output ? `\n${output}` : ""}`,
    );
  }
}

export const _exec = execCommand;
export const _tryExec = tryExecCommand;
export const _execElevatedWindows = execElevatedWindows;
