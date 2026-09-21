import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: ["browser.spec.ts", "masumi-browser.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    browserName: "chromium",
    baseURL: "http://127.0.0.1:44020",
    viewport: { width: 1440, height: 1100 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node ../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 44020 --strictPort",
    cwd: "./frontend",
    url: "http://127.0.0.1:44020",
    reuseExistingServer: false,
    env: {
      VITE_SERVER_URL: "http://127.0.0.1:44021",
      VITE_BLOCKFROST_PROJECT_ID: "offline-browser-fixture",
    },
    timeout: 60_000,
  },
});
