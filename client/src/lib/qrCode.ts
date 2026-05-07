/**
 * Minimal QR-Code generator for VaultChat safety numbers.
 *
 * - Numeric mode only (digits 0-9), Error-Correction Level M (~15% recovery)
 * - Versions 1-10 (covers up to 564 digits, plenty for 60-digit safety numbers)
 * - Pure TypeScript, no dependencies, no network
 *
 * Implements ISO/IEC 18004:2015 enough for our use case. Returns a square
 * boolean matrix where `true` = dark module.
 */

// ─────────────────────────────────────────────────────────────────
// EC-M block layout: [numBlocks, dataCodewordsPerBlock, eccCodewordsPerBlock]
// Source: ISO/IEC 18004 Table 9 (EC level M).
// For versions where data is split into 2 groups, both groups are listed.
// ─────────────────────────────────────────────────────────────────
const EC_M_BLOCKS: Record<number, ReadonlyArray<readonly [number, number, number]>> = {
  1: [[1, 16, 10]],
  2: [[1, 28, 16]],
  3: [[1, 44, 26]],
  4: [[2, 32, 18]],
  5: [[2, 43, 24]],
  6: [[4, 27, 16]],
  7: [[4, 31, 18]],
  8: [[2, 38, 22], [2, 39, 22]],
  9: [[3, 36, 22], [2, 37, 22]],
  10: [[4, 43, 26], [1, 44, 26]],
};

// Numeric-mode capacity at EC-M (digits) per version 1..10.
const NUMERIC_CAPACITY_M: ReadonlyArray<number> = [
  /* v1 */ 34, 63, 101, 149, 202, 255, 322, 391, 478, 564,
];

// Alignment-pattern centers per version 2..10 (version 1 has none).
// Each entry is the list of row/column coordinates used for the grid.
const ALIGNMENT_CENTERS: Record<number, ReadonlyArray<number>> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

// ─────────────────────────────────────────────────────────────────
// Galois field GF(256) with primitive polynomial 0x11D (QR standard).
// ─────────────────────────────────────────────────────────────────
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

// Build Reed-Solomon generator polynomial of given degree.
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]!;
      next[j + 1] = gfMul(poly[j]!, GF_EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

// Compute ECC codewords for a data block.
function rsEncode(data: Uint8Array, eccLen: number): Uint8Array {
  const gen = rsGenerator(eccLen);
  const result = new Uint8Array(eccLen);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i]! ^ result[0]!;
    for (let j = 0; j < eccLen - 1; j++) {
      result[j] = result[j + 1]! ^ gfMul(gen[j + 1]!, factor);
    }
    result[eccLen - 1] = gfMul(gen[eccLen]!, factor);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────
// Numeric-mode encoding: groups of 3 digits → 10 bits, 2 → 7, 1 → 4.
// ─────────────────────────────────────────────────────────────────
class BitBuffer {
  private bits: number[] = [];
  appendBits(value: number, len: number) {
    for (let i = len - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 1);
    }
  }
  length(): number {
    return this.bits.length;
  }
  toBytes(): Uint8Array {
    while (this.bits.length % 8 !== 0) this.bits.push(0);
    const out = new Uint8Array(this.bits.length / 8);
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i]!) out[i >>> 3]! |= 0x80 >>> (i & 7);
    }
    return out;
  }
}

function encodeNumeric(digits: string, version: number): Uint8Array {
  if (!/^[0-9]*$/.test(digits)) {
    throw new Error("qr: numeric mode requires digits only");
  }
  const buf = new BitBuffer();
  // Mode indicator for numeric = 0001
  buf.appendBits(0b0001, 4);
  // Character count indicator: v1-9 → 10 bits, v10-26 → 12, v27-40 → 14
  const ccLen = version <= 9 ? 10 : version <= 26 ? 12 : 14;
  buf.appendBits(digits.length, ccLen);
  // Data: groups of 3 digits → 10 bits, 2 → 7, 1 → 4
  for (let i = 0; i < digits.length; i += 3) {
    const chunk = digits.slice(i, i + 3);
    const value = parseInt(chunk, 10);
    if (chunk.length === 3) buf.appendBits(value, 10);
    else if (chunk.length === 2) buf.appendBits(value, 7);
    else buf.appendBits(value, 4);
  }
  // Total data codewords for this version (sum of data per block).
  const blocks = EC_M_BLOCKS[version]!;
  let totalData = 0;
  for (const [n, d] of blocks) totalData += n * d;
  const totalBits = totalData * 8;
  // Terminator (up to 4 zeros)
  const remainder = totalBits - buf.length();
  if (remainder < 0) throw new Error("qr: data overflow");
  buf.appendBits(0, Math.min(4, remainder));
  // Pad to byte boundary
  while (buf.length() % 8 !== 0) buf.appendBits(0, 1);
  // Pad with alternating 0xEC, 0x11
  const bytes = buf.toBytes();
  const padded = new Uint8Array(totalData);
  padded.set(bytes);
  for (let i = bytes.length, alt = 0; i < totalData; i++, alt++) {
    padded[i] = alt % 2 === 0 ? 0xec : 0x11;
  }
  return padded;
}

// Pick smallest version where the encoded numeric data fits at EC-M.
function chooseVersion(digits: string): number {
  for (let v = 1; v <= 10; v++) {
    if (digits.length <= NUMERIC_CAPACITY_M[v - 1]!) return v;
  }
  throw new Error("qr: input too long for v1-10");
}

// Interleave data and ECC blocks per QR spec.
function buildCodewordStream(version: number, data: Uint8Array): Uint8Array {
  const blocks = EC_M_BLOCKS[version]!;
  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const [n, dLen, eLen] of blocks) {
    for (let i = 0; i < n; i++) {
      const block = data.slice(offset, offset + dLen);
      dataBlocks.push(block);
      eccBlocks.push(rsEncode(block, eLen));
      offset += dLen;
    }
  }
  // Interleave data: column-wise across all blocks.
  let maxData = 0;
  for (const b of dataBlocks) if (b.length > maxData) maxData = b.length;
  let maxEcc = 0;
  for (const b of eccBlocks) if (b.length > maxEcc) maxEcc = b.length;
  const out: number[] = [];
  for (let col = 0; col < maxData; col++) {
    for (const b of dataBlocks) {
      if (col < b.length) out.push(b[col]!);
    }
  }
  for (let col = 0; col < maxEcc; col++) {
    for (const b of eccBlocks) {
      if (col < b.length) out.push(b[col]!);
    }
  }
  return new Uint8Array(out);
}

// ─────────────────────────────────────────────────────────────────
// Matrix construction
// ─────────────────────────────────────────────────────────────────
type Matrix = { mods: Uint8Array; reserved: Uint8Array; size: number };

function newMatrix(size: number): Matrix {
  return {
    mods: new Uint8Array(size * size),
    reserved: new Uint8Array(size * size),
    size,
  };
}

function setModule(m: Matrix, x: number, y: number, dark: boolean) {
  m.mods[y * m.size + x] = dark ? 1 : 0;
}
function getModule(m: Matrix, x: number, y: number): number {
  return m.mods[y * m.size + x]!;
}
function reserve(m: Matrix, x: number, y: number) {
  m.reserved[y * m.size + x] = 1;
}
function isReserved(m: Matrix, x: number, y: number): boolean {
  return m.reserved[y * m.size + x] === 1;
}

function placeFinderPattern(m: Matrix, x: number, y: number) {
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= m.size || ny >= m.size) continue;
      const inOuter = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      const onEdge =
        dx === 0 || dx === 6 || dy === 0 || dy === 6;
      const inCenter = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      const dark = inOuter && (onEdge || inCenter);
      setModule(m, nx, ny, dark);
      reserve(m, nx, ny);
    }
  }
}

function placeAlignmentPattern(m: Matrix, cx: number, cy: number) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const max = Math.max(Math.abs(dx), Math.abs(dy));
      const dark = max !== 1;
      setModule(m, cx + dx, cy + dy, dark);
      reserve(m, cx + dx, cy + dy);
    }
  }
}

function placeTimingPatterns(m: Matrix) {
  for (let i = 8; i < m.size - 8; i++) {
    const dark = i % 2 === 0;
    setModule(m, i, 6, dark);
    reserve(m, i, 6);
    setModule(m, 6, i, dark);
    reserve(m, 6, i);
  }
}

function placeFunctionPatterns(m: Matrix, version: number) {
  const sz = m.size;
  // Three finder patterns + separators
  placeFinderPattern(m, 0, 0);
  placeFinderPattern(m, sz - 7, 0);
  placeFinderPattern(m, 0, sz - 7);
  // Separators are reserved by placeFinderPattern (dx/dy from -1 to 7).
  // Timing patterns
  placeTimingPatterns(m);
  // Dark module + format info reservation
  setModule(m, 8, sz - 8, true);
  reserve(m, 8, sz - 8);
  // Reserve format info zones (15 modules each, near top-left + others)
  for (let i = 0; i <= 8; i++) {
    if (!isReserved(m, i, 8)) reserve(m, i, 8);
    if (!isReserved(m, 8, i)) reserve(m, 8, i);
  }
  for (let i = 0; i < 8; i++) {
    reserve(m, sz - 1 - i, 8);
    reserve(m, 8, sz - 1 - i);
  }
  // Alignment patterns (skip those overlapping finders)
  const centers = ALIGNMENT_CENTERS[version]!;
  for (const cy of centers) {
    for (const cx of centers) {
      // Skip patterns that overlap finder corners
      if (
        (cx === 6 && cy === 6) ||
        (cx === 6 && cy === sz - 7) ||
        (cx === sz - 7 && cy === 6)
      ) {
        continue;
      }
      placeAlignmentPattern(m, cx, cy);
    }
  }
  // Version info reservation (only v7+)
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = Math.floor(i / 3);
      const b = (i % 3) + sz - 11;
      reserve(m, a, b);
      reserve(m, b, a);
    }
  }
}

// Place data codewords in zigzag pattern, applying mask, skipping reserved.
function placeData(m: Matrix, data: Uint8Array, mask: number) {
  const sz = m.size;
  let bitIdx = 0;
  // Process pairs of columns from right to left, skipping vertical timing col 6
  for (let xRight = sz - 1; xRight >= 1; xRight -= 2) {
    if (xRight === 6) xRight = 5;
    // For each row of this column pair, bottom-up or top-down alternating
    for (let vert = 0; vert < sz; vert++) {
      for (let dx = 0; dx <= 1; dx++) {
        const goingUp = ((xRight + 1) & 2) === 0;
        const x = xRight - dx;
        const y = goingUp ? sz - 1 - vert : vert;
        if (isReserved(m, x, y)) continue;
        const byte = data[bitIdx >>> 3] ?? 0;
        let bit = ((byte >>> (7 - (bitIdx & 7))) & 1) === 1;
        if (applyMask(mask, x, y)) bit = !bit;
        setModule(m, x, y, bit);
        bitIdx++;
      }
    }
  }
}

function applyMask(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new Error("qr: invalid mask");
  }
}

// ─────────────────────────────────────────────────────────────────
// Format / version info (BCH-encoded)
// ─────────────────────────────────────────────────────────────────
function bchEncode(data: number, generator: number, dataBits: number, ecBits: number): number {
  let d = data << ecBits;
  for (let i = dataBits - 1; i >= 0; i--) {
    if ((d >>> (i + ecBits)) & 1) {
      d ^= generator << i;
    }
  }
  return (data << ecBits) | (d & ((1 << ecBits) - 1));
}

// EC level M = 0b00, format = (ECbits << 3) | mask
function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask;
  const bits = bchEncode(data, 0b10100110111, 5, 10);
  return bits ^ 0b101010000010010;
}

function placeFormatInfo(m: Matrix, mask: number) {
  const sz = m.size;
  const bits = formatBits(mask);
  // Top-left strip
  for (let i = 0; i <= 5; i++) setModule(m, 8, i, ((bits >>> i) & 1) === 1);
  setModule(m, 8, 7, ((bits >>> 6) & 1) === 1);
  setModule(m, 8, 8, ((bits >>> 7) & 1) === 1);
  setModule(m, 7, 8, ((bits >>> 8) & 1) === 1);
  for (let i = 9; i <= 14; i++) setModule(m, 14 - i, 8, ((bits >>> i) & 1) === 1);
  // Bottom-left + top-right strip
  for (let i = 0; i <= 7; i++) setModule(m, sz - 1 - i, 8, ((bits >>> i) & 1) === 1);
  for (let i = 8; i <= 14; i++) setModule(m, 8, sz - 15 + i, ((bits >>> i) & 1) === 1);
  setModule(m, 8, sz - 8, true); // dark module
}

function placeVersionInfo(m: Matrix, version: number) {
  if (version < 7) return;
  const sz = m.size;
  const bits = bchEncode(version, 0b1111100100101, 6, 12);
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) === 1;
    const a = Math.floor(i / 3);
    const b = (i % 3) + sz - 11;
    setModule(m, a, b, bit);
    setModule(m, b, a, bit);
  }
}

// ─────────────────────────────────────────────────────────────────
// Mask penalty (ISO/IEC 18004 §7.8.3)
// ─────────────────────────────────────────────────────────────────
function maskPenalty(m: Matrix): number {
  const sz = m.size;
  let penalty = 0;
  // Rule 1: runs of 5+ same color in row/col
  for (let y = 0; y < sz; y++) {
    let runColor = -1;
    let runLen = 0;
    for (let x = 0; x < sz; x++) {
      const c = getModule(m, x, y);
      if (c === runColor) {
        runLen++;
        if (runLen === 5) penalty += 3;
        else if (runLen > 5) penalty += 1;
      } else {
        runColor = c;
        runLen = 1;
      }
    }
  }
  for (let x = 0; x < sz; x++) {
    let runColor = -1;
    let runLen = 0;
    for (let y = 0; y < sz; y++) {
      const c = getModule(m, x, y);
      if (c === runColor) {
        runLen++;
        if (runLen === 5) penalty += 3;
        else if (runLen > 5) penalty += 1;
      } else {
        runColor = c;
        runLen = 1;
      }
    }
  }
  // Rule 2: 2x2 blocks of same color
  for (let y = 0; y < sz - 1; y++) {
    for (let x = 0; x < sz - 1; x++) {
      const c = getModule(m, x, y);
      if (
        getModule(m, x + 1, y) === c &&
        getModule(m, x, y + 1) === c &&
        getModule(m, x + 1, y + 1) === c
      ) {
        penalty += 3;
      }
    }
  }
  // Rule 3: finder-like patterns 1:1:3:1:1
  const pattern = [1, 0, 1, 1, 1, 0, 1];
  for (let y = 0; y < sz; y++) {
    for (let x = 0; x <= sz - 7; x++) {
      let match = true;
      for (let i = 0; i < 7; i++) {
        if (getModule(m, x + i, y) !== pattern[i]) {
          match = false;
          break;
        }
      }
      if (match) penalty += 40;
    }
  }
  for (let x = 0; x < sz; x++) {
    for (let y = 0; y <= sz - 7; y++) {
      let match = true;
      for (let i = 0; i < 7; i++) {
        if (getModule(m, x, y + i) !== pattern[i]) {
          match = false;
          break;
        }
      }
      if (match) penalty += 40;
    }
  }
  // Rule 4: dark/total proportion
  let dark = 0;
  for (let i = 0; i < m.mods.length; i++) if (m.mods[i]) dark++;
  const total = sz * sz;
  const ratio = (dark * 100) / total;
  const dev = Math.floor(Math.abs(ratio - 50) / 5);
  penalty += dev * 10;
  return penalty;
}

// ─────────────────────────────────────────────────────────────────
// Public entry: encode numeric digit string as QR matrix.
// ─────────────────────────────────────────────────────────────────
export function generateQrMatrix(digits: string): boolean[][] {
  const version = chooseVersion(digits);
  const data = encodeNumeric(digits, version);
  const stream = buildCodewordStream(version, data);
  const size = 17 + 4 * version;
  // Try all 8 masks, pick best.
  let best: { matrix: Matrix; penalty: number; mask: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = newMatrix(size);
    placeFunctionPatterns(m, version);
    placeData(m, stream, mask);
    placeFormatInfo(m, mask);
    placeVersionInfo(m, version);
    const p = maskPenalty(m);
    if (!best || p < best.penalty) {
      best = { matrix: m, penalty: p, mask };
    }
  }
  // Convert to boolean[][] for caller convenience.
  const out: boolean[][] = [];
  const m = best!.matrix;
  for (let y = 0; y < size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x++) row.push(m.mods[y * size + x] === 1);
    out.push(row);
  }
  return out;
}
