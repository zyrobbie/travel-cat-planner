import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../tests/pages",
  workers: 1,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:4173/travel-cat-planner/app/",
    browserName: "chromium",
    headless: true,
  },
  webServer: {
    command: "npm run pages:preview",
    url: "http://127.0.0.1:4173/travel-cat-planner/app/",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  reporter: [["list"]],
  outputDir: "/tmp/catletters-pages-evidence/results",
});
