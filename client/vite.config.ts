import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { defineConfig } from "vite";
import { vaultchatSri } from "./vite-plugin-sri";

// libsodium-wrappers 0.7.x liefert einen kaputten ESM-Entry aus (./libsodium.mjs
// fehlt). Wir zwingen Vite deshalb auf den CJS-Build, den das Package unter der
// "require"-Condition korrekt exportiert. require.resolve liefert uns den
// absoluten Pfad — funktioniert auch bei npm-Workspaces, wo node_modules in
// den Repo-Root gehoistet wird.
const nodeRequire = createRequire(import.meta.url);
const libsodiumCjsPath = nodeRequire.resolve("libsodium-wrappers");

export default defineConfig({
  plugins: [react(), tailwindcss(), vaultchatSri()],
  resolve: {
    alias: {
      "libsodium-wrappers": libsodiumCjsPath,
    },
  },
  optimizeDeps: {
    // esbuild pre-bundled libsodium-wrappers (Dev-Server). Produziert ein
    // ESM-Modul, in dem der CJS-Namespace als lebende Referenz durchreicht,
    // nicht als snapshot — Konstanten sind dadurch nach .ready sichtbar.
    include: ["libsodium-wrappers"],
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
    sourcemap: true,
    commonjsOptions: {
      // Wichtig: der Default-Import ist der komplette module.exports
      // (nicht {default: exports}). Ohne das liefert Rollup ein doppelt
      // gewrapptes Objekt, auf dem libsodium-Konstanten nicht sichtbar sind.
      defaultIsModuleExports: true,
      // Libsodium mutiert seine Exports nach dem Laden. Rollup muss sie
      // als "dynamic require" behandeln, damit die Binding live bleibt.
      transformMixedEsModules: true,
      // Wichtige Schraube gegen den Frozen-Copy-Bug: bei require liefert der
      // Plugin die Namespace-Referenz direkt, nicht einen statischen Snapshot.
      requireReturnsDefault: "namespace",
    },
  },
});
