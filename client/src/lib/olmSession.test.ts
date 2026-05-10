/**
 * Pure VCO5 wire-format tests (kein Olm-WASM nötig).
 *
 * encodeVco5/decodeVco5/isOlmCiphertext sind reine Byte-Operationen —
 * Tests laufen ohne Olm-init und sind damit immer ausführbar (auch in
 * stripped CI-Envs).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeVco5,
  decodeVco5,
  isOlmCiphertext,
} from "./olmSession";
import { base64FromUint8 } from "./b64";

globalThis.btoa ??= (v: string) => Buffer.from(v, "binary").toString("base64");
globalThis.atob ??= (v: string) => Buffer.from(v, "base64").toString("binary");

test("VCO5 encode/decode roundtrips", () => {
  const enc = encodeVco5(0, "hello");
  const { type, body } = decodeVco5(enc);
  assert.equal(type, 0);
  assert.equal(body, "hello");
});

test("VCO5 encode preserves type=1", () => {
  const enc = encodeVco5(1, "another");
  const { type, body } = decodeVco5(enc);
  assert.equal(type, 1);
  assert.equal(body, "another");
});

test("VCO5 wire too short throws", () => {
  assert.throws(() => decodeVco5(new Uint8Array([0x56, 0x43, 0x4f, 0x35])));
});

test("VCO5 bad magic throws", () => {
  assert.throws(() => decodeVco5(new Uint8Array([0x00, 0x00, 0x00, 0x00, 1, 0x61])));
});

test("VCO5 bad type byte throws", () => {
  const buf = new Uint8Array([0x56, 0x43, 0x4f, 0x35, 0x99, 0x61]);
  assert.throws(() => decodeVco5(buf));
});

test("isOlmCiphertext detects VCO5-magic in base64", () => {
  const wire = encodeVco5(0, "x");
  const b64 = base64FromUint8(wire);
  assert.equal(isOlmCiphertext(b64), true);
});

test("isOlmCiphertext rejects DR magic (VCD4)", () => {
  // VCD4 = 0x56 0x43 0x44 0x34
  const dr = new Uint8Array([0x56, 0x43, 0x44, 0x34, 0x01, 0x02, 0x03]);
  assert.equal(isOlmCiphertext(base64FromUint8(dr)), false);
});

test("isOlmCiphertext rejects garbage", () => {
  assert.equal(isOlmCiphertext("not-base64-!@#"), false);
  assert.equal(isOlmCiphertext(""), false);
});
