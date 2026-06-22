/**
 * Resolve-hook implementation registered by `libsodium-cjs-resolve.mjs`.
 * Redirects the bare `libsodium-wrappers-sumo` specifier to the package's
 * self-contained CJS build (the ESM build references a `.mjs` sibling the
 * package fails to ship). See the sibling file for the full rationale.
 */
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(pathToFileURL("./package.json").href);
const cjsUrl = pathToFileURL(require.resolve("libsodium-wrappers-sumo")).href;

export function resolve(specifier, context, next) {
  if (specifier === "libsodium-wrappers-sumo") {
    return { url: cjsUrl, shortCircuit: true, format: "commonjs" };
  }
  return next(specifier, context);
}
