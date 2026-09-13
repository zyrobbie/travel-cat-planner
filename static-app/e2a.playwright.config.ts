import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../tests/e2a",
  workers: 1,
  retries: 0,
  timeout: 60000,
  use: {
    baseURL: "http://127.0.0.1:4180/travel-cat-planner/app/",
    browserName: "chromium",
  },
  webServer: {
    command: "node scripts/e2a-test-server.mjs",
    cwd: process.cwd(),
    url: "http://127.0.0.1:4180/travel-cat-planner/app/",
    reuseExistingServer: false,
  },
  reporter: [["list"]],
  outputDir: "/tmp/catletters-e2a-evidence/results",
});
