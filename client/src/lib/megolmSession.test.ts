/**
 * VCG6 wire-format tests + Magic-Detection. Pure encoding, kein Olm-WASM
 * nötig (deshalb immer ausführbar in CI).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isMegolmGroupCiphertext } from "./megolmSession";
import { base64FromUint8 } from "./b64";

globalThis.btoa ??= (v: string) => Buffer.from(v, "binary").toString("base64");
globalThis.atob ??= (v: string) => Buffer.from(v, "base64").toString("binary");

test("isMegolmGroupCiphertext detects VCG6 magic", () => {
  const buf = new Uint8Array([0x56, 0x43, 0x47, 0x36, 0, 0, 0, 0]);
  assert.equal(isMegolmGroupCiphertext(base64FromUint8(buf)), true);
});

test("isMegolmGroupCiphertext rejects GC2 (alter Pfad)", () => {
  const buf = new Uint8Array([0x47, 0x43, 0x32, 0]);
  assert.equal(isMegolmGroupCiphertext(base64FromUint8(buf)), false);
});

test("isMegolmGroupCiphertext rejects empty", () => {
  assert.equal(isMegolmGroupCiphertext(""), false);
});
