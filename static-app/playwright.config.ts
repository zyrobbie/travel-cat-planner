import { defineConfig } from "@playwright/test";
const port = Number(process.env.PAGES_TEST_PORT ?? 4173);
const base = `http://127.0.0.1:${port}/travel-cat-planner/app/`;
export default defineConfig({
  testDir: "../tests/pages",
  workers: 1,
  retries: 0,
  use: {
    baseURL: base,
    browserName: "chromium",
    headless: true,
  },
  webServer: {
    command: `npm run pages:preview -- --port ${port}`,
    url: base,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  reporter: [["list"]],
  outputDir: "/tmp/catletters-pages-evidence/results",
});
