import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { defineConfig } from "vite";
import { vaultchatSri } from "./vite-plugin-sri";

// Sumo-Variante: CJS unter dist/modules-sumo/ — schlanke "libsodium-wrappers"
// enthaelt kein crypto_pwhash (Argon2). Alias auf den aufgeloesten Pfad, damit
// der Build nicht den kaputten ESM-Entry trifft.
const nodeRequire = createRequire(import.meta.url);
const libsodiumSumoPath = nodeRequire.resolve("libsodium-wrappers-sumo");

export default defineConfig({
  plugins: [react(), tailwindcss(), vaultchatSri()],
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
