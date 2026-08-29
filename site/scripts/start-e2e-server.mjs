import { spawn } from "node:child_process";
import { cp, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const siteDirectory = resolve(scriptDirectory, "..");
const buildDirectory = join(siteDirectory, ".next");
const standaloneDirectory = join(buildDirectory, "standalone");

async function requireDirectory(path) {
  const details = await stat(path).catch(() => null);
  if (!details?.isDirectory()) throw new Error(`Missing production build directory: ${path}`);
}

async function requireFile(path) {
  const details = await stat(path).catch(() => null);
  if (!details?.isFile()) throw new Error(`Missing production build file: ${path}`);
}

async function replaceRuntimeAsset(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true, force: true });
}

async function prepareStandaloneBuild() {
  const publicDirectory = join(siteDirectory, "public");
  const staticDirectory = join(buildDirectory, "static");

  await Promise.all([
    requireDirectory(publicDirectory),
    requireDirectory(staticDirectory),
    requireDirectory(standaloneDirectory),
    requireFile(join(standaloneDirectory, "server.js")),
  ]);

  await Promise.all([
    replaceRuntimeAsset(publicDirectory, join(standaloneDirectory, "public")),
    replaceRuntimeAsset(staticDirectory, join(standaloneDirectory, ".next", "static")),
  ]);
}

async function runStandaloneServer() {
  const server = spawn(process.execPath, ["server.js"], {
    cwd: standaloneDirectory,
    env: {
      ...process.env,
      NODE_ENV: "production",
    },
    stdio: "inherit",
  });

  await new Promise((resolveRun, rejectRun) => {
    let terminationSignal = null;
    const forwardSignal = (signal) => {
      terminationSignal ??= signal;
      if (!server.killed) server.kill(signal);
    };
    const removeSignalHandlers = () => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    };
    const onInterrupt = () => forwardSignal("SIGINT");
    const onTerminate = () => forwardSignal("SIGTERM");

    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    server.once("error", (error) => {
      removeSignalHandlers();
      rejectRun(error);
    });
    server.once("exit", (code, signal) => {
      removeSignalHandlers();
      if (terminationSignal || code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`Standalone server exited unexpectedly (${signal ?? `code ${code ?? 1}`}).`));
    });
  });
}

async function main() {
  await prepareStandaloneBuild();
  await runStandaloneServer();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
