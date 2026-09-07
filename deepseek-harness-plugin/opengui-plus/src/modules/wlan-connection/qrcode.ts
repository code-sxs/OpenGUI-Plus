/**
 * Minimal QR Code encoder (byte mode, EC levels L/M/Q/H, versions 1-10).
 *
 * Why this exists: the mature ADB Wi-Fi tools (Android Studio's "Pair devices
 * using Wi-Fi", wadb, adb-wifi) all drive the *reverse* flow — the computer
 * renders a QR code, the phone scans it, then the phone announces itself over
 * mDNS and the computer runs `adb pair`. That flow needs no camera on the
 * computer, which is the whole reason a CLI can do it at all.
 *
 * We therefore have to generate a QR code. Doing it in-process keeps the
 * package dependency-free and makes the pairing flow work offline; the
 * alternative (shelling out to `qrencode`, or asking the user to paste phone
 * screen contents) is strictly worse.
 *
 * Implementation follows the published ISO/IEC 18004 standard: Reed-Solomon
 * over GF(256) with primitive polynomial 0x11D, the standard function-pattern
 * layout, the eight mask patterns and the four penalty rules. Versions 1-10
 * cover our payload (`WIFI:T:ADB;S:studio-XXXXXX;P:123456;;` fits in version 3
 * at level M) with plenty of headroom.
 *
 * Verified against the `qrcode` Python package: the module matrix produced for
 * a given version / EC level / mask matches bit for bit.
 *
 * @module modules/wlan-connection/qrcode
 */

import { deflateSync } from 'node:zlib'

export type QrEcLevel = 'L' | 'M' | 'Q' | 'H'

export interface QrCode {
  readonly version: number
  /** Modules per side, including the quiet-zone-free symbol area. */
  readonly size: number
  readonly ecLevel: QrEcLevel
  readonly mask: number
  /** Row-major, `size * size`; `1` is a dark module. */
  readonly modules: Uint8Array
}

/* ------------------------------------------------------------------ GF(256) */

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)

for (let i = 0, x = 1; i < 255; i += 1, x <<= 1) {
  if (x & 0x100) x ^= 0x11d
  EXP[i] = x
  LOG[x] = i
}
for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]!

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a]! + LOG[b]!]!
}

/** Multiply a polynomial (descending powers) by `(x + a)`. */
function gfPolyMul(poly: Uint8Array, a: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(poly.length + 1)
  for (let k = 0; k < out.length; k += 1) {
    const high = k < poly.length ? poly[k]! : 0
    const low = k > 0 ? gfMul(a, poly[k - 1]!) : 0
    out[k] = high ^ low
  }
  return out
}

/** Generator polynomial ∏(x − α^i) for i in [0, degree). */
function rsGenerator(degree: number): Uint8Array<ArrayBuffer> {
  let poly = new Uint8Array([1])
  for (let i = 0; i < degree; i += 1) poly = gfPolyMul(poly, EXP[i]!)
  return poly
}

/** Reed-Solomon remainder, the error correction codewords for one block. */
function rsRemainder(data: Uint8Array, ecCount: number): Uint8Array {
  const generator = rsGenerator(ecCount)
  const out = new Uint8Array(ecCount)
  for (const byte of data) {
    const factor = byte ^ out[0]!
    out.copyWithin(0, 1)
    out[ecCount - 1] = 0
    if (factor === 0) continue
    for (let i = 0; i < ecCount; i += 1) out[i] = out[i]! ^ gfMul(generator[i + 1]!, factor)
  }
  return out
}

/* ------------------------------------------------------- capacity & layout */

interface EcSpec {
  /** Error correction codewords per block. */
  readonly ecPerBlock: number
  /** Blocks in group 1 (short blocks) and their data codewords. */
  readonly group1Blocks: number
  readonly group1Data: number
  /** Blocks in group 2 (long blocks); 0 for versions without a second group. */
  readonly group2Blocks: number
  readonly group2Data: number
}

type EcTable = Readonly<Record<QrEcLevel, readonly EcSpec[]>>

/**
 * Block structure per version, indexed by `version - 1`.
 * Only levels we actually use are populated; level M is the default.
 */
const EC_TABLE: EcTable = {
  L: [
    { ecPerBlock: 7, group1Blocks: 1, group1Data: 19, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 10, group1Blocks: 1, group1Data: 34, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 15, group1Blocks: 1, group1Data: 55, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 20, group1Blocks: 1, group1Data: 80, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 26, group1Blocks: 1, group1Data: 108, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 18, group1Blocks: 2, group1Data: 68, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 20, group1Blocks: 2, group1Data: 78, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 24, group1Blocks: 2, group1Data: 97, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 30, group1Blocks: 2, group1Data: 116, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 18, group1Blocks: 2, group1Data: 68, group2Blocks: 2, group2Data: 69 },
  ],
  M: [
    { ecPerBlock: 10, group1Blocks: 1, group1Data: 16, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 16, group1Blocks: 1, group1Data: 28, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 26, group1Blocks: 1, group1Data: 44, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 18, group1Blocks: 2, group1Data: 32, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 24, group1Blocks: 2, group1Data: 43, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 16, group1Blocks: 4, group1Data: 27, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 18, group1Blocks: 4, group1Data: 31, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 22, group1Blocks: 2, group1Data: 38, group2Blocks: 2, group2Data: 39 },
    { ecPerBlock: 22, group1Blocks: 3, group1Data: 36, group2Blocks: 2, group2Data: 37 },
    { ecPerBlock: 26, group1Blocks: 4, group1Data: 43, group2Blocks: 1, group2Data: 44 },
  ],
  Q: [
    { ecPerBlock: 13, group1Blocks: 1, group1Data: 13, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 22, group1Blocks: 1, group1Data: 22, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 18, group1Blocks: 2, group1Data: 17, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 26, group1Blocks: 2, group1Data: 24, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 18, group1Blocks: 2, group1Data: 15, group2Blocks: 2, group2Data: 16 },
    { ecPerBlock: 24, group1Blocks: 4, group1Data: 19, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 18, group1Blocks: 2, group1Data: 14, group2Blocks: 4, group2Data: 15 },
    { ecPerBlock: 22, group1Blocks: 4, group1Data: 18, group2Blocks: 2, group2Data: 19 },
    { ecPerBlock: 20, group1Blocks: 4, group1Data: 16, group2Blocks: 4, group2Data: 17 },
    { ecPerBlock: 24, group1Blocks: 6, group1Data: 19, group2Blocks: 2, group2Data: 20 },
  ],
  H: [
    { ecPerBlock: 17, group1Blocks: 1, group1Data: 9, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 28, group1Blocks: 1, group1Data: 16, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 22, group1Blocks: 2, group1Data: 13, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 16, group1Blocks: 4, group1Data: 9, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 22, group1Blocks: 2, group1Data: 11, group2Blocks: 2, group2Data: 12 },
    { ecPerBlock: 28, group1Blocks: 4, group1Data: 15, group2Blocks: 0, group2Data: 0 },
    { ecPerBlock: 26, group1Blocks: 4, group1Data: 13, group2Blocks: 1, group2Data: 14 },
    { ecPerBlock: 26, group1Blocks: 4, group1Data: 14, group2Blocks: 2, group2Data: 15 },
    { ecPerBlock: 24, group1Blocks: 4, group1Data: 12, group2Blocks: 4, group2Data: 13 },
    { ecPerBlock: 28, group1Blocks: 6, group1Data: 15, group2Blocks: 2, group2Data: 16 },
  ],
}

/** Alignment pattern centre coordinates, indexed by `version - 1`. */
const ALIGNMENT: readonly (readonly number[])[] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
]

/** Remainder bits that pad the symbol; versions 1-10 only. */
function remainderBits(version: number): number {
  if (version === 1) return 0
  return version <= 6 ? 7 : 0
}

const EC_LEVEL_BITS: Readonly<Record<QrEcLevel, number>> = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 }

function dataCapacityBits(version: number, level: QrEcLevel): number {
  const spec = EC_TABLE[level][version - 1]!
  const dataCodewords = spec.group1Blocks * spec.group1Data + spec.group2Blocks * spec.group2Data
  return dataCodewords * 8
}

/** Smallest version that fits `bytes` at the given EC level. */
export function smallestVersion(byteLength: number, level: QrEcLevel): number {
  for (let version = 1; version <= 10; version += 1) {
    const headerBits = 4 + (version < 10 ? 8 : 16)
    if (dataCapacityBits(version, level) - headerBits >= byteLength * 8) return version
  }
  return -1
}

/* --------------------------------------------------------- bit stream build */

class BitBuffer {
  private readonly bits: number[] = []

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1)
  }

  get length(): number {
    return this.bits.length
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8))
    for (let i = 0; i < this.bits.length; i += 1) {
      if (this.bits[i] === 1) out[i >>> 3]! |= 0x80 >>> (i & 7)
    }
    return out
  }
}

function interleave(dataBlocks: readonly Uint8Array[], ecBlocks: readonly Uint8Array[]): Uint8Array {
  const out: number[] = []
  const maxData = Math.max(...dataBlocks.map(block => block.length))
  for (let i = 0; i < maxData; i += 1) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]!)
  }
  const maxEc = Math.max(...ecBlocks.map(block => block.length))
  for (let i = 0; i < maxEc; i += 1) {
    for (const block of ecBlocks) out.push(block[i]!)
  }
  return Uint8Array.from(out)
}

function buildCodewords(payload: Uint8Array, version: number, level: QrEcLevel): Uint8Array {
  const spec = EC_TABLE[level][version - 1]!
  const bits = new BitBuffer()
  bits.push(0b0100, 4)
  bits.push(payload.length, version < 10 ? 8 : 16)
  for (const byte of payload) bits.push(byte, 8)

  const capacity = dataCapacityBits(version, level)
  const totalCodewords = spec.group1Blocks * (spec.group1Data + spec.ecPerBlock)
    + spec.group2Blocks * (spec.group2Data + spec.ecPerBlock)
  // Data codewords total = capacity / 8; terminator plus pad bytes fill the rest.
  const dataCodewords = Math.floor(capacity / 8)

  const terminator = Math.min(4, dataCodewords * 8 - bits.length)
  bits.push(0, terminator)
  bits.push(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) bits.push(pad, 8)

  const bytes = bits.toBytes()
  if (bytes.length !== dataCodewords) {
    throw new Error(`QR 编码长度异常：期望 ${dataCodewords} 个数据码字，实际 ${bytes.length}`)
  }

  const dataBlocks: Uint8Array[] = []
  const ecBlocks: Uint8Array[] = []
  let offset = 0
  for (let i = 0; i < spec.group1Blocks; i += 1) {
    const slice = bytes.subarray(offset, offset + spec.group1Data)
    offset += spec.group1Data
    dataBlocks.push(slice)
    ecBlocks.push(rsRemainder(slice, spec.ecPerBlock))
  }
  for (let i = 0; i < spec.group2Blocks; i += 1) {
    const slice = bytes.subarray(offset, offset + spec.group2Data)
    offset += spec.group2Data
    dataBlocks.push(slice)
    ecBlocks.push(rsRemainder(slice, spec.ecPerBlock))
  }
  if (offset !== bytes.length) throw new Error('QR 分块长度与数据码字不匹配')
  void totalCodewords
  return interleave(dataBlocks, ecBlocks)
}

/* ------------------------------------------------------------ symbol layout */

function drawFinder(modules: Uint8Array, reserved: Uint8Array, size: number, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const x = cx + dx
      const y = cy + dy
      if (x < 0 || x >= size || y < 0 || y >= size) continue
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      modules[y * size + x] = dist !== 2 && dist !== 4 ? 1 : 0
      reserved[y * size + x] = 1
    }
  }
}

function drawAlignment(modules: Uint8Array, reserved: Uint8Array, size: number, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const x = cx + dx
      const y = cy + dy
      if (x < 0 || x >= size || y < 0 || y >= size) continue
      modules[y * size + x] = Math.max(Math.abs(dx), Math.abs(dy)) === 1 ? 0 : 1
      reserved[y * size + x] = 1
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0
    case 1: return y % 2 === 0
    case 2: return x % 3 === 0
    case 3: return (x + y) % 3 === 0
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5: return ((x * y) % 2 + (x * y) % 3) === 0
    case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0
    default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0
  }
}

/** Penalty rule 3 helper: the 1:1:3:1:1 finder-like run pattern. */
function finderPenalty(runs: readonly number[]): number {
  const n = runs[1]!
  const core = n > 0 && runs[2] === n && runs[3] === n * 3 && runs[4] === n && runs[5] === n
  if (!core) return 0
  return (runs[0]! >= n * 4 && runs[6]! >= n ? 1 : 0) + (runs[6]! >= n * 4 && runs[0]! >= n ? 1 : 0)
}

function penaltyScore(modules: Uint8Array, size: number): number {
  let score = 0

  const runs = new Int32Array(7)
  const scan = (get: (i: number) => number): void => {
    runs.fill(0)
    let runColor = 0
    let runLength = 0
    for (let i = 0; i < size; i += 1) {
      const color = get(i) === 1 ? 1 : 0
      if (color === runColor) {
        runLength += 1
        if (runLength === 5) score += 3
        else if (runLength > 5) score += 1
      }
      else {
        runs.copyWithin(1, 0, 6)
        runs[0] = runLength
        if (runColor === 0) score += finderPenalty(Array.from(runs)) * 40
        runColor = color
        runLength = 1
      }
    }
    runs.copyWithin(1, 0, 6)
    runs[0] = runLength
    if (runColor === 0) score += finderPenalty(Array.from(runs)) * 40
  }

  for (let y = 0; y < size; y += 1) scan(i => modules[y * size + i]!)
  for (let x = 0; x < size; x += 1) scan(i => modules[i * size + x]!)

  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const color = modules[y * size + x]
      if (color === modules[y * size + x + 1]
        && color === modules[(y + 1) * size + x]
        && color === modules[(y + 1) * size + x + 1]) score += 3
    }
  }

  let dark = 0
  for (const module of modules) if (module === 1) dark += 1
  const total = size * size
  const deviation = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
  return score + deviation * 10
}

function placeData(modules: Uint8Array, reserved: Uint8Array, size: number, codewords: Uint8Array): void {
  let bit = 0
  const total = codewords.length * 8
  // Direction alternates per column pair, starting upward — exactly mirroring
  // the reference traversal (Python `qrcode` / Nayuki): the first pair (right
  // edge) goes up, the next down, and so on, flipping once per pair.
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    // Skip the vertical timing column (column 6): shift the whole left-side
    // column pair one notch left so column 0 still receives data.
    if (right === 6) right -= 1
    for (let vert = 0; vert < size; vert += 1) {
      const y = upward ? size - 1 - vert : vert
      for (let j = 0; j < 2; j += 1) {
        const x = right - j
        if (reserved[y * size + x] === 1 || bit >= total) continue
        const value = (codewords[bit >>> 3]! >>> (7 - (bit & 7))) & 1
        modules[y * size + x] = value
        bit += 1
      }
    }
    upward = !upward
  }
}

function bchFormat(data: number): number {
  let value = data << 10
  for (let i = 14; i >= 10; i -= 1) {
    if (((value >>> i) & 1) === 0) continue
    value ^= 0b10100110111 << (i - 10)
  }
  return ((data << 10) | value) ^ 0b101010000010010
}

function bchVersion(version: number): number {
  let value = version << 12
  for (let i = 17; i >= 12; i -= 1) {
    if (((value >>> i) & 1) === 0) continue
    value ^= 0b1111100100101 << (i - 12)
  }
  return (version << 12) | value
}

/**
 * Encode text as a QR Code symbol.
 *
 * @param text Payload; encoded in byte mode, so non-ASCII becomes UTF-8 bytes.
 * @param level Error correction level; `M` balances size and robustness.
 * @param mask Force a mask pattern (0-7) for testing; omit to pick the lowest penalty.
 * @param version Force a specific symbol version (1-10); omit to pick the smallest that fits.
 */
export function encodeQr(text: string, level: QrEcLevel = 'M', mask?: number, version?: number): QrCode {
  const payload = new TextEncoder().encode(text)
  if (version !== undefined) {
    if (version < 1 || version > 10) throw new Error(`版本 ${version} 超出支持范围（1-10）`)
    if (dataCapacityBits(version, level) < 4 + 8 + payload.length * 8) {
      throw new Error(`内容过长（${payload.length} 字节），版本 ${version} 在 ${level} 级别下装不下`)
    }
  } else {
    version = smallestVersion(payload.length, level)
    if (version < 0) throw new Error(`内容过长（${payload.length} 字节），超出版本 10 在 ${level} 级别下的容量`)
  }

  const size = version * 4 + 17
  const codewords = buildCodewords(payload, version, level)
  const modules = new Uint8Array(size * size)
  const reserved = new Uint8Array(size * size)

  drawFinder(modules, reserved, size, 3, 3)
  drawFinder(modules, reserved, size, size - 4, 3)
  drawFinder(modules, reserved, size, 3, size - 4)

  // Timing pattern: only between the finders (skip the finder/separator cells).
  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0 ? 1 : 0
    modules[6 * size + i] = dark
    modules[i * size + 6] = dark
    reserved[6 * size + i] = 1
    reserved[i * size + 6] = 1
  }

  const centres = ALIGNMENT[version - 1]!
  for (let i = 0; i < centres.length; i += 1) {
    for (let j = 0; j < centres.length; j += 1) {
      const isCorner = (i === 0 && j === 0)
        || (i === 0 && j === centres.length - 1)
        || (i === centres.length - 1 && j === 0)
      if (isCorner) continue
      drawAlignment(modules, reserved, size, centres[i]!, centres[j]!)
    }
  }

  // Reserve the format / version / dark-module areas up front, so data
  // placement skips them (the data bit stream must not be polluted by cells
  // that will later carry format/version information).
  for (let i = 0; i <= 8; i += 1) {
    reserved[8 * size + i] = 1
    reserved[i * size + 8] = 1
  }
  for (let i = 0; i < 8; i += 1) {
    reserved[8 * size + (size - 1 - i)] = 1
    reserved[(size - 1 - i) * size + 8] = 1
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        reserved[(size - 11 + j) * size + i] = 1
        reserved[i * size + (size - 11 + j)] = 1
      }
    }
  }

  placeData(modules, reserved, size, codewords)

  // Pick the mask (or honour the forced one) by penalty score.
  let chosen = mask ?? -1
  if (chosen < 0) {
    let best = Number.POSITIVE_INFINITY
    for (let candidate = 0; candidate < 8; candidate += 1) {
      const trial = applyMask(modules, reserved, size, candidate)
      const score = penaltyScore(trial, size)
      if (score < best) {
        best = score
        chosen = candidate
      }
    }
  }

  const masked = applyMask(modules, reserved, size, chosen)

  // Format information: 15 bits, bit 14 (MSB) first.
  const formatBits = (EC_LEVEL_BITS[level] << 3) | chosen
  const format = bchFormat(formatBits)

  // Copy 1 — around the top-left finder. Bit 14 (MSB) goes at (8,0).
  const fmtCopy1: ReadonlyArray<readonly [number, number]> = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ]
  for (let k = 0; k < fmtCopy1.length; k += 1) {
    const [cy, cx] = fmtCopy1[k]!
    masked[cy * size + cx] = (format >>> (14 - k)) & 1
  }

  // Copy 2 — around the top-right and bottom-left finders.
  // Bits 0–7 run leftwards along row 8 (right side); bits 8–14 run upwards
  // down column 8 (bottom side).
  for (let k = 0; k < 8; k += 1) {
    const x = size - 1 - k
    masked[8 * size + x] = (format >>> k) & 1
  }
  for (let k = 0; k < 7; k += 1) {
    const y = size - 1 - k
    masked[y * size + 8] = (format >>> (14 - k)) & 1
  }

  masked[(size - 8) * size + 8] = 1 // always-dark module

  if (version >= 7) {
    const versionBits = bchVersion(version)
    for (let i = 0; i < 18; i += 1) {
      const bit = (versionBits >>> i) & 1
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      masked[b * size + a] = bit
      masked[a * size + b] = bit
    }
  }

  void remainderBits(version)
  return { version, size, ecLevel: level, mask: chosen, modules: masked }
}

function applyMask(modules: Uint8Array, reserved: Uint8Array, size: number, mask: number): Uint8Array {
  const out = Uint8Array.from(modules)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (reserved[y * size + x] === 1) continue
      if (maskBit(mask, x, y)) out[y * size + x] = out[y * size + x] === 1 ? 0 : 1
    }
  }
  return out
}

/* ----------------------------------------------------------------- rendering */

export interface AsciiOptions {
  /** Quiet zone in modules; the spec requires 4. */
  readonly quietZone?: number
  /**
   * Use half-block glyphs so two vertical modules share one character cell.
   * Terminal cells are about twice as tall as they are wide, so this keeps the
   * symbol square and therefore scannable.
   */
  readonly compact?: boolean
}

const FULL = '█'
const UPPER = '▀'
const LOWER = '▄'
const EMPTY = ' '

/** Render the symbol as text that a phone can scan straight off the terminal. */
export function renderQrAscii(code: QrCode, options: AsciiOptions = {}): string {
  const quiet = options.quietZone ?? 4
  const compact = options.compact ?? true
  const padded = padMatrix(code, quiet)
  const width = code.size + quiet * 2
  const lines: string[] = []

  const rowStep = compact ? 2 : 1
  for (let y = 0; y < width; y += rowStep) {
    let line = ''
    for (let x = 0; x < width; x += 1) {
      const top = padded[y * width + x] === 1
      if (!compact) {
        line += top ? FULL + FULL : EMPTY + EMPTY
        continue
      }
      const bottom = y + 1 < width && padded[(y + 1) * width + x] === 1
      line += top && bottom ? EMPTY : top ? UPPER : bottom ? LOWER : FULL
    }
    lines.push(line.replace(/\s+$/, ''))
  }
  return lines.join('\n')
}

function padMatrix(code: QrCode, quiet: number): Uint8Array {
  const width = code.size + quiet * 2
  const out = new Uint8Array(width * width)
  for (let y = 0; y < code.size; y += 1) {
    for (let x = 0; x < code.size; x += 1) {
      out[(y + quiet) * width + (x + quiet)] = code.modules[y * code.size + x]!
    }
  }
  return out
}

/* ----------------------------------------------------------------- PNG output */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(4)
  header[0] = (data.length >>> 24) & 0xff
  header[1] = (data.length >>> 16) & 0xff
  header[2] = (data.length >>> 8) & 0xff
  header[3] = data.length & 0xff
  const body = new Uint8Array(4 + data.length)
  for (let i = 0; i < 4; i += 1) body[i] = type.charCodeAt(i)
  body.set(data, 4)
  const crc = new Uint8Array(4)
  const value = crc32(body)
  crc[0] = (value >>> 24) & 0xff
  crc[1] = (value >>> 16) & 0xff
  crc[2] = (value >>> 8) & 0xff
  crc[3] = value & 0xff
  return Uint8Array.from([...header, ...body, ...crc])
}

/**
 * Render the symbol as a grayscale PNG.
 *
 * Uses `node:zlib` (built in) and hand-assembled PNG chunks, so there is still
 * no third-party dependency, and the console can show a real image instead of
 * asking the user to read a terminal-sized pixel blob.
 */
export function renderQrPng(code: QrCode, options: { readonly scale?: number, readonly quietZone?: number } = {}): Buffer {
  const scale = Math.max(1, Math.trunc(options.scale ?? 8))
  const quiet = options.quietZone ?? 4
  const padded = padMatrix(code, quiet)
  const width = code.size + quiet * 2
  const imageWidth = width * scale
  const imageHeight = width * scale

  // 8-bit grayscale: filter byte 0 + one byte per pixel, per scanline.
  const raw = Buffer.alloc(imageHeight * (imageWidth + 1))
  let offset = 0
  for (let y = 0; y < imageHeight; y += 1) {
    raw[offset] = 0
    offset += 1
    const row = Math.floor(y / scale)
    for (let x = 0; x < imageWidth; x += 1) {
      const dark = padded[row * width + Math.floor(x / scale)] === 1
      raw[offset] = dark ? 0 : 255
      offset += 1
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(imageWidth, 0)
  ihdr.writeUInt32BE(imageHeight, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // colour type: grayscale
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(pngChunk('IHDR', ihdr)),
    Buffer.from(pngChunk('IDAT', deflateSync(raw, { level: 9 }))),
    Buffer.from(pngChunk('IEND', new Uint8Array(0))),
  ]
  return Buffer.concat(parts)
}

/** Data URL for embedding the symbol directly in HTML (`<img src=…>`). */
export function renderQrDataUrl(code: QrCode, options?: { readonly scale?: number, readonly quietZone?: number }): string {
  return `data:image/png;base64,${renderQrPng(code, options).toString('base64')}`
}

/**
 * Debug/testing helper: the raw interleaved codewords (data + EC) for a payload.
 * Mirrors what a compliant encoder feeds into module placement, so tests can
 * assert the Reed-Solomon / bit-stream stage independently of the layout stage.
 */
export function encodeQrCodewords(text: string, level: QrEcLevel = 'M', version?: number): Uint8Array {
  const payload = new TextEncoder().encode(text)
  const v = version ?? smallestVersion(payload.length, level)
  if (v < 0) throw new Error(`内容过长，无法编码 ${text.length} 字节`)
  return buildCodewords(payload, v, level)
}
