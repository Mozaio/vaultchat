import express from "express";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Serve built SPA when present (../client/dist relative to server dist/). */
export function attachSpa(app: express.Express) {
  const root = join(__dirname, "..", "..", "client", "dist");
  app.use(
    express.static(root, {
      index: false,
      immutable: true,
      maxAge: "1y",
      setHeaders(res, path) {
        res.setHeader("X-Content-Type-Options", "nosniff");
        if (path.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-store");
          return;
        }
        if (!/[/\\]assets[/\\]/.test(path)) {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    })
  );
  app.get("*", async (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/ws")) {
      next();
      return;
    }
    try {
      const html = await readFile(join(root, "index.html"), "utf8");
      res
        .type("html")
        .setHeader("Cache-Control", "no-store");
      res.send(html);
    } catch {
      next();
    }
  });
}
