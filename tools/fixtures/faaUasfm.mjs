// FAA UAS Facility Map (UASFM) ceiling-grid fetch + normalisation (REALISM_ROADMAP WP-3 / WP-0).
//
// Authoring-time ONLY. This file lives under tools/, is never bundled, and is never imported by
// src/ — the same contract openMeteo.mjs keeps for WP-2, and the reason the determinism rule
// (§3) survives contact with real data: fetched here, frozen to a committed fixture, replayed
// at runtime, never fetched at runtime.
//
// WHAT THE DATA IS. The UASFM publishes the maximum altitude at which a Part 107 operation may
// be authorised through LAANC *without further FAA safety analysis*, on a 30 x 30 arc-second
// graticule (~925 m cells in the lower 48). A published 0 means "not automatically
// authorisable here", not "flight is impossible" — the distinction the sim preserves as REAL
// DATA / SIMULATED AUTHORISATION (§WP-3). Coverage is deliberately partial: cells exist only
// under charted facility maps, so large parts of the country — including Ocean Beach in San
// Francisco, where the SFO grid stops at 37.7333 N — have no published cells at all. An empty
// result is a real answer, not a failure.
//
// ─── Interface (this module's whole public surface) ───────────────────────────────────────
//   import { fetchAirspaceCeilings, FAA_UASFM_LICENSE } from './faaUasfm.mjs'
//   import { aoBbox } from './aoBbox.mjs'
//
//   const { url, license, airspace } = await fetchAirspaceCeilings(aoBbox(scenarioConfig))
//   await writeFile(dest, serializeAirspaceFixture(airspace))   // NOT JSON.stringify(x, null, 2)
//
//   `airspace` is the exact object to write to src/scenarios/fixtures/<id>/airspace.json, and
//   matches the ObservedAirspace interface in src/types/index.ts. When `airspace.cells` is
//   empty the AO has no published facility map — write no fixture rather than an empty one, so
//   src/ takes the untouched "no fixture" path (bit-identical to pre-WP-3 behaviour).
//
//   `url` / `license` are for manifest.json, exactly as openMeteo.mjs supplies them, and the
//   SHA-256 belongs on the serializeAirspaceFixture() output so the hash matches the bytes.
// ──────────────────────────────────────────────────────────────────────────────────────────

// V5 is the live service. NOTE for anyone cross-checking against the roadmap: §WP-3's field
// names (MAP_EFF_DT, ARPT_Name, AIRSPACE) are from an older revision and do not exist here —
// the live schema is CEILING / UNIT / MAP_EFF / APT1_NAME / APT1_ICAO / AIRSPACE_1..5.
const SERVICE_URL =
  'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/FAA_UAS_FacilityMap_Data_V5/FeatureServer/0/query'

// US Government work. FAA UASFM data is published through the UAS Data Delivery System as
// public-domain public data with no licence fee and no attribution obligation of the kind
// Open-Meteo's CC BY 4.0 imposes. Recorded as provenance, not as a licence grant we invented:
// the honest claim is "who published it and when", which is exactly what a diligence
// conversation asks for.
export const FAA_UASFM_LICENSE =
  'US Government public domain (17 U.S.C. §105) — FAA UAS Facility Map, UAS Data Delivery System'

const OUT_FIELDS = 'OBJECTID,CEILING,UNIT,MAP_EFF,APT1_NAME,APT1_ICAO,AIRSPACE_1'
// The service caps a single response at 1000 features; anything larger must be paged with
// resultOffset. A 1500 m-margin AO is nowhere near that, but a corridor scenario (the 25-mile
// CBP Laredo run) would be, and silently truncating a ceiling grid is exactly the kind of
// "quietly wrong" the fixture pipeline exists to prevent.
const PAGE_SIZE = 1000
const MAX_PAGES = 25

/**
 * Fetch and normalise the published UASFM ceiling grid covering an AO envelope.
 *
 * @param {{ xmin: number, ymin: number, xmax: number, ymax: number }} bbox WGS84, from aoBbox()
 * @returns {Promise<{ url: string, license: string, airspace: object }>}
 */
export async function fetchAirspaceCeilings(bbox) {
  assertBbox(bbox)
  const firstPageUrl = queryUrl(bbox, 0)

  const features = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = page === 0 ? firstPageUrl : queryUrl(bbox, page * PAGE_SIZE)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`FAA UASFM ${res.status} for bbox ${JSON.stringify(bbox)}`)
    const json = await res.json()
    if (json.error) throw new Error(`FAA UASFM error: ${JSON.stringify(json.error)}`)

    const batch = json.features ?? []
    features.push(...batch)
    // `exceededTransferLimit` is the service's own "there is more" signal; the length check is
    // the belt-and-braces version for revisions that omit it.
    if (!json.properties?.exceededTransferLimit && batch.length < PAGE_SIZE) break
    if (batch.length === 0) break
  }

  return { url: firstPageUrl, license: FAA_UASFM_LICENSE, airspace: normalise(features, bbox) }
}

/**
 * Serialise a fixture: pretty envelope, one line per grid cell.
 *
 * Not cosmetic. §19 budgets airspace.json at ~20 KB and §21 makes fixture size a named risk
 * with a hard 500 KB per-scenario cut line. Fully-indented JSON puts every coordinate on its
 * own line, which pushed the SF multi-agency pursuit (227 cells across the SFO and Oakland
 * grids) to 31 KB — 90% of it whitespace. One line per cell keeps the file diffable and
 * greppable while landing inside the budget, so no scenario has to be dropped for byte reasons.
 *
 * @param {object} airspace the `airspace` value from fetchAirspaceCeilings
 * @returns {string} the exact bytes to write, newline-terminated
 */
export function serializeAirspaceFixture(airspace) {
  const { cells, ...envelope } = airspace
  const head = JSON.stringify(envelope, null, 2).replace(/\n}$/, '')
  const rows = cells.map((c) => `    { "ceilingFt": ${c.ceilingFt}, "bounds": [${c.bounds.join(', ')}] }`)
  return `${head},\n  "cells": [\n${rows.join(',\n')}\n  ]\n}\n`
}

function queryUrl(bbox, offset) {
  const params = new URLSearchParams({
    where: '1=1',
    geometry: JSON.stringify({ ...bbox, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: OUT_FIELDS,
    returnGeometry: 'true',
    resultRecordCount: String(PAGE_SIZE),
    resultOffset: String(offset),
    f: 'geojson',
  })
  return `${SERVICE_URL}?${params.toString()}`
}

function normalise(features, bbox) {
  const byId = new Map()
  const mapEff = new Set()
  const facilities = new Set()
  const airspaceClasses = new Set()

  for (const feature of features) {
    const p = feature?.properties ?? {}
    if (typeof p.CEILING !== 'number' || !Number.isFinite(p.CEILING)) continue

    // Refuse to guess at units. Every record observed is "Feet"; if the service ever ships a
    // metric record, a loud failure beats a fixture that is 3.28x wrong in the ceiling check.
    if (p.UNIT && String(p.UNIT).toLowerCase() !== 'feet') {
      throw new Error(`FAA UASFM: unexpected CEILING unit "${p.UNIT}" (expected Feet) on OBJECTID ${p.OBJECTID}`)
    }

    const bounds = rectBounds(feature.geometry, p.OBJECTID)
    byId.set(p.OBJECTID ?? `${bounds.join(',')}`, { ceilingFt: p.CEILING, bounds })

    if (p.MAP_EFF) mapEff.add(String(p.MAP_EFF))
    if (p.APT1_NAME) facilities.add(p.APT1_ICAO ? `${p.APT1_NAME} (${p.APT1_ICAO})` : String(p.APT1_NAME))
    if (p.AIRSPACE_1) airspaceClasses.add(String(p.AIRSPACE_1))
  }

  // Sorted south-then-west so regeneration is byte-identical regardless of the order the
  // service happens to return pages in — WP-0's acceptance criterion.
  const cells = [...byId.values()].sort((a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0])
  const ceilings = cells.map((c) => c.ceilingFt)

  return {
    source: 'FAA UAS Facility Map (UASFM) V5 — UAS Data Delivery System',
    // Multiple editions can overlap one AO; all of them are reported rather than picking one,
    // because this string is what the UI shows and a hidden second date is a silent staleness.
    mapEffective: [...mapEff].sort(byEffectiveDate).join(', '),
    unit: 'ft AGL',
    facilities: [...facilities].sort(),
    airspaceClasses: [...airspaceClasses].sort(),
    bbox: [bbox.xmin, bbox.ymin, bbox.xmax, bbox.ymax],
    minCeilingFt: ceilings.length ? Math.min(...ceilings) : null,
    maxCeilingFt: ceilings.length ? Math.max(...ceilings) : null,
    cells,
  }
}

/**
 * Collapse a UASFM polygon to [west, south, east, north].
 *
 * This is lossless, not a simplification: the grid is a lat/lng graticule, so every cell IS an
 * axis-aligned box and the ring is that box's corners. Storing 4 numbers instead of a 5-point
 * ring more than halves the fixture and keeps a large corridor AO inside the ~20 KB budget in
 * §19. The shape is asserted rather than assumed — if the service ever ships a clipped or
 * rotated cell, this throws instead of quietly recording a wrong footprint.
 */
function rectBounds(geometry, objectId) {
  const ring = geometry?.coordinates?.[0]
  if (geometry?.type !== 'Polygon' || !Array.isArray(ring) || ring.length < 4) {
    throw new Error(`FAA UASFM: OBJECTID ${objectId} is not a simple polygon`)
  }
  const lngs = ring.map((c) => c[0])
  const lats = ring.map((c) => c[1])
  const west = Math.min(...lngs), east = Math.max(...lngs)
  const south = Math.min(...lats), north = Math.max(...lats)

  const axisAligned = ring.every(
    ([lng, lat]) => (near(lng, west) || near(lng, east)) && (near(lat, south) || near(lat, north)),
  )
  if (!axisAligned) {
    throw new Error(`FAA UASFM: OBJECTID ${objectId} is not an axis-aligned grid cell; store the full ring instead`)
  }
  return [round6(west), round6(south), round6(east), round6(north)]
}

// MAP_EFF comes back as US-style M/D/YYYY. Sorted as dates so the joined string reads oldest to
// newest; unparseable values sort last rather than throwing, since the value is still displayed.
function byEffectiveDate(a, b) {
  const ta = Date.parse(a), tb = Date.parse(b)
  if (Number.isNaN(ta) && Number.isNaN(tb)) return a.localeCompare(b)
  if (Number.isNaN(ta)) return 1
  if (Number.isNaN(tb)) return -1
  return ta - tb
}

function assertBbox(bbox) {
  const ok = bbox && ['xmin', 'ymin', 'xmax', 'ymax'].every((k) => Number.isFinite(bbox[k]))
  if (!ok) throw new Error(`fetchAirspaceCeilings: bad bbox ${JSON.stringify(bbox)}`)
  if (bbox.xmax <= bbox.xmin || bbox.ymax <= bbox.ymin) {
    throw new Error(`fetchAirspaceCeilings: degenerate bbox ${JSON.stringify(bbox)}`)
  }
}

const near = (a, b) => Math.abs(a - b) < 1e-9
const round6 = (v) => Math.round(v * 1e6) / 1e6
