import path from "node:path";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const src = path.resolve(__dirname, "src");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${src}/` },
    ],
  },
  test: {
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.node.test.{ts,tsx}"],
          setupFiles: ["src/test/node/setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.tsx"],
          setupFiles: ["src/test/browser/setup.ts"],
          testTimeout: 15_000,
          hookTimeout: 15_000,
          browser: {
            enabled: true,
            provider: playwright({
              actionTimeout: 5_000,
            }),
            headless: true,
            instances: [
              {
                browser: "chromium",
                viewport: { width: 1280, height: 900 },
                screenshotFailures: true,
                screenshotDirectory: "./.vitest/screenshots",
              },
            ],
          },
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: [
        "src/app/**",
        "src/test/**",
        "public/**",
        "**/*.browser.test.{ts,tsx}",
        "**/*.node.test.{ts,tsx}",
        "**/*.config.{js,ts,mjs,cjs}",
      ],
    },
  },
});
