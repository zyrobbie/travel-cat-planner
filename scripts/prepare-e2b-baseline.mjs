import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const revision = "ce2c31f0b3d47ae04137beacf6de76b0752b901c";
try {
  execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], {
    stdio: "ignore",
  });
} catch {
  execFileSync("git", ["fetch", "--depth=1", "origin", revision], {
    stdio: "inherit",
  });
}
const dir = mkdtempSync(path.join(tmpdir(), "catletters-e2b-test-baseline-"));
const archive = execFileSync("git", [
  "archive",
  revision,
  "static-app",
  "src/app/page.module.css",
  "src/app/globals.css",
  "src/app/client-api.ts",
  "src/content/frozen.json",
  "tsconfig.json",
  "package.json",
]);
execFileSync("tar", ["-x", "-C", dir], { input: archive });
symlinkSync(
  path.join(process.cwd(), "node_modules"),
  path.join(dir, "node_modules"),
  "dir",
);
execFileSync(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "build",
    "--config",
    path.join(dir, "static-app/vite.config.ts"),
  ],
  { stdio: "inherit" },
);
mkdirSync(".local", { recursive: true });
writeFileSync(
  ".local/e2b-test-baseline.json",
  JSON.stringify({ revision, dist: path.join(dir, "dist/pages/app") }, null, 2),
);
console.log(
  "Real published baseline built. Test server uses the same origin/base for old and new HTML.",
);
// Test-only module for calling the real transaction boundary with invalid references.
// It is served solely by the E2-A test server and never packaged in dist/pages/app.
const { build } = await import("vite");
await build({
  configFile: false,
  build: {
    lib: {
      entry: path.resolve("static-app/store.ts"),
      formats: ["es"],
      fileName: () => "store-test.js",
    },
    outDir: ".local/e2b-store",
    emptyOutDir: true,
  },
});
