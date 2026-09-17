// FAA UASFM airspace-ceiling fixture writer CLI (REALISM_ROADMAP WP-3 / WP-0).
//
// Authoring-time ONLY. Lives under tools/, never bundled, never imported by src/ — the same
// contract every fetcher here keeps, so the determinism rule (§3) survives: real FAA data is
// fetched HERE, frozen to a committed fixture, replayed at runtime, never fetched at runtime.
//
// The fetch/normalise/serialise logic lives in faaUasfm.mjs; this file is only the CLI that
// resolves an AO envelope, calls it, and writes the fixture + a merged provenance manifest.
//
// ─── AO ENVELOPE ────────────────────────────────────────────────────────────────────────────
// aoBbox() derives the true route envelope from a scenario's committed geometry, but that lives
// in the TypeScript catalog and this is plain Node with no build step. So, exactly like
// buildings.mjs, the envelope is read from the committed terrain.json a scenario already carries
// (its `requestedBbox`) — every WP-4 terrain AO has one, and it is the same 5 km box the DEM was
// cut to. A scenario with no terrain fixture must pass --bbox explicitly.
//
//   node tools/fixtures/airspace.mjs --id hist_surfside_cts_2021
//   node tools/fixtures/airspace.mjs --id demo_perimeter --bbox -122.305252,37.780025,-122.263598,37.813625
//
// ─── THE HONEST EMPTY ───────────────────────────────────────────────────────────────────────
// FAA UASFM cells exist only under charted facility maps. Rural AOs (a landslide flank, a lava
// field) legitimately have none. When the fetch returns zero cells this writes NO airspace.json
// and removes any stale one, so src/ takes the untouched "no published map" path — a real
// answer, not a gap to paper over.

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { fetchAirspaceCeilings, serializeAirspaceFixture } from './faaUasfm.mjs'

const sha256 = (s) => createHash('sha256').update(s).digest('hex')

/** terrain.json's requestedBbox/bounds ({west,south,east,north}) → an ArcGIS envelope. */
function bboxFromTerrainBounds(bounds) {
  const b = bounds?.requestedBbox ?? bounds?.bounds ?? bounds
  const west = b.west ?? b[0]
  const south = b.south ?? b[1]
  const east = b.east ?? b[2]
  const north = b.north ?? b[3]
  return { xmin: west, ymin: south, xmax: east, ymax: north }
}

export async function writeAirspaceFixture({ dir, scenarioId, bbox }) {
  const { url, license, airspace } = await fetchAirspaceCeilings(bbox)
  const airspaceUrl = new URL('airspace.json', dir)
  const manifestUrl = new URL('manifest.json', dir)
  const previous = await readFile(manifestUrl, 'utf8').then(JSON.parse).catch(() => null)

  // No published facility map here: remove any stale fixture + manifest entry, write nothing new.
  if (!airspace.cells || airspace.cells.length === 0) {
    await rm(airspaceUrl, { force: true })
    if (previous) {
      const kept = (previous.sources ?? []).filter((s) => s.fixture !== 'airspace.json')
      await writeFile(manifestUrl, JSON.stringify({ ...previous, sources: kept }, null, 2) + '\n')
    }
    return { cells: 0, bytes: 0 }
  }

  const bytes = serializeAirspaceFixture(airspace)
  await mkdir(dir, { recursive: true })
  await writeFile(airspaceUrl, bytes)

  const source = {
    fixture: 'airspace.json',
    source: airspace.source,
    url,
    license,
    retrievedAt: new Date().toISOString().slice(0, 10),
    sha256: sha256(bytes),
    mapEffective: airspace.mapEffective,
    facilities: airspace.facilities,
    ceilingRangeFt: [airspace.minCeilingFt, airspace.maxCeilingFt],
  }
  const kept = (previous?.sources ?? []).filter((s) => s.fixture !== 'airspace.json')
  const manifest = {
    // Preserve any top-level field an earlier fetcher wrote (openMeteo's required `realDate`);
    // an airspace run owns only scenarioId / area.aoBbox / generatedAt / sources.
    ...(previous ?? {}),
    scenarioId,
    area: { ...(previous?.area ?? {}), aoBbox: [bbox.xmin, bbox.ymin, bbox.xmax, bbox.ymax] },
    generatedAt: new Date().toISOString().slice(0, 10),
    sources: [...kept, source].sort((a, b) => a.fixture.localeCompare(b.fixture)),
  }
  await writeFile(manifestUrl, JSON.stringify(manifest, null, 2) + '\n')
  return { cells: airspace.cells.length, bytes: Buffer.byteLength(bytes), airspace }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    out[argv[i].slice(2)] = argv[++i]
  }
  return out
}

async function cli() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.id) {
    console.error('usage: node tools/fixtures/airspace.mjs --id <scenarioId> [--bbox xmin,ymin,xmax,ymax]')
    process.exit(1)
  }
  const dir = new URL(`../../src/scenarios/fixtures/${args.id}/`, import.meta.url)

  let bbox
  if (args.bbox) {
    const [xmin, ymin, xmax, ymax] = args.bbox.split(',').map(Number)
    bbox = { xmin, ymin, xmax, ymax }
  } else {
    const terrain = await readFile(new URL('terrain.json', dir), 'utf8')
      .then(JSON.parse)
      .catch(() => { throw new Error(`${args.id}: no terrain.json to derive a bbox from; pass --bbox`) })
    bbox = bboxFromTerrainBounds(terrain)
  }

  process.stdout.write(`• ${args.id} airspace … `)
  const res = await writeAirspaceFixture({ dir, scenarioId: args.id, bbox })
  if (res.cells === 0) {
    console.log('no published UASFM facility map for this AO — wrote no fixture (real answer).')
    return
  }
  const a = res.airspace
  console.log(
    `\n  ${res.cells} cells · ceilings ${a.minCeilingFt}–${a.maxCeilingFt} ft AGL · ` +
    `${a.facilities.join(', ') || 'no named facility'} · eff ${a.mapEffective} · ` +
    `${(res.bytes / 1024).toFixed(1)} KB ✓`,
  )
  console.log('  Commit airspace.json + manifest.json; wire it into observedAirspace.ts.')
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (invoked === import.meta.url || process.argv[1]?.endsWith('airspace.mjs')) {
  cli().catch((e) => {
    console.error('\nairspace fixture failed:', e.message)
    process.exit(1)
  })
}
