import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { vaultchatSri } from "./vite-plugin-sri";

// Sumo-Variante: CJS unter dist/modules-sumo/ — schlanke "libsodium-wrappers"
// enthaelt kein crypto_pwhash (Argon2). Alias auf den aufgeloesten Pfad, damit
// der Build nicht den kaputten ESM-Entry trifft.
const nodeRequire = createRequire(import.meta.url);
const libsodiumSumoPath = nodeRequire.resolve("libsodium-wrappers-sumo");

/**
 * @matrix-org/olm liefert eine olm.wasm-Datei neben seinem JS-Modul.
 * Vite zieht das JS in den Bundle, vergisst aber die wasm-Datei — also
 * kopieren wir sie explizit nach dist/ als /olm.wasm. olmAdapter.ts ruft
 * dann `Olm.init({ locateFile: () => "/olm.wasm" })`.
 */
function copyOlmWasm(): Plugin {
  return {
    name: "vaultchat-copy-olm-wasm",
    apply: "build",
    closeBundle() {
      const olmJs = nodeRequire.resolve("@matrix-org/olm");
      const wasmSrc = join(dirname(olmJs), "olm.wasm");
      if (!existsSync(wasmSrc)) {
        // eslint-disable-next-line no-console
        console.warn("[vaultchat] olm.wasm nicht gefunden bei", wasmSrc);
        return;
      }
      const distDir = join(process.cwd(), "dist");
      if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });
      const wasmDst = join(distDir, "olm.wasm");
      copyFileSync(wasmSrc, wasmDst);
      // eslint-disable-next-line no-console
      console.log("[vaultchat-copy-olm-wasm] copied", wasmSrc, "→", wasmDst);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), copyOlmWasm(), vaultchatSri()],
  resolve: {
    alias: {
      "libsodium-wrappers-sumo": libsodiumSumoPath,
    },
  },
  optimizeDeps: {
    include: ["libsodium-wrappers-sumo"],
    // @matrix-org/olm wird über dynamic import in lib/olmAdapter.ts geladen.
    // Wir EXCLUDIEREN es bewusst aus optimizeDeps — Vite würde sonst die
    // WASM-Datei via fetch zur Build-Zeit auflösen und das Modul in den
    // Hauptbundle ziehen, was den Initial-Bundle aufbläht obwohl die meisten
    // Sessions Olm (noch) nicht aktiv nutzen.
    exclude: ["@matrix-org/olm"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: false,
    commonjsOptions: {
      // CJS default export === module.exports (libsodium mutiert dieses Objekt nach ready()).
      defaultIsModuleExports: true,
      transformMixedEsModules: true,
    },
  },
});
