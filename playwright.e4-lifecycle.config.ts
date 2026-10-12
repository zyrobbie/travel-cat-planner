import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
if (
  !process.env.E4_TEST_ORIGIN ||
  !process.env.E4_SYNTHETIC_INBOX ||
  new URL(process.env.DATABASE_URL ?? "http://invalid").pathname !==
    "/catletters_e4_lifecycle_test"
)
  throw Error("Run scripts/test-e4-lifecycle.mjs");
const evidence = resolve(
  process.env.E4_EVIDENCE_DIR ?? ".local/e4-lifecycle-evidence",
);
export default defineConfig({
  testDir: "tests/e4-lifecycle",
  testMatch: "privacy.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 10000 },
  use: {
    baseURL: process.env.E4_TEST_ORIGIN,
    browserName: "chromium",
    headless: true,
    trace: "off",
    actionTimeout: 10000,
    navigationTimeout: 30000,
  },
  reporter: [
    ["list"],
    ["json", { outputFile: resolve(evidence, "browser-results.json") }],
  ],
  outputDir: resolve(evidence, "browser"),
});
