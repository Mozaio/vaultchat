import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

/**
 * Fügt nach dem Build integrity="sha384-…" und crossorigin="anonymous" für script/link ein.
 */
export function vaultchatSri(): Plugin {
  return {
    name: "vaultchat-sri",
    apply: "build",
    closeBundle() {
      const outDir = join(process.cwd(), "dist");
      const indexPath = join(outDir, "index.html");
      if (!existsSync(indexPath)) return;
      let html = readFileSync(indexPath, "utf8");
      const assetRe = /(src|href)="(\/assets\/[^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = assetRe.exec(html))) {
        const attr = m[1];
        const webPath = m[2];
        const filePath = join(outDir, webPath.replace(/^\//, ""));
        if (!existsSync(filePath)) continue;
        const buf = readFileSync(filePath);
        const hash = createHash("sha384").update(buf).digest("base64");
        const integrity = `sha384-${hash}`;
        const needle = `${attr}="${webPath}"`;
        if (html.includes(`${attr}="${webPath}" integrity=`)) continue;
        html = html.replace(
          needle,
          `${attr}="${webPath}" integrity="${integrity}" crossorigin="anonymous"`
        );
      }
      writeFileSync(indexPath, html, "utf8");
    },
  };
}
