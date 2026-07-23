#!/usr/bin/env node
// Authoring-time GPS constellation fixture generator (REALISM_ROADMAP WP-0 / WP-7 §7.2 step 1).
//
// Fetches a real published YUMA almanac from CelesTrak, propagates every healthy satellite with
// the standard IS-GPS-200 almanac algorithm, and freezes the resulting azimuth/elevation look
// angles for the scenario's area of operations into a committed fixture.
//
//   node tools/fixtures/constellation.mjs --id demo_wildfire --center 37.8992,-122.2432 \
//     --date 2026-08-14T21:00:00Z --hours 1 --step 5
//
// WHY az/el AND NOT THE ALMANAC ITSELF. The runtime needs look angles, and the orbital
// propagation that produces them is a few hundred lines of Keplerian mechanics with no other
// consumer in the app. Freezing the *output* keeps that maths in the authoring tool where it
// belongs (never shipped, never in CI) and leaves the runtime with an interpolation over a few
// KB — which is also what makes the sim's determinism story easy to hold.
//
// SAMPLING. GPS satellites move ~0.5°/min, so §7.2 specifies 5-minute epochs with interpolation
// between them. Over a one-hour mission window that is 13 epochs × ~31 satellites.
//
// NEVER RUN AT BUILD TIME OR IN CI. Like every tool in this directory, this is run by a
// maintainer, and src/ imports the committed result rather than fetching anything.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------------------
// Constants — IS-GPS-200 / WGS-84
// ---------------------------------------------------------------------------------------

/** WGS-84 gravitational constant for GPS (m³/s²). */
const MU = 3.986005e14
/** WGS-84 Earth rotation rate (rad/s). */
const OMEGA_EARTH = 7.2921151467e-5
/** WGS-84 semi-major axis (m) and first eccentricity squared. */
const WGS84_A = 6378137.0
const WGS84_E2 = 6.69437999014e-3
/** GPS time origin. */
const GPS_EPOCH_MS = Date.UTC(1980, 0, 6, 0, 0, 0)
/** The almanac's transmitted week is modulo 1024. */
const GPS_WEEK_ROLLOVER = 1024

const ALMANAC_INDEX = (year) => `https://celestrak.org/GPS/almanac/Yuma/${year}/`
const ALMANAC_LICENSE =
  'GPS almanac data is a product of the US Space Force / NAVCEN — US federal government work, public domain. Redistributed by CelesTrak (https://celestrak.org/), which permits use with attribution.'

// ---------------------------------------------------------------------------------------
// YUMA almanac parsing
// ---------------------------------------------------------------------------------------

/**
 * Parse a YUMA-format almanac into per-satellite Keplerian element sets.
 *
 * The format is one labelled `key: value` block per PRN separated by a banner line. Only the
 * fields the propagation actually uses are read; anything unrecognised is ignored rather than
 * guessed at.
 */
export function parseYuma(text) {
  const satellites = []
  const blocks = text.split(/\*{4,}/).map((b) => b.trim()).filter(Boolean)
  for (const block of blocks) {
    if (!/ID:/.test(block)) continue
    const field = (label) => {
      const match = block.match(new RegExp(`${label}[^:]*:\\s*(-?[0-9.Ee+-]+)`))
      return match ? Number(match[1]) : null
    }
    const prn = field('ID')
    const health = field('Health')
    const sqrtA = field('SQRT\\(A\\)')
    if (prn == null || sqrtA == null) continue
    satellites.push({
      prn,
      health,
      eccentricity: field('Eccentricity'),
      toa: field('Time of Applicability'),
      inclinationRad: field('Orbital Inclination'),
      omegaDot: field('Rate of Right Ascen'),
      sqrtA,
      omega0: field('Right Ascen at Week'),
      argPerigee: field('Argument of Perigee'),
      meanAnomaly: field('Mean Anom'),
      week: field('week'),
    })
  }
  return satellites
}

// ---------------------------------------------------------------------------------------
// Orbital propagation (IS-GPS-200 §20.3.3.5.2.1, almanac subset)
// ---------------------------------------------------------------------------------------

/**
 * Satellite ECEF position (m) at GPS time-of-week `tow` in full week `week`.
 *
 * The almanac subset of the broadcast-ephemeris algorithm: no harmonic correction terms (the
 * almanac does not carry them), which is why almanac positions are good to a few km rather than
 * a few metres. That is far inside what az/el for a visibility test needs — a few km at 20 000 km
 * range is well under a tenth of a degree.
 */
export function satelliteEcef(sat, week, tow) {
  const a = sat.sqrtA * sat.sqrtA
  const n0 = Math.sqrt(MU / (a * a * a))

  // Time from almanac reference epoch, wrapped across the week boundary.
  let tk = tow - sat.toa + (week - almanacFullWeek(sat, week)) * 604800
  if (tk > 302400) tk -= 604800
  if (tk < -302400) tk += 604800

  const m = sat.meanAnomaly + n0 * tk

  // Kepler's equation by Newton-Raphson. Converges in a handful of iterations for GPS
  // eccentricities (~0.01); the fixed iteration count keeps it deterministic.
  let e = m
  for (let i = 0; i < 12; i += 1) {
    const dE = (e - sat.eccentricity * Math.sin(e) - m) / (1 - sat.eccentricity * Math.cos(e))
    e -= dE
    if (Math.abs(dE) < 1e-13) break
  }

  const sinE = Math.sin(e)
  const cosE = Math.cos(e)
  const nu = Math.atan2(Math.sqrt(1 - sat.eccentricity ** 2) * sinE, cosE - sat.eccentricity)
  const phi = nu + sat.argPerigee
  const r = a * (1 - sat.eccentricity * cosE)

  const xOrb = r * Math.cos(phi)
  const yOrb = r * Math.sin(phi)

  // Corrected longitude of the ascending node: the node regresses, and the Earth turns under it.
  const omega = sat.omega0 + (sat.omegaDot - OMEGA_EARTH) * tk - OMEGA_EARTH * sat.toa
  const cosO = Math.cos(omega)
  const sinO = Math.sin(omega)
  const cosI = Math.cos(sat.inclinationRad)
  const sinI = Math.sin(sat.inclinationRad)

  return {
    x: xOrb * cosO - yOrb * cosI * sinO,
    y: xOrb * sinO + yOrb * cosI * cosO,
    z: yOrb * sinI,
  }
}

/** Resolve the almanac's rolled-over week against the full week being propagated. */
function almanacFullWeek(sat, week) {
  if (sat.week == null) return week
  const rollovers = Math.round((week - sat.week) / GPS_WEEK_ROLLOVER)
  return sat.week + rollovers * GPS_WEEK_ROLLOVER
}

/** Geodetic lat/lng/height → ECEF (m). */
export function geodeticToEcef(latDeg, lngDeg, heightM) {
  const lat = (latDeg * Math.PI) / 180
  const lng = (lngDeg * Math.PI) / 180
  const sinLat = Math.sin(lat)
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat)
  return {
    x: (n + heightM) * Math.cos(lat) * Math.cos(lng),
    y: (n + heightM) * Math.cos(lat) * Math.sin(lng),
    z: (n * (1 - WGS84_E2) + heightM) * sinLat,
  }
}

/** Azimuth (deg clockwise from north) and elevation (deg) of `target` seen from `observer`. */
export function lookAngles(observerLatDeg, observerLngDeg, observerEcef, target) {
  const lat = (observerLatDeg * Math.PI) / 180
  const lng = (observerLngDeg * Math.PI) / 180
  const dx = target.x - observerEcef.x
  const dy = target.y - observerEcef.y
  const dz = target.z - observerEcef.z

  const sinLat = Math.sin(lat)
  const cosLat = Math.cos(lat)
  const sinLng = Math.sin(lng)
  const cosLng = Math.cos(lng)

  const east = -sinLng * dx + cosLng * dy
  const north = -sinLat * cosLng * dx - sinLat * sinLng * dy + cosLat * dz
  const up = cosLat * cosLng * dx + cosLat * sinLng * dy + sinLat * dz

  const azDeg = (((Math.atan2(east, north) * 180) / Math.PI) + 360) % 360
  const elDeg = (Math.atan2(up, Math.hypot(east, north)) * 180) / Math.PI
  return { azDeg, elDeg }
}

/** GPS full week number and time-of-week for a UTC instant. Leap seconds are not applied. */
export function gpsTimeFor(date) {
  const elapsedSec = (date.getTime() - GPS_EPOCH_MS) / 1000
  const week = Math.floor(elapsedSec / 604800)
  return { week, tow: elapsedSec - week * 604800 }
}

// ---------------------------------------------------------------------------------------
// Fixture generation
// ---------------------------------------------------------------------------------------

/** Pick the published almanac closest to (and not after) the target week. */
export function chooseAlmanacFile(names, targetWeek) {
  const parsed = names
    .map((name) => {
      const match = name.match(/almanac\.yuma\.week(\d+)\.(\d+)\.txt/)
      return match ? { name, week: Number(match[1]), tow: Number(match[2]) } : null
    })
    .filter(Boolean)
  if (parsed.length === 0) return null
  const rolled = ((targetWeek % GPS_WEEK_ROLLOVER) + GPS_WEEK_ROLLOVER) % GPS_WEEK_ROLLOVER
  const notAfter = parsed.filter((p) => p.week <= rolled)
  const pool = notAfter.length > 0 ? notAfter : parsed
  return pool.sort((a, b) => (b.week - a.week) || (b.tow - a.tow))[0]
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'drone-sim-fixture-pipeline' } })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`)
  return response.text()
}

export async function buildConstellationFixture({ lat, lng, startUtc, hours, stepMin, heightM = 0 }) {
  const start = new Date(startUtc)
  if (Number.isNaN(start.getTime())) throw new Error(`--date is not a valid ISO instant: ${startUtc}`)

  const { week } = gpsTimeFor(start)
  const year = start.getUTCFullYear()
  const index = await fetchText(ALMANAC_INDEX(year))
  const names = [...index.matchAll(/almanac\.yuma\.week\d+\.\d+\.txt/g)].map((m) => m[0])
  const chosen = chooseAlmanacFile(names, week)
  if (!chosen) throw new Error(`no YUMA almanac listed for ${year}`)

  const almanacUrl = `${ALMANAC_INDEX(year)}${chosen.name}`
  const almanacText = await fetchText(almanacUrl)
  const satellites = parseYuma(almanacText)
  // Health 000 is "all signals OK" in the YUMA convention; anything else is excluded rather
  // than flown as a usable satellite.
  const healthy = satellites.filter((s) => s.health === 0)
  if (healthy.length === 0) throw new Error('almanac parsed but contained no healthy satellites')

  const observer = geodeticToEcef(lat, lng, heightM)
  const stepSec = stepMin * 60
  const epochCount = Math.floor((hours * 3600) / stepSec) + 1

  const epochs = []
  for (let i = 0; i < epochCount; i += 1) {
    const at = new Date(start.getTime() + i * stepSec * 1000)
    const { week: w, tow } = gpsTimeFor(at)
    const looks = []
    for (const sat of healthy) {
      const ecef = satelliteEcef(sat, w, tow)
      const { azDeg, elDeg } = lookAngles(lat, lng, observer, ecef)
      // Satellites below the horizon carry no information for a visibility test and are the
      // bulk of the constellation at any instant — dropping them roughly halves the fixture.
      if (elDeg < 0) continue
      looks.push([sat.prn, round(azDeg, 2), round(elDeg, 2)])
    }
    epochs.push(looks.sort((a, b) => a[0] - b[0]))
  }

  return {
    fixture: {
      reference: { lat: round(lat, 6), lng: round(lng, 6) },
      startUtc: start.toISOString(),
      stepSec,
      epochs,
    },
    provenance: {
      almanacUrl,
      almanacWeek: chosen.week,
      almanacToa: chosen.tow,
      satellitesHealthy: healthy.length,
      satellitesTotal: satellites.length,
    },
  }
}

const round = (v, digits) => Number(v.toFixed(digits))
const sha256 = (s) => createHash('sha256').update(s).digest('hex')

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    out[a.slice(2)] = argv[++i]
  }
  return out
}

async function cli() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.id || !args.center || !args.date) {
    console.error(
      'usage: node tools/fixtures/constellation.mjs --id <scenarioId> --center lat,lng ' +
      '--date <ISO-UTC> [--hours 1] [--step 5] [--dateKind representative|documented] [--note "..."]',
    )
    process.exit(1)
  }

  const [lat, lng] = args.center.split(',').map(Number)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('--center must be lat,lng')

  const hours = Number(args.hours ?? 1)
  const stepMin = Number(args.step ?? 5)

  process.stdout.write(`• ${args.id} constellation … `)
  const { fixture, provenance } = await buildConstellationFixture({
    lat, lng, startUtc: args.date, hours, stepMin,
  })

  const json = JSON.stringify(fixture, null, 2) + '\n'
  const dir = new URL(`../../src/scenarios/fixtures/${args.id}/`, import.meta.url)
  await mkdir(dir, { recursive: true })
  await writeFile(new URL('constellation.json', dir), json)

  const retrievedAt = new Date().toISOString().slice(0, 10)
  const source = {
    fixture: 'constellation.json',
    source: 'CelesTrak — GPS YUMA almanac (US Space Force / NAVCEN)',
    url: provenance.almanacUrl,
    license: ALMANAC_LICENSE,
    attribution: 'GPS almanac courtesy of CelesTrak; source data US Space Force NAVCEN',
    retrievedAt,
    sha256: sha256(json),
    rawBytes: Buffer.byteLength(json),
    almanacWeek: provenance.almanacWeek,
    almanacToa: provenance.almanacToa,
    satellites: `${provenance.satellitesHealthy} healthy of ${provenance.satellitesTotal} in almanac`,
    epochUtc: fixture.startUtc,
    epochStepSec: fixture.stepSec,
    dateKind: args.dateKind ?? 'representative',
    ...(args.note ? { note: args.note } : {}),
    propagation: 'IS-GPS-200 almanac algorithm (no harmonic corrections); az/el at the AO reference position',
  }

  // Same merge discipline as the other fetchers: this run replaces only its own entry.
  const manifestUrl = new URL('manifest.json', dir)
  const previous = await readFile(manifestUrl, 'utf8').then(JSON.parse).catch(() => null)
  const kept = (previous?.sources ?? []).filter((s) => s.fixture !== 'constellation.json')
  await writeFile(manifestUrl, JSON.stringify({
    scenarioId: args.id,
    area: previous?.area ?? {},
    generatedAt: retrievedAt,
    sources: [...kept, source].sort((a, b) => a.fixture.localeCompare(b.fixture)),
  }, null, 2) + '\n')

  const perEpoch = fixture.epochs.map((e) => e.length)
  console.log(
    `\n  week ${provenance.almanacWeek} · ${provenance.satellitesHealthy} healthy sats · ` +
    `${fixture.epochs.length} epochs @ ${stepMin} min · ` +
    `${Math.min(...perEpoch)}–${Math.max(...perEpoch)} above horizon · ` +
    `${(Buffer.byteLength(json) / 1024).toFixed(1)} KB ✓`,
  )
  console.log('  Commit constellation.json + manifest.json; src/ imports them, never fetches.')
}

if (process.argv[1]?.endsWith('constellation.mjs')) {
  cli().catch((error) => {
    console.error(`\n✗ ${error.message}`)
    process.exit(1)
  })
}
