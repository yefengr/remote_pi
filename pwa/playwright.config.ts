import { defineConfig, devices } from "playwright/test";

function resolvePort(): number {
  const rawPort = process.env.PLAYWRIGHT_E2E_PORT ?? "3101";
  if (!/^\d+$/.test(rawPort)) throw new Error("PLAYWRIGHT_E2E_PORT must be a numeric TCP port.");

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PLAYWRIGHT_E2E_PORT must be between 1 and 65535.");
  }
  return port;
}

const port = resolvePort();
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 2,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 900 },
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["Pixel 5"],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: "pnpm build && pnpm start:e2e-server",
    url: `${baseURL}/app`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      PORT: String(port),
    },
  },
});
