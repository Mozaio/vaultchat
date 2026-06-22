/**
 * Test-only ESM resolve hook for `libsodium-wrappers-sumo`.
 *
 * Why this exists
 * ===============
 * The published `libsodium-wrappers-sumo` package declares an ESM `module`
 * entry (`dist/modules-sumo-esm/libsodium-wrappers.mjs`) that does
 * `import e from "./libsodium-sumo.mjs"` — but that sibling `.mjs` file is NOT
 * shipped in the package (only the CJS build under `dist/modules-sumo/` is
 * self-contained). Under a pure-ESM loader (Node's test runner via `tsx`),
 * resolving the package by its `import` condition therefore fails with
 * ERR_MODULE_NOT_FOUND for the missing sibling, which breaks every test that
 * touches libsodium (sealed sender, Olm/Megolm, backup, profile crypto …).
 *
 * The Vite app build already sidesteps this by aliasing the package to its CJS
 * file (see `vite.config.ts`, `nodeRequire.resolve("libsodium-wrappers-sumo")`
 * → `dist/modules-sumo/libsodium-wrappers.js`). This hook does the exact same
 * thing for the Node/`tsx` test runner: it redirects the bare specifier to the
 * working CJS build BEFORE tsx resolves it to the broken `.mjs`.
 *
 * It must be registered *before* tsx so it is the innermost resolver, e.g.:
 *   node --import ./test/libsodium-cjs-resolve.mjs --import tsx --test …
 *
 * This is test-only plumbing — production (Vite/esbuild) is unaffected.
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./test/libsodium-cjs-resolve-impl.mjs", pathToFileURL("./").href);
