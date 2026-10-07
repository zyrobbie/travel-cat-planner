import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

if (
  !process.env.E4_TEST_ORIGIN ||
  !process.env.E4_SYNTHETIC_INBOX ||
  !process.env.DATABASE_URL?.includes("/catletters_e4_binding_test")
)
  throw new Error("Run the isolated scripts/test-e4-binding.mjs harness.");
const evidence = resolve(
  process.env.E4_EVIDENCE_DIR ?? ".local/e4-binding-evidence",
);
export default defineConfig({
  testDir: "tests/e4",
  testMatch: "account-client.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.E4_TEST_ORIGIN,
    browserName: "chromium",
    headless: true,
    trace: "off",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  webServer: {
    command:
      "node node_modules/vite/bin/vite.js --config static-app/vite.config.ts --host 127.0.0.1 --port 18994 --strictPort",
    url: "http://127.0.0.1:18994/",
    reuseExistingServer: false,
    timeout: 30_000,
    env: { PAGES_BASE: "/" },
  },
  reporter: [
    ["list"],
    ["json", { outputFile: resolve(evidence, "browser-results.json") }],
  ],
  outputDir: resolve(evidence, "browser"),
});
