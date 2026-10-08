import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  envDir: fileURLToPath(new URL("../..", import.meta.url)),
  base: "/account-app/",
  build: {
    outDir: fileURLToPath(new URL("../../public/account-app", import.meta.url)),
    emptyOutDir: true,
  },
});
