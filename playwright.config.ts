import { defineConfig, devices } from "@playwright/test";

const firefoxProjects =
  process.platform === "darwin"
    ? []
    : [
        {
          name: "desktop-firefox",
          use: { ...devices["Desktop Firefox"] },
        },
      ];

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4321",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    ...firefoxProjects,
    {
      name: "desktop-webkit",
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command: "bun run dev --host 127.0.0.1 --ignore-lock",
    cwd: "apps/web",
    env: {
      ASTRO_DEV_BACKGROUND: "0",
    },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: "http://127.0.0.1:4321",
  },
});
