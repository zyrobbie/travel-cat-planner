import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../tests/e2b",
  workers: 1,
  retries: 0,
  timeout: 60000,
  use: {
    baseURL: "http://127.0.0.1:4181/travel-cat-planner/app/",
    browserName: "chromium",
  },
  webServer: {
    command: "node scripts/e2b-test-server.mjs",
    cwd: process.cwd(),
    url: "http://127.0.0.1:4181/travel-cat-planner/app/",
    reuseExistingServer: false,
  },
  reporter: [["list"]],
  outputDir: "/tmp/catletters-e2b-evidence/results",
});
