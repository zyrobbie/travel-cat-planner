import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: process.env.PAGES_BASE || "/travel-cat-planner/app/",
  build: {
    outDir: fileURLToPath(new URL("../dist/pages/app", import.meta.url)),
    emptyOutDir: true,
  },
  server: { host: "127.0.0.1", port: 4173 },
  preview: { host: "127.0.0.1", port: 4173 },
});
