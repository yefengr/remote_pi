import { createConnection } from "node:net";

/** Probe the supervisor socket without treating a stale file as a live owner. */
export function probeSupervisor(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ path });
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(value);
    };
    const timeout = setTimeout(() => finish(false), 1_000);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
