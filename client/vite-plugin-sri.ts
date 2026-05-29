import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

/**
 * Fügt nach dem Build integrity="sha384-…" zu <script src="/assets/…">,
 * <link href="/assets/…"> und <link rel="modulepreload"> hinzu.
 *
 * Vite emittiert bereits crossorigin auf seinen Tags, also fügen wir das
 * NUR ein wo es fehlt (vorher hat die Plugin-Version es immer eingesetzt,
 * was bei Vite-Tags zu doppeltem `crossorigin` führte — vom Browser still
 * akzeptiert, aber unsauber).
 */
export function vaultchatSri(): Plugin {
  return {
    name: "vaultchat-sri",
    apply: "build",
    closeBundle() {
      // Tauri serves the bundle from a custom WebView origin; if SRI ever
      // trips up that loader, the desktop build can opt out with
      // VITE_DISABLE_SRI=1 (the web/Render build keeps SRI on).
      if (process.env.VITE_DISABLE_SRI === "1") {
        // eslint-disable-next-line no-console
        console.log("[vaultchat-sri] skipped (VITE_DISABLE_SRI=1)");
        return;
      }
      const outDir = join(process.cwd(), "dist");
      const indexPath = join(outDir, "index.html");
      if (!existsSync(indexPath)) return;
      let html = readFileSync(indexPath, "utf8");
      const assetRe = /<(script|link)\b([^>]*?)(src|href)="(\/assets\/[^"]+)"([^>]*)>/g;
      let count = 0;
      html = html.replace(assetRe, (full, tag, pre, attr, webPath, post) => {
        const filePath = join(outDir, webPath.replace(/^\//, ""));
        if (!existsSync(filePath)) return full;
        const combined = pre + post;
        if (/\bintegrity=/.test(combined)) return full;
        const buf = readFileSync(filePath);
        const hash = createHash("sha384").update(buf).digest("base64");
        const integrity = `sha384-${hash}`;
        const hasCrossOrigin = /\bcrossorigin\b/.test(combined);
        count++;
        const inject = hasCrossOrigin
          ? ` integrity="${integrity}"`
          : ` integrity="${integrity}" crossorigin="anonymous"`;
        return `<${tag}${pre}${attr}="${webPath}"${post}${inject}>`;
      });
      writeFileSync(indexPath, html, "utf8");
      // eslint-disable-next-line no-console
      console.log(`[vaultchat-sri] sha384 integrity added to ${count} asset tag(s)`);
    },
  };
}
