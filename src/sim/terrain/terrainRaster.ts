// Terrarium DEM decode + elevation sampling (REALISM_ROADMAP WP-4 / §4.3).
//
// Turns the committed `terrain.png` fixture into a Float32Array of metres MSL and samples it
// bilinearly. Everything here is a pure function of its inputs — no wall clock, no Math.random,
// no I/O — because §3 makes elevation lookup part of the deterministic kernel: WP-4 puts an
// elevation lookup inside every altitude computation, so if this module were order-dependent it
// would break replay, sub-stepping and frame catch-up everywhere at once.
//
// ---------------------------------------------------------------------------------------
// WHY A HAND-WRITTEN PNG DECODER
//
// The obvious decode path is a DOM canvas (`drawImage` + `getImageData`). It is unusable here:
//   * vitest runs the sim specs in the node environment by default — there is no canvas;
//   * canvas colour management can premultiply or colour-convert, which silently corrupts a
//     raster whose RGB triples are *numbers*, not colours;
//   * it is async and DOM-coupled, and elevation lookup has to be synchronous and pure.
//
// The alternatives were a runtime dependency (pngjs/upng) or this. The sim currently has ZERO
// runtime dependencies of its own, which is a property worth more than the ~230 lines below —
// so DEFLATE (RFC 1951) and the PNG scanline filters (RFC 2083) are implemented here directly.
// Both are frozen, fully specified formats: this code cannot bit-rot against a moving upstream.
// `src/tests/terrainRaster.spec.ts` pins it by decoding the committed fixture and asserting the
// inflate output is byte-identical to node's own zlib over the whole IDAT stream, so the
// hand-rolled path is continuously proved against the canonical implementation.
//
// The DEFLATE decoder follows the structure of zlib's reference "puff" — counts/symbols
// canonical Huffman tables, decoded a bit at a time. Deliberately the simple form rather than a
// fast multi-bit table: it runs once per fixture (~15 ms for the 664×665 Grizzly Peak raster),
// the result is cached, and correctness is worth far more than throughput here.
//
// SURFACE SEMANTICS (§4.2). These elevations are BARE EARTH — a DTM, not a DSM. Buildings and
// canopy are not in this surface and must not be added to it; they arrive separately as extruded
// footprints (§4.4) so they stay testable as discrete obstacles. If a DSM were ever substituted
// here, AGL would silently become height-above-roof and every altitude computation over a city
// would be wrong. See `surface` on the header, which the fixture pipeline fills in honestly.

/** Geo header emitted alongside `terrain.png` by tools/fixtures/terrain.mjs. */
export interface TerrainHeader {
  format: string
  width: number
  height: number
  zoom: number
  bounds: { west: number; south: number; east: number; north: number }
  metersPerPixel: number
  surface: string
  elevationRangeM: { min: number; max: number }
  verticalQuantumM?: number
  /** Absolute Web-Mercator pixel origin of the crop — enables lossless MapLibre re-tiles. */
  mercatorPixelOrigin?: { x: number; y: number }
}

/** A decoded DEM: metres MSL, row-major, row 0 = north edge, column 0 = west edge. */
export interface TerrainRaster {
  readonly width: number
  readonly height: number
  readonly bounds: { west: number; south: number; east: number; north: number }
  readonly metersPerPixel: number
  /** Bare-earth vs blended-surface honesty flag, carried from the fixture manifest (§4.2). */
  readonly surface: string
  readonly minElevationM: number
  readonly maxElevationM: number
  readonly elevations: Float32Array
}

/** A position in the sim's world frame: geographic position plus altitude in metres MSL. */
export interface Point3D {
  lat: number
  lng: number
  altMslM: number
}

// ---------------------------------------------------------------------------------------
// Web-Mercator mapping
// ---------------------------------------------------------------------------------------

const MAX_MERCATOR_LAT = 85.05112878

/**
 * Normalised Web-Mercator Y for a latitude, in the same [0,1] space the tile pyramid uses.
 *
 * This projection is the whole reason latitude cannot be linearly interpolated down the raster:
 * the rows are evenly spaced in Mercator Y, not in degrees. At this AO's latitude, treating the
 * raster as linear in latitude would misplace samples by a growing fraction of a pixel toward
 * the edges — i.e. read the elevation of the wrong hillside.
 */
function mercatorY(lat: number): number {
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat))
  const phi = (clamped * Math.PI) / 180
  return (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2
}

// ---------------------------------------------------------------------------------------
// DEFLATE (RFC 1951)
// ---------------------------------------------------------------------------------------

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
]
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
]
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

interface Huffman {
  counts: Int32Array
  symbols: Int32Array
}

/** Canonical Huffman table from a code-length vector (puff's counts/symbols form). */
function buildHuffman(lengths: Int32Array | number[]): Huffman {
  const counts = new Int32Array(16)
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]]++
  counts[0] = 0
  const offsets = new Int32Array(16)
  for (let len = 1; len < 16; len++) offsets[len] = offsets[len - 1] + counts[len - 1]
  const symbols = new Int32Array(lengths.length)
  for (let sym = 0; sym < lengths.length; sym++) {
    if (lengths[sym]) symbols[offsets[lengths[sym]]++] = sym
  }
  return { counts, symbols }
}

class BitReader {
  private pos = 0
  private bitBuf = 0
  private bitCount = 0
  constructor(private readonly data: Uint8Array) {}

  /** One bit, LSB-first within each byte — DEFLATE's bit order. */
  bit(): number {
    if (this.bitCount === 0) {
      if (this.pos >= this.data.length) throw new Error('deflate: out of input')
      this.bitBuf = this.data[this.pos++]
      this.bitCount = 8
    }
    const b = this.bitBuf & 1
    this.bitBuf >>= 1
    this.bitCount--
    return b
  }

  bits(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) v |= this.bit() << i
    return v
  }

  /** Drop to the next byte boundary and return the current byte offset (stored blocks). */
  alignToByte(): number {
    this.bitCount = 0
    this.bitBuf = 0
    return this.pos
  }

  seek(pos: number): void {
    this.pos = pos
    this.bitCount = 0
    this.bitBuf = 0
  }

  decode(h: Huffman): number {
    let code = 0
    let first = 0
    let index = 0
    for (let len = 1; len <= 15; len++) {
      code |= this.bit()
      const count = h.counts[len]
      if (code - first < count) return h.symbols[index + (code - first)]
      index += count
      first = (first + count) << 1
      code <<= 1
    }
    throw new Error('deflate: invalid Huffman code')
  }
}

let fixedLit: Huffman | null = null
let fixedDist: Huffman | null = null

/**
 * The RFC 1951 fixed code tables. Memoised, and safe to memoise: they are constants derived
 * from the spec, identical on every call, so this cannot introduce order dependence.
 */
function fixedTables(): { lit: Huffman; dist: Huffman } {
  if (!fixedLit || !fixedDist) {
    const lit = new Int32Array(288)
    for (let i = 0; i < 144; i++) lit[i] = 8
    for (let i = 144; i < 256; i++) lit[i] = 9
    for (let i = 256; i < 280; i++) lit[i] = 7
    for (let i = 280; i < 288; i++) lit[i] = 8
    fixedLit = buildHuffman(lit)
    fixedDist = buildHuffman(new Int32Array(30).fill(5))
  }
  return { lit: fixedLit, dist: fixedDist }
}

/** Inflate a raw DEFLATE stream (RFC 1951). `sizeHint` pre-sizes the output buffer. */
export function inflateRaw(input: Uint8Array, sizeHint = 0): Uint8Array {
  const br = new BitReader(input)
  let out = new Uint8Array(Math.max(sizeHint, 1024))
  let len = 0

  const ensure = (extra: number) => {
    if (len + extra <= out.length) return
    let cap = out.length * 2
    while (cap < len + extra) cap *= 2
    const next = new Uint8Array(cap)
    next.set(out.subarray(0, len))
    out = next
  }

  for (;;) {
    const final = br.bit()
    const type = br.bits(2)

    if (type === 0) {
      // Stored: byte-aligned, LEN then its one's complement.
      const p = br.alignToByte()
      if (p + 4 > input.length) throw new Error('deflate: truncated stored block')
      const blockLen = input[p] | (input[p + 1] << 8)
      const nlen = input[p + 2] | (input[p + 3] << 8)
      if ((blockLen ^ 0xffff) !== nlen) throw new Error('deflate: stored block length mismatch')
      ensure(blockLen)
      out.set(input.subarray(p + 4, p + 4 + blockLen), len)
      len += blockLen
      br.seek(p + 4 + blockLen)
    } else if (type === 1 || type === 2) {
      let lit: Huffman
      let dist: Huffman
      if (type === 1) {
        const t = fixedTables()
        lit = t.lit
        dist = t.dist
      } else {
        const hlit = br.bits(5) + 257
        const hdist = br.bits(5) + 1
        const hclen = br.bits(4) + 4
        const clLengths = new Int32Array(19)
        for (let i = 0; i < hclen; i++) clLengths[CODE_LENGTH_ORDER[i]] = br.bits(3)
        const clTable = buildHuffman(clLengths)

        const lengths = new Int32Array(hlit + hdist)
        let i = 0
        while (i < lengths.length) {
          const sym = br.decode(clTable)
          if (sym < 16) {
            lengths[i++] = sym
          } else if (sym === 16) {
            if (i === 0) throw new Error('deflate: repeat with no previous length')
            const prev = lengths[i - 1]
            let repeat = 3 + br.bits(2)
            while (repeat-- > 0 && i < lengths.length) lengths[i++] = prev
          } else if (sym === 17) {
            let repeat = 3 + br.bits(3)
            while (repeat-- > 0 && i < lengths.length) lengths[i++] = 0
          } else {
            let repeat = 11 + br.bits(7)
            while (repeat-- > 0 && i < lengths.length) lengths[i++] = 0
          }
        }
        lit = buildHuffman(lengths.subarray(0, hlit))
        dist = buildHuffman(lengths.subarray(hlit))
      }

      for (;;) {
        const sym = br.decode(lit)
        if (sym < 256) {
          ensure(1)
          out[len++] = sym
        } else if (sym === 256) {
          break
        } else {
          const li = sym - 257
          if (li >= LENGTH_BASE.length) throw new Error('deflate: invalid length symbol')
          const copyLen = LENGTH_BASE[li] + br.bits(LENGTH_EXTRA[li])
          const dsym = br.decode(dist)
          if (dsym >= DIST_BASE.length) throw new Error('deflate: invalid distance symbol')
          const distance = DIST_BASE[dsym] + br.bits(DIST_EXTRA[dsym])
          if (distance > len) throw new Error('deflate: distance before start of output')
          ensure(copyLen)
          let from = len - distance
          for (let k = 0; k < copyLen; k++) out[len++] = out[from++]
        }
      }
    } else {
      throw new Error('deflate: reserved block type')
    }

    if (final) break
  }

  return out.subarray(0, len)
}

/** Strip the 2-byte zlib header (RFC 1950) and inflate the DEFLATE payload inside. */
export function inflateZlib(input: Uint8Array, sizeHint = 0): Uint8Array {
  if (input.length < 2) throw new Error('zlib: stream too short')
  const cmf = input[0]
  if ((cmf & 0x0f) !== 8) throw new Error(`zlib: unsupported compression method ${cmf & 0x0f}`)
  if (((cmf << 8) | input[1]) % 31 !== 0) throw new Error('zlib: bad header check')
  if (input[1] & 0x20) throw new Error('zlib: preset dictionary unsupported')
  return inflateRaw(input.subarray(2), sizeHint)
}

// ---------------------------------------------------------------------------------------
// PNG (RFC 2083) — 8-bit, non-interlaced, RGB or RGBA only
// ---------------------------------------------------------------------------------------

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

interface DecodedPng {
  width: number
  height: number
  channels: number
  pixels: Uint8Array
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Decode an 8-bit non-interlaced PNG. Narrow on purpose — this only ever reads our own fixture. */
export function decodePng(bytes: Uint8Array): DecodedPng {
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) throw new Error('not a PNG')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let off = 8
  let width = 0
  let height = 0
  let channels = 0
  const idatParts: Uint8Array[] = []
  let idatTotal = 0

  while (off + 8 <= bytes.length) {
    const len = view.getUint32(off)
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7])
    const start = off + 8
    if (type === 'IHDR') {
      width = view.getUint32(start)
      height = view.getUint32(start + 4)
      const bitDepth = bytes[start + 8]
      const colorType = bytes[start + 9]
      const interlace = bytes[start + 12]
      if (bitDepth !== 8) throw new Error(`PNG bit depth ${bitDepth} unsupported`)
      if (interlace !== 0) throw new Error('interlaced PNG unsupported')
      channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0
      if (!channels) throw new Error(`PNG colour type ${colorType} unsupported`)
    } else if (type === 'IDAT') {
      const part = bytes.subarray(start, start + len)
      idatParts.push(part)
      idatTotal += part.length
    } else if (type === 'IEND') {
      break
    }
    off = start + len + 4 // + CRC; CRC is not verified — the bytes are committed, not fetched
  }

  if (!width || !height) throw new Error('PNG missing IHDR')

  let compressed: Uint8Array
  if (idatParts.length === 1) {
    compressed = idatParts[0]
  } else {
    compressed = new Uint8Array(idatTotal)
    let p = 0
    for (const part of idatParts) {
      compressed.set(part, p)
      p += part.length
    }
  }

  const stride = width * channels
  const raw = inflateZlib(compressed, (stride + 1) * height)
  if (raw.length < (stride + 1) * height) throw new Error('PNG: short scanline data')

  // Reverse the five per-scanline filters in place into a tight pixel buffer.
  const pixels = new Uint8Array(stride * height)
  let p = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]
    const rowStart = y * stride
    const prevStart = rowStart - stride
    for (let i = 0; i < stride; i++) {
      const x = raw[p + i]
      const a = i >= channels ? pixels[rowStart + i - channels] : 0
      const b = y > 0 ? pixels[prevStart + i] : 0
      const c = y > 0 && i >= channels ? pixels[prevStart + i - channels] : 0
      let v: number
      switch (filter) {
        case 0: v = x; break
        case 1: v = x + a; break
        case 2: v = x + b; break
        case 3: v = x + ((a + b) >> 1); break
        case 4: v = x + paeth(a, b, c); break
        default: throw new Error(`PNG: bad filter type ${filter}`)
      }
      pixels[rowStart + i] = v & 0xff
    }
    p += stride
  }

  return { width, height, channels, pixels }
}

// ---------------------------------------------------------------------------------------
// Terrarium decode
// ---------------------------------------------------------------------------------------

/** The Terrarium relation, identical to the encoder in tools/fixtures/terrain.mjs. */
export function terrariumToMeters(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768
}

/** Decode a Terrarium PNG plus its geo header into a sampleable raster. */
export function decodeTerrariumPng(png: Uint8Array, header: TerrainHeader): TerrainRaster {
  const img = decodePng(png)
  // The PNG's own IHDR is authoritative; the header is cross-checked so a fixture that was
  // regenerated at a different size can never be silently mis-sampled against a stale header.
  if (img.width !== header.width || img.height !== header.height) {
    throw new Error(
      `terrain fixture mismatch: PNG is ${img.width}×${img.height}, header says ${header.width}×${header.height}`,
    )
  }
  const count = img.width * img.height
  const elevations = new Float32Array(count)
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < count; i++) {
    const o = i * img.channels
    const m = terrariumToMeters(img.pixels[o], img.pixels[o + 1], img.pixels[o + 2])
    elevations[i] = m
    if (m < min) min = m
    if (m > max) max = m
  }
  return {
    width: img.width,
    height: img.height,
    bounds: header.bounds,
    metersPerPixel: header.metersPerPixel,
    surface: header.surface,
    minElevationM: min,
    maxElevationM: max,
    elevations,
  }
}

/**
 * Decode a base64 payload (bare, or a `data:image/png;base64,…` URI as produced by Vite's
 * `?inline` import) into PNG bytes. Works in node and the browser without `atob`/`Buffer`
 * branching, and without touching the network — the bytes are already in the bundle.
 */
export function base64ToBytes(payload: string): Uint8Array {
  const comma = payload.indexOf(',')
  const b64 = comma >= 0 && payload.startsWith('data:') ? payload.slice(comma + 1) : payload
  const lookup = base64Lookup()
  // Count only alphabet characters: '=' padding and any whitespace map to -1 and are skipped.
  // Because `clean` already excludes padding, the output length is floor(clean * 3 / 4) — do NOT
  // also subtract the pad count, which silently truncates the last one or two bytes.
  let clean = 0
  for (let i = 0; i < b64.length; i++) {
    if (lookup[b64.charCodeAt(i)] >= 0) clean++
  }
  const out = new Uint8Array(Math.floor((clean * 3) / 4))
  let acc = 0
  let accBits = 0
  let w = 0
  for (let i = 0; i < b64.length; i++) {
    const v = lookup[b64.charCodeAt(i)]
    if (v < 0) continue
    acc = (acc << 6) | v
    accBits += 6
    if (accBits >= 8) {
      accBits -= 8
      if (w < out.length) out[w++] = (acc >> accBits) & 0xff
    }
  }
  return out
}

let B64_LOOKUP: Int8Array | null = null
function base64Lookup(): Int8Array {
  if (!B64_LOOKUP) {
    const table = new Int8Array(128).fill(-1)
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    for (let i = 0; i < alphabet.length; i++) table[alphabet.charCodeAt(i)] = i
    B64_LOOKUP = table
  }
  return B64_LOOKUP
}

/**
 * Decode-once cache, keyed on the payload string itself.
 *
 * Determinism (§3): this is a pure memo. The key *is* the entire input, so a warm read is
 * indistinguishable from a cold one — the same bytes can only ever produce the same raster.
 * That is the property `src/tests/occlusionService.spec.ts` asserts directly; a cache that
 * merely "usually" matches would be a determinism bug, not an optimisation.
 */
interface CachedRaster {
  headerSignature: string
  raster: TerrainRaster
}

const RASTER_CACHE = new Map<string, CachedRaster>()

function terrainHeaderSignature(header: TerrainHeader): string {
  const b = header.bounds
  return [
    header.format,
    header.width,
    header.height,
    b.west,
    b.south,
    b.east,
    b.north,
    header.metersPerPixel,
    header.surface,
    header.elevationRangeM.min,
    header.elevationRangeM.max,
    header.verticalQuantumM ?? '',
  ].join('|')
}

/** Decode (or return the cached decode of) a Terrarium fixture. */
export function loadTerrainRaster(payload: string, header: TerrainHeader): TerrainRaster {
  const headerSignature = terrainHeaderSignature(header)
  const cached = RASTER_CACHE.get(payload)
  if (cached) {
    if (cached.headerSignature !== headerSignature) {
      throw new Error('terrain fixture payload was reused with a different geo header')
    }
    return cached.raster
  }
  const raster = decodeTerrariumPng(base64ToBytes(payload), header)
  RASTER_CACHE.set(payload, { headerSignature, raster })
  return raster
}

// ---------------------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------------------

/** Is this position inside the raster's coverage? Outside, sampling clamps to the edge. */
export function containsLatLng(raster: TerrainRaster, lat: number, lng: number): boolean {
  const b = raster.bounds
  return lng >= b.west && lng <= b.east && lat >= b.south && lat <= b.north
}

/** Continuous pixel coordinate (x → east, y → south) for a position. Exact, not interpolated. */
function pixelCoords(raster: TerrainRaster, lat: number, lng: number): { px: number; py: number } {
  const b = raster.bounds
  // Longitude is linear in Mercator X, so this fraction is exact.
  const px = ((lng - b.west) / (b.east - b.west)) * raster.width
  // Latitude is not: project both the query and the raster edges before taking the ratio.
  const yTop = mercatorY(b.north)
  const yBottom = mercatorY(b.south)
  const py = ((mercatorY(lat) - yTop) / (yBottom - yTop)) * raster.height
  return { px, py }
}

const clampInt = (v: number, hi: number) => (v < 0 ? 0 : v > hi ? hi : v)

/**
 * Bilinear ground elevation in metres MSL.
 *
 * Samples are treated as pixel *centres* (offset 0.5), which is what makes a query at a pixel
 * centre return that pixel's stored value exactly — the property WP-4's accept criterion 1
 * ("matches the source DEM within 1 m") is measured against. Queries outside the raster clamp
 * to the edge value rather than throwing: a route that strays outside the AO should degrade to
 * the nearest known ground, not crash the tick. Use `containsLatLng` when you need to know.
 */
export function elevationAt(raster: TerrainRaster, lat: number, lng: number): number {
  const { px, py } = pixelCoords(raster, lat, lng)
  const u = px - 0.5
  const v = py - 0.5
  const x0 = Math.floor(u)
  const y0 = Math.floor(v)
  const fx = u - x0
  const fy = v - y0
  const w = raster.width
  const x0c = clampInt(x0, w - 1)
  const x1c = clampInt(x0 + 1, w - 1)
  const y0c = clampInt(y0, raster.height - 1)
  const y1c = clampInt(y0 + 1, raster.height - 1)
  const e = raster.elevations
  // `a + (b - a) * t`, not `a*(1-t) + b*t`. Algebraically identical, numerically not: this form
  // returns exactly `a` when a === b, so any uniform patch of the DEM — a plateau, a lake, a
  // valley floor — samples to precisely its stored elevation instead of to a value a few ulps
  // off it. That matters because LOS compares a ray against these values: a ridge crest that
  // reads 200.00000000000003 m turns a ray at exactly 200 m from grazing into blocked.
  const top = e[y0c * w + x0c] + (e[y0c * w + x1c] - e[y0c * w + x0c]) * fx
  const bottom = e[y1c * w + x0c] + (e[y1c * w + x1c] - e[y1c * w + x0c]) * fx
  return top + (bottom - top) * fy
}

/** Nearest stored sample, unsmoothed — the raw fixture value at this position. */
export function nearestSampleAt(raster: TerrainRaster, lat: number, lng: number): number {
  const { px, py } = pixelCoords(raster, lat, lng)
  const x = clampInt(Math.floor(px), raster.width - 1)
  const y = clampInt(Math.floor(py), raster.height - 1)
  return raster.elevations[y * raster.width + x]
}

/** Geographic position of a sample's centre — the inverse of `pixelCoords`, for tests and tools. */
export function sampleCenterLatLng(
  raster: TerrainRaster,
  col: number,
  row: number,
): { lat: number; lng: number } {
  const b = raster.bounds
  const lng = b.west + ((col + 0.5) / raster.width) * (b.east - b.west)
  const yTop = mercatorY(b.north)
  const yBottom = mercatorY(b.south)
  const my = yTop + ((row + 0.5) / raster.height) * (yBottom - yTop)
  // Invert the Mercator Y projection back to latitude.
  const n = Math.PI - 2 * Math.PI * my
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
  return { lat, lng }
}
