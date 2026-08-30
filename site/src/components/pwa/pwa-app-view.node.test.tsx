import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("PwaAppView structure", () => {
  const source = readFileSync(new URL("./pwa-app-view.tsx", import.meta.url), "utf8");

  test("gates startup before rendering the workspace root", () => {
    expect(source).toMatch(/if \(startup\.state === "loading"\) return <StartupLoading \/>;/);
    expect(source).toMatch(/if \(startup\.state === "error"\) return <StartupErrorView error=\{startup\.error\} onRetry=\{actions\.startup\.retry\} \/>;/);
    expect(source).toMatch(/<div className="pwa-root" key=\{status\.layoutRevision\}>/);
  });

  test("keeps the presentation module free of runtime clients", () => {
    expect(source).not.toMatch(/relay-client|peer-channel|TimelineRuntime|Dexie/);
  });
});
