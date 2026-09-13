import { spawn } from "node:child_process";
import {
  openSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import net from "node:net";
mkdirSync(".local", { recursive: true });
const pidFile = ".local/app.pid";
async function occupied() {
  return new Promise((resolve) => {
    const socket = net.connect(3100, "127.0.0.1");
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}
async function healthy() {
  try {
    const r = await fetch("http://127.0.0.1:3100/api/health", {
      signal: AbortSignal.timeout(1000),
    });
    return r.ok && (await r.json()).mode === "INTERNAL";
  } catch {
    return false;
  }
}
if (await occupied()) {
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8"));
    try {
      process.kill(pid, 0);
      if (await healthy()) {
        console.log(
          "Existing local app is healthy on http://127.0.0.1:3100; PID preserved.",
        );
        process.exit(0);
      }
    } catch {}
  }
  throw Error("Port 3100 is occupied; no process or PID file was changed.");
}
const log = openSync(".local/app.log", "a");
const child = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "127.0.0.1",
    "-p",
    "3100",
  ],
  { detached: true, stdio: ["ignore", log, log], env: process.env },
);
let failed = false;
child.on("exit", () => {
  failed = true;
});
child.on("error", () => {
  failed = true;
});
for (let i = 0; i < 30; i++) {
  if (failed)
    throw Error(
      "App failed to start; inspect .local/app.log. PID not replaced.",
    );
  if (await healthy()) {
    writeFileSync(pidFile, String(child.pid));
    child.unref();
    console.log(
      "Local app health confirmed on http://127.0.0.1:3100; PID/log saved in .local.",
    );
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 200));
}
child.kill();
throw Error(
  "App health did not become ready; inspect .local/app.log. PID not replaced.",
);
