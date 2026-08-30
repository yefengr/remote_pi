import { platform as osPlatform, userInfo } from "node:os";

/**
 * Cross-platform local IPC naming retained for daemon supervisor control only.
 */
export type Plat = NodeJS.Platform;

export function usesNamedPipe(plat: Plat = osPlatform()): boolean {
  return plat === "win32";
}

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function ipcAddress(
  suffix: string,
  filePath: string,
  plat: Plat = osPlatform(),
  user?: string,
): string {
  if (plat === "win32") {
    const name = safe((user ?? userInfo().username) || "user");
    return `\\\\.\\pipe\\remote-pi-${safe(suffix)}-${name}`;
  }
  return filePath;
}
