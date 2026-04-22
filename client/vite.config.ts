import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { vaultchatSri } from "./vite-plugin-sri";

export default defineConfig({
  plugins: [react(), tailwindcss(), vaultchatSri()],
  resolve: {
    alias: {
      // libsodium-wrappers 0.7.x liefert einen kaputten ESM-Entry aus, der
      // auf eine nicht existierende ./libsodium.mjs verweist. Wir zwingen
      // Rollup deshalb explizit auf den funktionierenden CJS-Build.
      "libsodium-wrappers":
        "libsodium-wrappers/dist/modules/libsodium-wrappers.js",
    },
  },
  optimizeDeps: {
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
      // libsodium-wrappers ist CJS; Rollup muss Named-Exports draus ziehen.
      transformMixedEsModules: true,
    },
  },
});
