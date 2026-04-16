import { defineConfig, devices } from "@playwright/test";

// @ts-expect-error process is a nodejs global
const isCI: boolean = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: "pnpm dev",
    port: 1420,
    reuseExistingServer: !isCI,
  },
  use: {
    // Explicit baseURL — webServer.port also sets this implicitly, but we prefer explicit config
    baseURL: "http://localhost:1420",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
