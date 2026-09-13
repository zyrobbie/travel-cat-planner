import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
const legacy = JSON.parse(
    await fs.readFile(".local/e2b-test-baseline.json", "utf8"),
  ).dist,
  current = path.resolve("dist/pages/app"),
  base = "/travel-cat-planner/app/";
http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1:4181");
      if (!url.pathname.startsWith(base)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const relative = url.pathname.slice(base.length) || "index.html";
      if (relative.includes("..")) throw Error();
      const roots = url.searchParams.has("__baseline")
        ? [legacy]
        : [current, legacy, path.resolve(".local/e2b-store")];
      let data;
      for (const root of roots) {
        try {
          data = await fs.readFile(path.join(root, relative));
          break;
        } catch {}
      }
      if (!data) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.setHeader(
        "Content-Type",
        relative.endsWith(".html")
          ? "text/html; charset=utf-8"
          : relative.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : relative.endsWith(".css")
              ? "text/css"
              : "application/octet-stream",
      );
      res.setHeader("Cache-Control", "no-store");
      res.end(data);
    } catch {
      res.writeHead(500);
      res.end("Test server error");
    }
  })
  .listen(4181, "127.0.0.1");
