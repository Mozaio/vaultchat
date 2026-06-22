/**
 * i18n key-coverage guard.
 *
 * The client is built with esbuild and is NOT type-checked on deploy, so a
 * typo'd translation key (`t("chat.tile")` instead of `t("chat.title")`)
 * compiles fine and silently renders the raw key string to users. This test
 * statically scans the source for literal `t("…")` calls and asserts every
 * key exists in the DICT, turning that class of bug into a CI failure.
 *
 * Only literal-string keys are checked; dynamically built keys (template
 * literals, variables, concatenation) are skipped because they cannot be
 * verified statically — those are covered by their own unit tests where they
 * matter (e.g. notifyPrefs, plan feature keys).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { definedI18nKeys, hasI18nKey } from "./i18n";

const SRC_DIR = dirname(dirname(fileURLToPath(import.meta.url))); // .../client/src

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Match `t("key")` / `t('key')` where the argument is a single string literal.
 * Allows leading whitespace/`(` so `t (` and method-style `.t(` both match.
 * Deliberately ignores template-literal and computed keys.
 */
const T_CALL = /\bt\(\s*(["'])((?:\\.|(?!\1).)*)\1/g;

test("every literal t() key used in source exists in the DICT", () => {
  const files = walk(SRC_DIR);
  const missing = new Map<string, string[]>(); // key -> files

  for (const file of files) {
    const code = readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    T_CALL.lastIndex = 0;
    while ((m = T_CALL.exec(code)) !== null) {
      const key = m[2];
      // Heuristic: real i18n keys look like "scope.name". Skip anything that
      // doesn't, to avoid false positives from unrelated one-letter `t(` calls.
      if (!key.includes(".")) continue;
      if (!hasI18nKey(key)) {
        const rel = file.slice(SRC_DIR.length + 1);
        const list = missing.get(key) ?? [];
        if (!list.includes(rel)) list.push(rel);
        missing.set(key, list);
      }
    }
  }

  if (missing.size > 0) {
    const lines = [...missing.entries()]
      .map(([k, files]) => `  - "${k}"  (used in ${files.join(", ")})`)
      .join("\n");
    assert.fail(
      `Found ${missing.size} t() key(s) used in source but missing from i18n DICT:\n${lines}`
    );
  }
});

test("DICT has a meaningful number of keys (sanity check)", () => {
  // Guards against the scanner silently breaking and the coverage test
  // becoming a no-op.
  assert.ok(
    definedI18nKeys().length > 200,
    `expected >200 i18n keys, got ${definedI18nKeys().length}`
  );
});
