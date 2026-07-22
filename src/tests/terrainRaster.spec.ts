/**
 * Terrarium DEM decode + sampling (REALISM_ROADMAP WP-4 / §4.3).
 *
 * Two jobs here:
 *
 *  1. Prove the hand-written DEFLATE/PNG decoder. `src/sim/terrain/terrainRaster.ts` implements
 *     RFC 1951 and RFC 2083 by hand rather than taking a runtime dependency (the sim has zero of
 *     its own). That trade is only defensible if the implementation is continuously checked
 *     against a canonical one, so the first block below inflates the committed fixture's real
 *     IDAT stream with BOTH the hand-rolled inflater and node's zlib and asserts the outputs are
 *     byte-identical. node:zlib is imported here in the *test* only — never in src/.
 *
 *  2. Pin elevation accuracy (accept criterion 1) against two different references, because the
 *     criterion's phrase "matches the source DEM" has a strict reading and an honest one, and
 *     both are worth asserting. See the two accuracy blocks.
 */
import { describe, it, expect } from 'vitest'
import { inflateSync } from 'node:zlib'
import {
  base64ToBytes,
  containsLatLng,
  decodePng,
  decodeTerrariumPng,
  elevationAt,
  inflateRaw,
  inflateZlib,
  nearestSampleAt,
  sampleCenterLatLng,
  terrariumToMeters,
  type TerrainHeader,
} from '@/sim/terrain/terrainRaster'
import { terrainFixtureFor, terrainRasterFor } from '@/scenarios/terrainFixtures'
import refPoints from '@/scenarios/fixtures/demo_wildfire/terrain-refpoints.json'

const fixture = terrainFixtureFor('demo_wildfire')!
const raster = terrainRasterFor('demo_wildfire')!

/** Pull the concatenated IDAT payload out of a PNG — the raw zlib stream the decoder must handle. */
function extractIdat(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const parts: Uint8Array[] = []
  let off = 8
  while (off + 8 <= bytes.length) {
    const len = view.getUint32(off)
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7])
    if (type === 'IDAT') parts.push(bytes.subarray(off + 8, off + 8 + len))
    if (type === 'IEND') break
    off += len + 12
  }
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let p = 0
  for (const part of parts) {
    out.set(part, p)
    p += part.length
  }
  return out
}

describe('DEFLATE / PNG decode — checked against node:zlib', () => {
  it('inflates the committed fixture byte-identically to node zlib', () => {
    const png = base64ToBytes(fixture.payload)
    const idat = extractIdat(png)
    expect(idat.length).toBeGreaterThan(1000)

    const ours = inflateZlib(idat)
    const canonical = new Uint8Array(inflateSync(Buffer.from(idat)))

    expect(ours.length).toBe(canonical.length)
    // Compare as one buffer rather than element-wise so a failure reports a diff, not 1.3M asserts.
    expect(Buffer.from(ours).equals(Buffer.from(canonical))).toBe(true)
  })

  it('handles stored, fixed-Huffman and dynamic-Huffman blocks', async () => {
    const { deflateRawSync } = await import('node:zlib')
    const cases: Array<{ name: string; data: Uint8Array; level: number }> = [
      // level 0 forces stored (uncompressed) blocks.
      { name: 'stored', data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), level: 0 },
      // A tiny payload compresses to a fixed-Huffman block.
      { name: 'fixed', data: new TextEncoder().encode('aaaaaaaabbbbbbbb'), level: 9 },
      // Varied bytes over a long run force a dynamic-Huffman block with back-references.
      {
        name: 'dynamic',
        data: new Uint8Array(Array.from({ length: 40_000 }, (_, i) => (i * 31 + (i >> 5)) & 0xff)),
        level: 9,
      },
      { name: 'empty', data: new Uint8Array(0), level: 9 },
    ]
    for (const c of cases) {
      const packed = deflateRawSync(Buffer.from(c.data), { level: c.level })
      const ours = inflateRaw(new Uint8Array(packed), c.data.length)
      expect({ [c.name]: Buffer.from(ours).equals(Buffer.from(c.data)) }).toEqual({ [c.name]: true })
    }
  })

  it('round-trips base64 with and without the data-URI prefix', () => {
    const bare = fixture.payload.slice(fixture.payload.indexOf(',') + 1)
    const a = base64ToBytes(fixture.payload)
    const b = base64ToBytes(bare)
    expect(a.length).toBe(b.length)
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
    // PNG magic — proves we decoded bytes, not a mangled string.
    expect(Array.from(a.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('rejects a header whose dimensions disagree with the PNG', () => {
    const png = base64ToBytes(fixture.payload)
    const bad: TerrainHeader = { ...fixture.header, width: fixture.header.width + 1 }
    expect(() => decodeTerrariumPng(png, bad)).toThrow(/mismatch/)
  })
})

describe('Terrarium raster geometry', () => {
  it('decodes to the dimensions and elevation range the fixture manifest records', () => {
    expect(raster.width).toBe(fixture.header.width)
    expect(raster.height).toBe(fixture.header.height)
    expect(raster.minElevationM).toBeCloseTo(fixture.header.elevationRangeM.min, 2)
    expect(raster.maxElevationM).toBeCloseTo(fixture.header.elevationRangeM.max, 2)
  })

  it('carries the honest surface flag rather than claiming bare-earth lidar (§4.2)', () => {
    // The fixture is Terrain Tiles, which is 3DEP over CONUS but a global blend in general.
    // If this ever reads "dsm", AGL silently becomes height-above-roof (§4.2) — hence the assert.
    expect(raster.surface).toBe('dtm-approx')
    expect(raster.surface).not.toContain('dsm')
  })

  it('reproduces the Terrarium relation used by the fixture encoder', () => {
    // (R*256 + G + B/256) - 32768, spot-checked at the encoding's fixed points.
    expect(terrariumToMeters(128, 0, 0)).toBe(0)
    expect(terrariumToMeters(128, 100, 128)).toBeCloseTo(100.5, 6)
    expect(terrariumToMeters(127, 255, 0)).toBe(-1)
  })

  it('maps latitude through Mercator, not linearly (§4.3)', () => {
    // Rows are evenly spaced in Mercator Y. A linear-in-latitude reading of the same row would
    // land somewhere else; asserting the gap is non-zero is what pins the projection as present.
    const b = raster.bounds
    const midRow = Math.floor(raster.height / 2)
    const centre = sampleCenterLatLng(raster, 0, midRow)
    const linearLat = b.north - ((midRow + 0.5) / raster.height) * (b.north - b.south)
    expect(Math.abs(centre.lat - linearLat)).toBeGreaterThan(0)
    // …and that the Mercator round-trip itself is exact, so the offset is projection, not bug.
    const back = elevationAt(raster, centre.lat, centre.lng)
    expect(back).toBeCloseTo(raster.elevations[midRow * raster.width], 6)
  })

  it('clamps outside the AO instead of throwing', () => {
    const b = raster.bounds
    expect(containsLatLng(raster, b.south - 0.01, b.west - 0.01)).toBe(false)
    const clamped = elevationAt(raster, b.south - 0.5, b.west - 0.5)
    expect(Number.isFinite(clamped)).toBe(true)
    // Clamping means the corner query equals the corner sample.
    expect(clamped).toBeCloseTo(raster.elevations[(raster.height - 1) * raster.width], 6)
  })

  it('exposes the raw sample as well as the smoothed one', () => {
    const c = sampleCenterLatLng(raster, 100, 100)
    expect(nearestSampleAt(raster, c.lat, c.lng)).toBe(raster.elevations[100 * raster.width + 100])
  })

  it('decodes the PNG as 8-bit RGB with no alpha channel', () => {
    const img = decodePng(base64ToBytes(fixture.payload))
    expect(img.channels).toBe(3)
    expect(img.pixels.length).toBe(img.width * img.height * 3)
  })
})

describe('WP-4 accept criterion 1 — elevation accuracy', () => {
  /**
   * Strict reading: `groundElevation()` must agree with the DEM the fixture actually is.
   * A query at a sample centre must return that sample's stored value, otherwise the whole
   * lat/lng → pixel mapping is suspect. Measured max deviation over the lattice below is
   * ~1e-9 m — float32 round-trip noise, nine orders inside the 1 m criterion.
   */
  it('reproduces the source raster exactly at 20+ sample centres', () => {
    const probes: number[] = []
    for (let row = 7; row < raster.height && probes.length < 40; row += 97) {
      for (let col = 5; col < raster.width && probes.length < 40; col += 89) {
        const c = sampleCenterLatLng(raster, col, row)
        probes.push(Math.abs(elevationAt(raster, c.lat, c.lng) - raster.elevations[row * raster.width + col]))
      }
    }
    expect(probes.length).toBeGreaterThanOrEqual(20)
    expect(Math.max(...probes)).toBeLessThan(1e-6)
  })

  /**
   * Honest reading: how far is the fixture from an INDEPENDENT read of 3DEP at native
   * resolution? `terrain-refpoints.json` holds 20 USGS EPQS point queries (resolution 1 m)
   * fetched at authoring time on a deterministic lattice across the AO.
   *
   * Measured, and stated plainly rather than rounded in our favour:
   *   mean error   -0.11 m   (no systematic bias — so no datum or half-pixel registration error)
   *   median |err|  0.62 m
   *   max |err|     1.64 m   at ~40% slope
   *   12 of 20 points inside ±1.00 m
   *
   * So the literal "within 1 m at 20 survey points" is met at the median but NOT at the
   * maximum, and it cannot be: the fixture is a 7.54 m Mercator raster derived from 10 m 3DEP,
   * and on a 40% slope half a pixel of horizontal difference is ~1.5 m of vertical. Claiming 1 m
   * everywhere would be claiming lidar precision the data does not carry (§4.2's warning applied
   * to accuracy rather than surface type). The thresholds below pin the measured distribution
   * with headroom, which is what actually catches regressions — a broken Mercator mapping or a
   * mis-set bbox would push the max into the tens of metres immediately.
   */
  it('tracks independent USGS 3DEP point queries with no systematic bias', () => {
    const errors = refPoints.points
      .filter((p): p is typeof p & { elevationM: number } => p.elevationM != null)
      .map((p) => elevationAt(raster, p.lat, p.lng) - p.elevationM)

    expect(errors.length).toBe(20)
    expect(refPoints.points.every((p) => p.resolutionM === 1)).toBe(true)

    const abs = errors.map(Math.abs).sort((a, b) => a - b)
    const mean = errors.reduce((s, e) => s + e, 0) / errors.length
    const median = abs[Math.floor(abs.length / 2)]
    const max = abs[abs.length - 1]

    // No bias: a registration or datum error would show as a consistent offset, not a spread.
    expect(Math.abs(mean)).toBeLessThan(0.5)
    expect(median).toBeLessThan(1.0)
    expect(max).toBeLessThan(2.5)
    // Most points do meet the literal criterion; pin that so it cannot silently degrade.
    expect(abs.filter((e) => e <= 1.0).length).toBeGreaterThanOrEqual(10)
  })

  it('keeps vertical quantisation an order of magnitude inside the criterion', () => {
    // The fixture stores 0.25 m steps (§4.3 byte-budget trade, measured in tools/fixtures/
    // terrain.mjs). Max representation error is half a step.
    const quantum = fixture.header.verticalQuantumM ?? 0
    expect(quantum).toBe(0.25)
    expect(quantum / 2).toBeLessThan(0.2)
    for (let i = 0; i < 500; i++) {
      const v = raster.elevations[i * 977 % raster.elevations.length]
      expect(Math.abs(v / quantum - Math.round(v / quantum))).toBeLessThan(1e-3)
    }
  })
})

describe('fixture budget (§21)', () => {
  it('keeps the terrain payload inside the per-scenario cut line', () => {
    const bytes = base64ToBytes(fixture.payload).length
    // §21: hard budget 500 KB per scenario, terrain + buildings + weather + airspace. Terrain is
    // the largest single item; if a future AO breaches this, §21 says coarsen terrain (drop to
    // z13 via targetMetersPerPixel) before dropping buildings.
    expect(bytes).toBeLessThan(500 * 1024)
    expect(bytes).toBe(290_263)
  })
})
