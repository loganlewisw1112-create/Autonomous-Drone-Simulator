// Terrain fixture builder — Terrarium-encoded DEM (REALISM_ROADMAP WP-4 / WP-0).
//
// Authoring-time ONLY. Lives under tools/, is never bundled, and is never imported by src/.
// That is what keeps the determinism rule (§3) intact: real elevation data is fetched HERE,
// frozen into a committed PNG, and never fetched at runtime. src/sim/terrain/terrainRaster.ts
// decodes the frozen bytes; the ESLint `no-restricted-globals` rule under src/sim/** makes the
// "no runtime network" guarantee mechanical rather than a promise.
//
// ---------------------------------------------------------------------------------------
// SOURCE (verified 2026-07-21, HTTP 200, no authentication)
//
//   https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
//
// AWS Open Data "Terrain Tiles" (Tilezen/Mapzen `joerd`), Terrarium RGB encoding:
//
//   elevation_m = (R * 256 + G + B / 256) - 32768
//
// This is §4.3's fallback in the chain S1M → 3DEP 1 m → Copernicus GLO-30 → Terrain Tiles.
// It is chosen deliberately over the 1 m products: §4.3 fixes the target at **10 m**, and per
// Tilezen's own data-sources document the underlying raster over the conterminous United
// States *is* USGS 3DEP (formerly NED) at 10 m. So this is not a degraded substitute for 3DEP
// here — it is 3DEP, pre-tiled, pre-encoded and un-authenticated. Shipping 1 m rasters was
// explicitly ruled out (§20: ~1.5 GB across the catalog).
//
// SURFACE TYPE — read §4.2 before changing this.
// 3DEP/NED is a bare-earth topographic product, so over CONUS this fixture is a DTM, which is
// what WP-4 requires: with a DSM the AGL reference becomes roof height and every altitude
// computation over a city is wrong. But be precise about what it is NOT: Terrain Tiles are a
// *global blend* — outside CONUS, and in CONUS gaps, the same pixel grid may carry SRTM or
// GMTED2010, which are radar/aggregate surfaces rather than certified bare earth. Every fixture
// therefore records `surface: "dtm-approx"` and names the contributing programme. Do not
// upgrade that string to a bare-earth-lidar claim the data does not support. Structures enter
// separately as extruded footprints (§4.4) so they stay testable as discrete obstacles instead
// of being smeared into the ground.
//
// ONE ARTIFACT, TWO CONSUMERS (§4.3). The emitted `terrain.png` is a plain Terrarium PNG that
// stays on the **native Web-Mercator pixel grid** of the source tiles — it is a pixel-aligned
// crop of the stitched mosaic, never resampled. The sim decodes it to a Float32Array; the
// renderer can feed the identical bytes to MapLibre. Because the grid is untouched, the header's
// `mercatorPixelOrigin` lets any source tile lying wholly inside the AO be extracted again by a
// pure pixel-offset copy — no resampling, so a `raster-dem` re-tile is lossless. One pipeline,
// so drawn terrain and computed terrain cannot diverge.
//
// VERTICAL QUANTISATION — measured, not assumed.
// Terrarium's blue channel carries 1/256 m (≈3.9 mm) steps. Over 3DEP that low byte is
// essentially incompressible noise, and it is noise *far below the source's own accuracy*.
// Measured on the Grizzly Peak AO (664×665 px, 5 km × 5 km):
//
//   vertical quantum   PNG bytes    added error (max)
//   full 1/256 m       700 KB       0
//   0.25 m             283 KB       0.125 m
//   0.50 m             215 KB       0.25 m
//   1.00 m             149 KB       0.5 m
//
// Independently measured error of the *unquantised* fixture against USGS 3DEP point queries at
// five scattered points in the same AO: -0.84 m … +0.60 m. So the encoding's 3.9 mm precision
// was already an order of magnitude finer than the data underneath it. Default quantum is
// **0.25 m**: it costs 2.5× fewer bytes and adds 0.125 m, which keeps the total comfortably
// inside WP-4's 1 m accept criterion, whereas 0.5 m would push the worst case to ~1.09 m.
// §21's cut line is "coarsen terrain before dropping buildings" — the dial for that is
// `targetMetersPerPixel` (15 drops to z13 and roughly quarters the pixel count), not a coarser
// vertical quantum, because bytes scale with area and accuracy does not.
//
// ---------------------------------------------------------------------------------------
// USAGE
//
// As a module (this is the interface tools/fixtures/index.mjs consumes — index.mjs is owned
// elsewhere and is deliberately NOT edited by this file):
//
//   import { writeTerrainFixture, aoBboxAround } from './terrain.mjs'
//   const prov = await writeTerrainFixture({
//     dir: new URL('demo_wildfire/', fixturesRoot),
//     bbox: aoBboxAround({ lat, lng }, 5000),   // or an explicit [w, s, e, n]
//     scenarioId: 'demo_wildfire',
//   })
//   // → push prov.sources into manifest.json; every entry already carries
//   //   { fixture, source, url, license, attribution, sha256 }.
//
// As a CLI (standalone, so a terrain fixture can be regenerated without touching index.mjs):
//
//   node tools/fixtures/terrain.mjs --id demo_wildfire --center 37.8988,-122.2382 --size 5000
//   node tools/fixtures/terrain.mjs --id demo_wildfire --bbox -122.2667,37.8763,-122.2097,37.9213
//
// Optional flags: --res <metres> (default 10) · --no-refs (skip the USGS 3DEP cross-check).

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { deflateSync, inflateSync } from 'node:zlib'

// ---------------------------------------------------------------------------------------
// Provenance constants — these end up in manifest.json verbatim.
// ---------------------------------------------------------------------------------------

export const TERRARIUM_TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

export const TERRAIN_TILES_SOURCE = 'AWS Open Data — Terrain Tiles (Tilezen/Mapzen joerd), Terrarium RGB encoding'

/**
 * Licence, stated accurately rather than conveniently. Terrain Tiles is an aggregate: the AWS
 * Open Data registry hosts it without authentication, but the constituent national elevation
 * programmes carry their own terms, and attribution is *required* for several of them. Over the
 * conterminous US the contributor is USGS 3DEP/NED, a US federal public-domain product.
 */
export const TERRAIN_TILES_LICENSE =
  'Aggregate of national elevation programmes redistributed via AWS Open Data (no authentication). ' +
  'CONUS coverage derives from USGS 3DEP/NED — US federal government work, public domain. ' +
  'Per-source terms: https://github.com/tilezen/joerd/blob/master/docs/attribution.md'

/** The attribution string Tilezen requires for the US/global sources used here. */
export const TERRAIN_TILES_ATTRIBUTION =
  'United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey.'

export const TERRAIN_TILES_SOURCE_NOTE =
  'Tilezen data-sources: 3DEP (formerly NED) at 10 m across the conterminous US; SRTM/GMTED2010 elsewhere and in gaps.'

/** USGS 3DEP point-query service, used only to cross-check the fixture against an independent read. */
const EPQS_URL = 'https://epqs.nationalmap.gov/v1/json'

const TILE_PX = 256
/** Web-Mercator ground resolution at the equator, metres per pixel at z0 for a 256 px tile. */
const EQUATOR_M_PER_PX = 156543.03392804097

// ---------------------------------------------------------------------------------------
// Web-Mercator tiling maths
// ---------------------------------------------------------------------------------------

const clampLat = (lat) => Math.max(-85.05112878, Math.min(85.05112878, lat))

/** Fractional tile X for a longitude at zoom z (tile units; multiply by 256 for pixels). */
export function lngToTileX(lng, z) {
  return ((lng + 180) / 360) * 2 ** z
}

/** Fractional tile Y for a latitude at zoom z. */
export function latToTileY(lat, z) {
  const phi = (clampLat(lat) * Math.PI) / 180
  return ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * 2 ** z
}

export function tileXToLng(x, z) {
  return (x / 2 ** z) * 360 - 180
}

export function tileYToLat(y, z) {
  const n = Math.PI - 2 * Math.PI * (y / 2 ** z)
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}

/** Ground resolution (m per pixel) at a latitude and zoom. */
export function metersPerPixel(lat, z) {
  return (EQUATOR_M_PER_PX * Math.cos((clampLat(lat) * Math.PI) / 180)) / 2 ** z
}

/**
 * Coarsest zoom whose pixels are still at least as fine as `targetM`. Coarsest-that-qualifies
 * is the right rule: going one zoom finer quadruples the byte count for detail the 10 m source
 * raster does not actually contain (§4.3's byte budget is the binding constraint, not vanity
 * resolution). Capped at z15, the deepest zoom the Terrain Tiles pyramid publishes.
 */
export function zoomForTargetResolution(lat, targetM = 10) {
  for (let z = 1; z <= 15; z++) {
    if (metersPerPixel(lat, z) <= targetM) return z
  }
  return 15
}

/**
 * A square-ish AO bbox of `sizeM` on a side centred on a point. Returned as [w, s, e, n].
 * §4.3 sizes the byte budget against a 5 km × 5 km AO, which is the useful default.
 */
export function aoBboxAround({ lat, lng }, sizeM = 5000) {
  const half = sizeM / 2
  const dLat = half / 111_320
  const dLng = half / (111_320 * Math.cos((lat * Math.PI) / 180))
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat]
}

/** Whole-tile range covering a bbox at zoom z — the tiles that must be fetched and stitched. */
export function tileRangeForBbox([w, s, e, n], z) {
  const x0 = Math.floor(lngToTileX(w, z))
  const x1 = Math.floor(lngToTileX(e, z))
  const y0 = Math.floor(latToTileY(n, z)) // north edge → smaller tile Y
  const y1 = Math.floor(latToTileY(s, z))
  const max = 2 ** z - 1
  return {
    z,
    x0: Math.max(0, x0),
    x1: Math.min(max, x1),
    y0: Math.max(0, y0),
    y1: Math.min(max, y1),
    get cols() { return this.x1 - this.x0 + 1 },
    get rows() { return this.y1 - this.y0 + 1 },
  }
}

// ---------------------------------------------------------------------------------------
// Minimal PNG codec (node-side). Only what Terrarium needs: 8-bit, non-interlaced, RGB/RGBA.
// ---------------------------------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([len, typed, crc])
}

/** Decode an 8-bit non-interlaced PNG to { width, height, channels, pixels }. */
export function decodePng(bytes) {
  const buf = Buffer.from(bytes)
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('not a PNG')
  let off = 8
  let ihdr = null
  const idat = []
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      }
    } else if (type === 'IDAT') idat.push(Buffer.from(data))
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (!ihdr) throw new Error('PNG missing IHDR')
  if (ihdr.bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${ihdr.bitDepth}`)
  if (ihdr.interlace !== 0) throw new Error('interlaced PNG unsupported')
  const channels = ihdr.colorType === 2 ? 3 : ihdr.colorType === 6 ? 4 : 0
  if (!channels) throw new Error(`unsupported PNG colour type ${ihdr.colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const pixels = unfilter(raw, ihdr.width, ihdr.height, channels)
  return { ...ihdr, channels, pixels }
}

/** Reverse the five PNG per-scanline filters. */
function unfilter(raw, width, height, ch) {
  const stride = width * ch
  const out = Buffer.alloc(stride * height)
  let p = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]
    const row = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const x = raw[p + i]
      const a = i >= ch ? row[i - ch] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= ch ? prev[i - ch] : 0
      let v
      switch (filter) {
        case 0: v = x; break
        case 1: v = x + a; break
        case 2: v = x + b; break
        case 3: v = x + ((a + b) >> 1); break
        case 4: v = x + paeth(a, b, c); break
        default: throw new Error(`bad PNG filter ${filter}`)
      }
      row[i] = v & 0xff
    }
    p += stride
  }
  return out
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * Encode 8-bit RGB to PNG. Filter choice uses the standard minimum-sum-of-absolute-differences
 * heuristic per scanline, and deflate runs at a pinned level, so the same input tiles always
 * produce byte-identical output — WP-0's accept criterion is that `--all` regenerates fixtures
 * byte-identically from a clean checkout.
 */
export function encodePngRgb(pixels, width, height) {
  const ch = 3
  const stride = width * ch
  const filtered = Buffer.alloc((stride + 1) * height)
  const candidate = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null
    let best = 0
    let bestScore = Infinity
    let bestBuf = null
    for (let f = 0; f <= 4; f++) {
      let score = 0
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? row[i - ch] : 0
        const b = prev ? prev[i] : 0
        const c = prev && i >= ch ? prev[i - ch] : 0
        let v
        switch (f) {
          case 0: v = row[i]; break
          case 1: v = row[i] - a; break
          case 2: v = row[i] - b; break
          case 3: v = row[i] - ((a + b) >> 1); break
          default: v = row[i] - paeth(a, b, c); break
        }
        v &= 0xff
        candidate[i] = v
        score += v < 128 ? v : 256 - v
      }
      if (score < bestScore) {
        bestScore = score
        best = f
        bestBuf = Buffer.from(candidate)
      }
    }
    filtered[y * (stride + 1)] = best
    bestBuf.copy(filtered, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour RGB
  return Buffer.concat([
    PNG_MAGIC,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(filtered, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------------------
// Fetch + stitch
// ---------------------------------------------------------------------------------------

async function fetchTile(z, x, y, fetchImpl) {
  const url = TERRARIUM_TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y)
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`terrain tile ${z}/${x}/${y} → HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

/** Terrarium triple → metres. Mirrors src/sim/terrain/terrainRaster.ts exactly. */
export const terrariumToMeters = (r, g, b) => r * 256 + g + b / 256 - 32768

/** Metres → Terrarium triple, with carry handled by going through the integer encoding. */
function metersToTerrarium(m) {
  const v = Math.max(0, Math.min(0xffffff, Math.round((m + 32768) * 256)))
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
}

/**
 * Fetch the tiles covering `bbox`, stitch, crop to the AO on the native Mercator pixel grid,
 * quantise vertically, and return the PNG bytes plus the geo header the sim needs to map
 * lat/lng → pixel.
 *
 * The crop is snapped *outward* to whole pixels so the AO is always fully covered, and the
 * absolute Mercator pixel origin is recorded so the grid stays re-tileable (see header note).
 */
export async function buildTerrainFixture({
  bbox,
  targetMetersPerPixel = 10,
  verticalQuantumM = 0.25,
  fetchImpl = fetch,
  onProgress,
}) {
  const [w, s, e, n] = bbox
  if (!(w < e && s < n)) throw new Error(`bbox must be [west, south, east, north], got ${bbox.join(',')}`)
  const centerLat = (s + n) / 2
  const z = zoomForTargetResolution(centerLat, targetMetersPerPixel)
  const range = tileRangeForBbox(bbox, z)

  const mosaicW = range.cols * TILE_PX
  const mosaicH = range.rows * TILE_PX
  const mosaic = Buffer.alloc(mosaicW * mosaicH * 3)
  const tiles = []

  for (let ty = range.y0; ty <= range.y1; ty++) {
    for (let tx = range.x0; tx <= range.x1; tx++) {
      const bytes = await fetchTile(z, tx, ty, fetchImpl)
      tiles.push({ z, x: tx, y: ty, bytes: bytes.length })
      onProgress?.(`${z}/${tx}/${ty}`)
      const img = decodePng(bytes)
      if (img.width !== TILE_PX || img.height !== TILE_PX) {
        throw new Error(`tile ${z}/${tx}/${ty} is ${img.width}×${img.height}, expected ${TILE_PX}²`)
      }
      const ox = (tx - range.x0) * TILE_PX
      const oy = (ty - range.y0) * TILE_PX
      for (let py = 0; py < TILE_PX; py++) {
        for (let px = 0; px < TILE_PX; px++) {
          const src = (py * TILE_PX + px) * img.channels
          const dst = ((oy + py) * mosaicW + (ox + px)) * 3
          mosaic[dst] = img.pixels[src]
          mosaic[dst + 1] = img.pixels[src + 1]
          mosaic[dst + 2] = img.pixels[src + 2]
        }
      }
    }
  }

  // Crop window in ABSOLUTE Mercator pixels at this zoom, snapped outward so the AO is covered.
  const gx0 = Math.floor(lngToTileX(w, z) * TILE_PX)
  const gx1 = Math.ceil(lngToTileX(e, z) * TILE_PX)
  const gy0 = Math.floor(latToTileY(n, z) * TILE_PX) // north edge → smaller pixel Y
  const gy1 = Math.ceil(latToTileY(s, z) * TILE_PX)
  const width = gx1 - gx0
  const height = gy1 - gy0
  const offX = gx0 - range.x0 * TILE_PX
  const offY = gy0 - range.y0 * TILE_PX

  const pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    const from = ((offY + y) * mosaicW + offX) * 3
    mosaic.copy(pixels, y * width * 3, from, from + width * 3)
  }

  // Vertical quantisation (see the header block at the top of this file for the measurements).
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < width * height; i++) {
    const o = i * 3
    let m = terrariumToMeters(pixels[o], pixels[o + 1], pixels[o + 2])
    if (verticalQuantumM > 0) {
      m = Math.round(m / verticalQuantumM) * verticalQuantumM
      const [r, g, b] = metersToTerrarium(m)
      pixels[o] = r
      pixels[o + 1] = g
      pixels[o + 2] = b
      m = terrariumToMeters(r, g, b) // record the value that is actually stored
    }
    if (m < min) min = m
    if (m > max) max = m
  }

  // Geographic extent of the crop. north/south are Mercator pixel edges, so latitude is NOT
  // linear down the raster — the decoder must invert the Mercator projection, never lerp
  // latitude, or positions skew by tens of metres of ground distance toward the edges.
  const west = tileXToLng(gx0 / TILE_PX, z)
  const east = tileXToLng(gx1 / TILE_PX, z)
  const north = tileYToLat(gy0 / TILE_PX, z)
  const south = tileYToLat(gy1 / TILE_PX, z)

  const png = encodePngRgb(pixels, width, height)

  return {
    png,
    tiles,
    header: {
      format: 'terrarium',
      note: 'elevation_m = (R * 256 + G + B / 256) - 32768; rows are linear in Web-Mercator Y, not latitude',
      width,
      height,
      zoom: z,
      tileSize: TILE_PX,
      // Absolute Web-Mercator pixel coordinate of pixel (0,0) at `zoom`. Any source tile whose
      // 256² pixel block lies wholly inside the crop can be recovered by a pure offset copy,
      // which is what keeps a MapLibre `raster-dem` re-tile lossless (§4.3).
      mercatorPixelOrigin: { x: gx0, y: gy0 },
      sourceTiles: { x0: range.x0, y0: range.y0, cols: range.cols, rows: range.rows },
      bounds: { west, south, east, north },
      requestedBbox: { west: w, south: s, east: e, north: n },
      metersPerPixel: Number(metersPerPixel(centerLat, z).toFixed(3)),
      verticalQuantumM,
      verticalDatum: 'source vertical datum as published by the contributing programme (NAVD88 over CONUS); not re-levelled',
      surface: 'dtm-approx',
      surfaceNote:
        'Bare-earth DTM over the conterminous US (USGS 3DEP/NED). Terrain Tiles are a global blend: ' +
        'elsewhere and in CONUS gaps the same grid may carry SRTM/GMTED2010, which are not certified ' +
        'bare earth. Structures are NOT in this surface — they enter separately as footprints (§4.2/§4.4).',
      elevationRangeM: { min: Number(min.toFixed(2)), max: Number(max.toFixed(2)) },
    },
  }
}

// ---------------------------------------------------------------------------------------
// Independent cross-check against USGS 3DEP point queries
// ---------------------------------------------------------------------------------------

/**
 * Query the USGS 3DEP Elevation Point Query Service for a scatter of points inside the AO.
 *
 * This exists so accept criterion 1 ("groundElevation() at known survey points matches the
 * source DEM") can be tested against a genuinely *independent* read of 3DEP rather than
 * against the same Terrarium bytes the fixture came from — which would only prove the decoder
 * agrees with itself. Points are laid out on a deterministic lattice so re-running produces the
 * same list. Failures are recorded as null rather than aborting the fixture build.
 */
export async function fetchReferenceElevations({ bbox, count = 20, fetchImpl = fetch }) {
  const [w, s, e, n] = bbox
  const side = Math.ceil(Math.sqrt(count))
  const points = []
  for (let i = 0; i < side && points.length < count; i++) {
    for (let j = 0; j < side && points.length < count; j++) {
      // Cell centres of a side×side lattice — inset from the edges, deterministic, no RNG.
      const fx = (j + 0.5) / side
      const fy = (i + 0.5) / side
      points.push({ lat: s + (n - s) * fy, lng: w + (e - w) * fx })
    }
  }
  const out = []
  for (const p of points) {
    const url = `${EPQS_URL}?x=${p.lng.toFixed(6)}&y=${p.lat.toFixed(6)}&units=Meters&wkid=4326`
    try {
      const res = await fetchImpl(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const v = Number(json?.value)
      out.push({
        lat: Number(p.lat.toFixed(6)),
        lng: Number(p.lng.toFixed(6)),
        elevationM: Number.isFinite(v) ? Number(v.toFixed(2)) : null,
        resolutionM: json?.resolution ?? null,
      })
    } catch {
      out.push({ lat: Number(p.lat.toFixed(6)), lng: Number(p.lng.toFixed(6)), elevationM: null, resolutionM: null })
    }
  }
  return {
    source: 'USGS 3DEP Elevation Point Query Service (EPQS)',
    url: `${EPQS_URL}?x={lng}&y={lat}&units=Meters&wkid=4326`,
    license: 'US Geological Survey — US federal government work, public domain',
    note: 'Independent read of 3DEP at native resolution; used to bound the fixture error, not to build it.',
    points: out,
  }
}

// ---------------------------------------------------------------------------------------
// Fixture emission
// ---------------------------------------------------------------------------------------

const sha256 = (b) => createHash('sha256').update(b).digest('hex')

/**
 * Build and write a scenario's terrain fixture.
 *
 * Emits into `dir`:
 *   terrain.png            Terrarium mosaic — the payload, imported by src/ via Vite `?inline`
 *   terrain.json           geo header + provenance — statically imported, human-reviewable
 *   terrain-refpoints.json USGS 3DEP cross-check points (omitted when `refPoints: 0`)
 *
 * Returns `{ header, bytes, sources }`; `sources` is manifest-ready — the caller
 * (tools/fixtures/index.mjs, owned elsewhere) can concat it straight into manifest.sources.
 */
export async function writeTerrainFixture({
  dir,
  bbox,
  scenarioId,
  targetMetersPerPixel = 10,
  verticalQuantumM = 0.25,
  refPoints = 20,
  fetchImpl = fetch,
  onProgress,
}) {
  const { png, tiles, header } = await buildTerrainFixture({
    bbox,
    targetMetersPerPixel,
    verticalQuantumM,
    fetchImpl,
    onProgress,
  })
  await mkdir(dir, { recursive: true })
  await writeFile(new URL('terrain.png', dir), png)

  const retrievedAt = new Date().toISOString().slice(0, 10)
  const headerDoc = {
    ...header,
    scenarioId,
    payload: 'terrain.png',
    source: TERRAIN_TILES_SOURCE,
    sourceUrlTemplate: TERRARIUM_TILE_URL,
    sourceNote: TERRAIN_TILES_SOURCE_NOTE,
    license: TERRAIN_TILES_LICENSE,
    attribution: TERRAIN_TILES_ATTRIBUTION,
    retrievedAt,
    tileCount: tiles.length,
    pngBytes: png.length,
    pngSha256: sha256(png),
  }
  const headerJson = JSON.stringify(headerDoc, null, 2) + '\n'
  await writeFile(new URL('terrain.json', dir), headerJson)

  const sources = [
    {
      fixture: 'terrain.png',
      source: TERRAIN_TILES_SOURCE,
      url: TERRARIUM_TILE_URL,
      license: TERRAIN_TILES_LICENSE,
      attribution: TERRAIN_TILES_ATTRIBUTION,
      retrievedAt,
      detail: `z${header.zoom} ${header.width}×${header.height}px from ${tiles.length} tiles, ${header.metersPerPixel} m/px, ${header.verticalQuantumM} m vertical quantum, surface ${header.surface}`,
      sha256: sha256(png),
    },
    {
      fixture: 'terrain.json',
      source: 'derived header (this pipeline)',
      url: TERRARIUM_TILE_URL,
      license: TERRAIN_TILES_LICENSE,
      retrievedAt,
      sha256: sha256(headerJson),
    },
  ]

  let refs = null
  if (refPoints > 0) {
    refs = await fetchReferenceElevations({ bbox, count: refPoints, fetchImpl })
    const refJson = JSON.stringify({ scenarioId, ...refs }, null, 2) + '\n'
    await writeFile(new URL('terrain-refpoints.json', dir), refJson)
    sources.push({
      fixture: 'terrain-refpoints.json',
      source: refs.source,
      url: refs.url,
      license: refs.license,
      retrievedAt,
      sha256: sha256(refJson),
    })
  }

  // Merge provenance here as well as returning it. Terrain and buildings can be generated
  // independently of the weather catalog CLI; a standalone terrain run must not leave a
  // sourced payload without the required manifest entry.
  const manifestUrl = new URL('manifest.json', dir)
  const previous = await readFile(manifestUrl, 'utf8').then(JSON.parse).catch(() => null)
  const produced = new Set(sources.map((source) => source.fixture))
  const kept = (previous?.sources ?? []).filter((source) => !produced.has(source.fixture))
  const manifest = {
    scenarioId,
    area: { ...(previous?.area ?? {}), aoBbox: bbox },
    generatedAt: retrievedAt,
    sources: [...kept, ...sources].sort((a, b) => a.fixture.localeCompare(b.fixture)),
  }
  await writeFile(manifestUrl, JSON.stringify(manifest, null, 2) + '\n')

  return { header: headerDoc, bytes: png.length, refs, sources }
}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    if (key === 'no-refs') out.refPoints = 0
    else out[key] = argv[++i]
  }
  return out
}

async function cli() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.id) {
    console.error('usage: node tools/fixtures/terrain.mjs --id <scenarioId> (--bbox w,s,e,n | --center lat,lng [--size m]) [--res 10] [--no-refs]')
    process.exit(1)
  }
  let bbox
  if (args.bbox) {
    bbox = args.bbox.split(',').map(Number)
    if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) throw new Error('--bbox must be w,s,e,n')
  } else if (args.center) {
    const [lat, lng] = args.center.split(',').map(Number)
    bbox = aoBboxAround({ lat, lng }, Number(args.size ?? 5000))
  } else {
    throw new Error('need --bbox or --center')
  }

  const dir = new URL(`../../src/scenarios/fixtures/${args.id}/`, import.meta.url)
  process.stdout.write(`• ${args.id} terrain … `)
  const res = await writeTerrainFixture({
    dir,
    bbox,
    scenarioId: args.id,
    targetMetersPerPixel: Number(args.res ?? 10),
    verticalQuantumM: Number(args.quantum ?? 0.25),
    refPoints: args.refPoints ?? 20,
    onProgress: () => process.stdout.write('.'),
  })
  const h = res.header
  console.log(
    `\n  z${h.zoom} ${h.width}×${h.height}px @ ${h.metersPerPixel} m/px · ` +
    `${h.elevationRangeM.min}–${h.elevationRangeM.max} m MSL · ${(res.bytes / 1024).toFixed(1)} KB ✓`,
  )
  if (res.refs) {
    const ok = res.refs.points.filter((p) => p.elevationM != null).length
    console.log(`  ${ok}/${res.refs.points.length} USGS 3DEP reference points resolved`)
  }
  console.log('  Commit terrain.png + terrain.json; src/ imports them, never fetches.')
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('terrain.mjs')) {
  cli().catch((e) => {
    console.error('\nterrain fixture failed:', e.message)
    process.exit(1)
  })
}
