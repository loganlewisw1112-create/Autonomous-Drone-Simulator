// DEMO_BLOCKERS c12a: committed Overture road graphs, their authoring pipeline and the loader.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodeRoadNetwork as decodeFixture,
  getRoadNetwork,
  prepareScenarioRoads,
  prepareScenarioRoadsNonFatal,
  ROAD_CLASS_NAMES,
  scenariosWithRoads,
  type EncodedRoadNetwork,
} from '@/scenarios/roadFixtures'
import { prepareScenarioTerrain } from '@/scenarios/terrainFixtures'
import { aoBbox } from '../../tools/fixtures/aoBbox.mjs'
import {
  buildNetwork,
  CLASS_SPEED_CAP_MPS,
  decodeRoadNetwork as decodeTool,
  directionalAccess,
  edgeSpeedCode,
  encodeRoadNetwork,
  FLAG_BRIDGE,
  FLAG_HIDDEN,
  ladderConfig,
  MAX_SCENARIO_BYTES,
  mergeManifest,
  MINOR_ROAD_CLASSES,
  normalizeRoadFlags,
  selectSegments,
  serializeRoadNetwork,
  stronglyConnectedComponents,
  WATER_TOLERANCE_M,
  wholeSegmentLimitMps,
} from '../../tools/fixtures/roads.mjs'
import { buildRoadTargets } from './roadTargets.gen.spec'

const fixturesRoot = fileURLToPath(new URL('../scenarios/fixtures/', import.meta.url))
const targetsPath = fileURLToPath(new URL('../../tools/fixtures/roadTargets.json', import.meta.url))
const targetsFile = JSON.parse(readFileSync(targetsPath, 'utf8')) as {
  v: number
  targets: Array<{ id: string; bbox: number[]; startPosition: { lat: number; lng: number }; heatSources: unknown[]; usesRecovery: boolean }>
  parked: Array<{ id: string; reason: string; gzipBytes: number }>
}
const committedIds = readdirSync(fixturesRoot).filter((id) => existsSync(join(fixturesRoot, id, 'roads.json')))
const readRoads = (id: string) => readFileSync(join(fixturesRoot, id, 'roads.json'), 'utf8')
const readManifest = (id: string) => JSON.parse(readFileSync(join(fixturesRoot, id, 'manifest.json'), 'utf8'))
const M_PER_DEG = 111195
const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
  Math.hypot((a.lng - b.lng) * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180) * M_PER_DEG, (a.lat - b.lat) * M_PER_DEG)

describe('road targets and coverage', () => {
  it('roadTargets.json matches the incident catalog (ids and bboxes)', () => {
    const expected = buildRoadTargets()
    expect(targetsFile.targets.map((t) => t.id)).toEqual(expected.map((t) => t.id))
    for (const want of expected) {
      const got = targetsFile.targets.find((t) => t.id === want.id)!
      expect(got.bbox, want.id).toEqual(want.bbox)
      expect(got.usesRecovery, want.id).toBe(true)
    }
    expect(targetsFile.targets).toHaveLength(25)
  })

  it('the default AO bbox is the 1500 m aoBbox, widened for heat sources', () => {
    for (const target of targetsFile.targets) {
      const base = aoBbox({ id: target.id, startPosition: target.startPosition }, { marginM: 1500 })
      expect(target.bbox[0], target.id).toBeLessThanOrEqual(base.xmin)
      expect(target.bbox[1], target.id).toBeLessThanOrEqual(base.ymin)
      expect(target.bbox[2], target.id).toBeGreaterThanOrEqual(base.xmax)
      expect(target.bbox[3], target.id).toBeGreaterThanOrEqual(base.ymax)
    }
  })

  it('every target has a fixture or a parked[] entry with a reason, never both', () => {
    const parkedIds = new Set(targetsFile.parked.map((p) => p.id))
    for (const target of targetsFile.targets) {
      const hasFixture = committedIds.includes(target.id)
      if (hasFixture) {
        const network = decodeFixture(JSON.parse(readRoads(target.id)) as EncodedRoadNetwork)
        expect(network.nodes.length, target.id).toBeGreaterThan(0)
        expect(parkedIds.has(target.id), `${target.id} is both shipped and parked`).toBe(false)
      } else {
        const entry = targetsFile.parked.find((p) => p.id === target.id)
        expect(entry, `${target.id} has neither roads.json nor a parked[] entry`).toBeDefined()
        expect(['budget', 'no_network', 'download_failed']).toContain(entry!.reason)
      }
    }
    for (const p of targetsFile.parked) expect(targetsFile.targets.some((t) => t.id === p.id), p.id).toBe(true)
  })

  it('the loader registry lists exactly the committed fixtures', () => {
    expect([...scenariosWithRoads()].sort()).toEqual([...committedIds].sort())
  })

  it('every fixture has manifest provenance and a validated water check', () => {
    for (const id of committedIds) {
      const entry = readManifest(id).sources.find((s: { fixture: string }) => s.fixture === 'roads.json')
      expect(entry, id).toBeDefined()
      expect(entry.source).toBe('Overture Maps Foundation — transportation theme')
      expect(entry.license).toBe('ODbL 1.0')
      expect(entry.attribution).toBe('© OpenStreetMap contributors, Overture Maps Foundation')
      expect(entry.dataRelease).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/)
      expect(entry.client).toEqual({ package: 'overturemaps', version: '1.0.2' })
      expect(entry.sha256).toBe(
        createHash('sha256').update(readRoads(id)).digest('hex'),
      )
      expect(entry.rawBytes).toBe(Buffer.byteLength(readRoads(id)))
      expect(entry.gzipBytes).toBe(gzipSync(readRoads(id), { level: 9 }).byteLength)
      expect(entry.validation.waterChecked, id).toBe(true)
      expect(entry.validation.waterToleranceM, id).toBe(WATER_TOLERANCE_M)
      expect(entry.validation.remainingWaterCrossings, `${id}: unbridged water crossings left`).toBe(0)
      expect(typeof entry.validation.buildingsChecked).toBe('boolean')
      for (const key of ['droppedWaterCrossings', 'droppedBuildingCrossings', 'droppedDisconnectedEdges', 'ambiguousAccessRules']) {
        expect(Number.isInteger(entry.validation[key]), `${id}.${key}`).toBe(true)
      }
      expect(entry.validation.startSnapM, id).not.toBeNull()
      expect(Array.isArray(entry.roadBbox) && entry.roadBbox.length === 4).toBe(true)
      expect(Array.isArray(entry.budgetSteps)).toBe(true)
    }
  })

  it('road fixtures are checked against footprints for exactly the scenarios that ship buildings', () => {
    for (const id of committedIds) {
      const entry = readManifest(id).sources.find((s: { fixture: string }) => s.fixture === 'roads.json')
      expect(entry.validation.buildingsChecked, id).toBe(existsSync(join(fixturesRoot, id, 'buildings.json')))
    }
  })

  it('stays within the per-scenario shipped budget (terrain.png raw, every other counted file gzipped)', () => {
    for (const id of committedIds) {
      let total = 0
      for (const name of ['terrain.png', 'terrain.json', 'terrain-refpoints.json', 'buildings.json', 'roads.json', 'manifest.json']) {
        const file = join(fixturesRoot, id, name)
        if (!existsSync(file)) continue
        const bytes = readFileSync(file)
        total += name.endsWith('.png') ? bytes.length : gzipSync(bytes, { level: 9 }).length
      }
      expect(total, id).toBeLessThanOrEqual(MAX_SCENARIO_BYTES)
    }
  })

  it('the roads manifest merge leaves area (and area.aoBbox) exactly as the terrain/buildings tools wrote it', () => {
    const previous = {
      scenarioId: 'x',
      generatedAt: '2026-01-01',
      area: { lat: 1, lng: 2, aoBbox: [-1, -2, 3, 4] },
      sources: [{ fixture: 'terrain.json' }, { fixture: 'roads.json', roadBbox: [0, 0, 0, 0] }],
    }
    const source = { fixture: 'roads.json', roadBbox: [9, 9, 9, 9] }
    const merged = mergeManifest(previous, { scenarioId: 'x', source })
    expect(merged.area).toEqual(previous.area)
    expect(merged.area.aoBbox).toEqual([-1, -2, 3, 4])
    expect(merged.sources.map((entry: { fixture: string }) => entry.fixture)).toEqual(['roads.json', 'terrain.json'])
    expect(merged.sources[0].roadBbox).toEqual([9, 9, 9, 9]) // the road box lives in the source entry only
    expect(mergeManifest(previous, { scenarioId: 'x', roadsRemoved: true }).area).toEqual(previous.area)
    // no area before means none invented after
    expect('area' in mergeManifest({ scenarioId: 'y', generatedAt: '2026-01-01', sources: [] }, { scenarioId: 'y', source })).toBe(false)
    expect('area' in mergeManifest(null, { scenarioId: 'y', source })).toBe(false)
  })
})

describe('committed road graphs', () => {
  it.each(committedIds)('%s: decoder round-trips within 0.11 m and agrees with the tool decoder', (id) => {
    const encoded = JSON.parse(readRoads(id)) as EncodedRoadNetwork
    const app = decodeFixture(encoded)
    const tool = decodeTool(encoded)
    expect(app.nodes).toHaveLength(tool.nodes.length)
    expect(app.edges).toHaveLength(tool.edges.length)
    app.nodes.forEach((n, i) => expect(metres(n, tool.nodes[i])).toBeLessThan(0.11))
    app.edges.forEach((e, i) => {
      expect(e.points).toHaveLength(tool.edges[i].pts.length)
      e.points.forEach((p, j) => expect(metres(p, tool.edges[i].pts[j])).toBeLessThan(0.11))
    })
    // decode(encode(x)) equals x within 0.11 m
    const again = decodeTool(encodeRoadNetwork(tool))
    again.nodes.forEach((n, i) => expect(metres(n, tool.nodes[i])).toBeLessThan(0.11))
  })

  it.each(committedIds)('%s: strongly connected, no self-loops, no zero-length edges, no oneway 2', (id) => {
    const encoded = JSON.parse(readRoads(id)) as EncodedRoadNetwork
    const net = decodeFixture(encoded)
    const scc = stronglyConnectedComponents(net.nodes.length, net.edges)
    expect(scc.count, `${id} has ${scc.count} strongly connected components`).toBe(1)
    for (const row of encoded.edges) expect([0, 1], id).toContain(row[4])
    for (const e of net.edges) {
      expect(e.from).not.toBe(e.to)
      expect(e.lengthM).toBeGreaterThan(0.1)
      expect([0, 1]).toContain(e.oneway)
      expect(e.points.length).toBeGreaterThanOrEqual(2)
    }
    expect(net.edges.length).toBeGreaterThanOrEqual(20)
    expect(net.entries.length).toBeLessThanOrEqual(8)
    expect([...net.entries]).toEqual([...net.entries].sort((a, b) => a - b))
    expect(new Set(net.entries).size).toBe(net.entries.length)
    for (const entry of net.entries) expect(entry).toBeLessThan(net.nodes.length)
    // every node is used
    const used = new Set<number>()
    net.edges.forEach((e) => { used.add(e.from); used.add(e.to) })
    expect(used.size).toBe(net.nodes.length)
  })

  it.each(committedIds)('%s: edge speeds are within the emergency-response class caps', (id) => {
    const net = decodeFixture(JSON.parse(readRoads(id)) as EncodedRoadNetwork)
    for (const e of net.edges) {
      expect(ROAD_CLASS_NAMES[e.cls]).toBe(e.roadClass)
      expect(e.speedMps).toBeGreaterThanOrEqual(1)
      expect(e.speedMps).toBeLessThanOrEqual(CLASS_SPEED_CAP_MPS[e.roadClass])
    }
    expect(net.maxSpeed).toBe(Math.max(...net.edges.map((e) => e.speedMps)))
  })

  it.each(committedIds)('%s: re-encoding the decoded graph gives the same bytes', (id) => {
    const raw = readRoads(id)
    const decoded = decodeTool(JSON.parse(raw))
    expect(serializeRoadNetwork(encodeRoadNetwork(decoded))).toBe(raw)
  })

  it.each(committedIds)('%s: is shipped as format v1 at 1e6 grid scale with 8-column edge rows', (id) => {
    const encoded = JSON.parse(readRoads(id)) as EncodedRoadNetwork
    expect(encoded.v).toBe(1)
    expect(encoded.scale).toBe(1e6)
    expect(encoded.edges.every((row) => row.length === 8)).toBe(true)
  })

  // Features are NOT clipped to the road bbox: a long segment keeps its far connector, so nodes legitimately
  // sit outside it (measured on the shipped data: up to 9.47 km, on train_wildfire_flank). What does hold is
  // that the manifest records the very bbox in roadTargets.json and that most nodes lie inside it (measured
  // minimum 72.5% on hist_oso_sr530_2014, 34-69 node graphs being the extremes).
  const MIN_NODE_SHARE_INSIDE_ROAD_BBOX = 0.7
  it.each(committedIds)('%s: manifest road bbox is the roadTargets bbox and most nodes lie inside it', (id) => {
    const target = targetsFile.targets.find((t) => t.id === id)!
    expect(target, `${id} has no roadTargets entry`).toBeDefined()
    const entry = readManifest(id).sources.find((s: { fixture: string }) => s.fixture === 'roads.json')
    expect(entry.roadBbox).toEqual(target.bbox)
    expect(entry.downloadBbox).toEqual(target.bbox)
    const [west, south, east, north] = target.bbox
    const inside = (p: { lat: number; lng: number }) => p.lng >= west && p.lng <= east && p.lat >= south && p.lat <= north
    expect(inside(target.startPosition), `${id}: start position outside its own road bbox`).toBe(true)
    const net = decodeFixture(JSON.parse(readRoads(id)) as EncodedRoadNetwork)
    const share = net.nodes.filter(inside).length / net.nodes.length
    expect(share, `${id}: only ${(share * 100).toFixed(1)}% of nodes inside the road bbox`).toBeGreaterThanOrEqual(MIN_NODE_SHARE_INSIDE_ROAD_BBOX)
  })
})

describe('loader', () => {
  const first = committedIds[0]

  it('is staged by prepareScenarioTerrain before the not_required return', async () => {
    expect(first).toBeDefined()
    expect(getRoadNetwork({ id: first })).toBeNull() // null before staging
    const result = await prepareScenarioTerrain({ id: first })
    expect(result.ok).toBe(true)
    const net = getRoadNetwork({ id: first })
    expect(net).not.toBeNull()
    expect(net!.nodes.length).toBeGreaterThan(0)
  })

  it('stages scenarios that have no DEM (they return not_required)', async () => {
    // demo_basic has no terrain package; its roads still stage if a fixture exists.
    const result = await prepareScenarioTerrain({ id: 'demo_basic' })
    expect(result).toEqual({ ok: true, fixtureId: null, state: 'not_required' })
    if (committedIds.includes('demo_basic')) expect(getRoadNetwork({ id: 'demo_basic' })).not.toBeNull()
  })

  it('falls back to the aliased fixture and returns null for unknown scenarios', async () => {
    await prepareScenarioRoads(first)
    expect(getRoadNetwork({ id: 'custom-alias', terrainFixtureId: first })).toBe(getRoadNetwork({ id: first }))
    expect(getRoadNetwork({ id: 'custom-flat' })).toBeNull()
    await expect(prepareScenarioRoads('custom-flat')).resolves.toBeUndefined()
  })

  it('shares one decoded network between callers', async () => {
    await Promise.all([prepareScenarioRoads(first), prepareScenarioRoads(first)])
    expect(getRoadNetwork({ id: first })).toBe(getRoadNetwork({ id: first }))
  })
})

describe('loader failure handling', () => {
  afterEach(() => {
    vi.doUnmock(`@/scenarios/fixtures/${committedIds[0]}/roads.json`)
    vi.resetModules()
    vi.restoreAllMocks()
  })

  // Every test here imports ONE fresh roadFixtures instance and keeps using it, so a loader that cached
  // its failure (a stuck pending promise, a poisoned map entry) would fail the second call below.
  async function freshLoader(id: string, failures: number) {
    const real = JSON.parse(readRoads(id))
    vi.resetModules()
    let calls = 0
    vi.doMock(`@/scenarios/fixtures/${id}/roads.json`, () => {
      calls++
      if (calls <= failures) throw new Error('chunk failed to load')
      return { default: real }
    })
    const mod = await import('@/scenarios/roadFixtures')
    return { mod, chunkLoads: () => calls }
  }

  it('prepareScenarioRoads does not cache a failed import: the next call on the same instance retries and stages', async () => {
    const id = committedIds[0]
    const { mod, chunkLoads } = await freshLoader(id, 1)
    await expect(mod.prepareScenarioRoads(id)).rejects.toThrow() // vitest rewraps a throwing mock factory
    expect(mod.getRoadNetwork({ id })).toBeNull()
    expect(chunkLoads()).toBe(1)
    await mod.prepareScenarioRoads(id) // same instance: must hit the chunk again, not replay the failure
    expect(chunkLoads()).toBe(2)
    expect(mod.getRoadNetwork({ id })).not.toBeNull()
  })

  it('a failed chunk import is non-fatal, logged, not cached, and retried on the next call', async () => {
    const id = committedIds[0]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { mod, chunkLoads } = await freshLoader(id, 2) // both attempts of the first gate call fail
    await expect(mod.prepareScenarioRoadsNonFatal(id)).resolves.toBeUndefined()
    expect(chunkLoads()).toBe(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(mod.getRoadNetwork({ id })).toBeNull()

    // second gate call on the SAME instance: the chunk now loads, so a cached failure would keep it null
    await expect(mod.prepareScenarioRoadsNonFatal(id)).resolves.toBeUndefined()
    expect(chunkLoads()).toBe(3)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(mod.getRoadNetwork({ id })).not.toBeNull()
  })

  it('prepareScenarioRoadsNonFatal retries once inside a single call, so one failed import stages quietly', async () => {
    const id = committedIds[0]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { mod, chunkLoads } = await freshLoader(id, 1)
    await mod.prepareScenarioRoadsNonFatal(id)
    expect(chunkLoads()).toBe(2)
    expect(warn).not.toHaveBeenCalled()
    expect(mod.getRoadNetwork({ id })).not.toBeNull()
  })

  it('prepareScenarioRoadsNonFatal never rejects', async () => {
    await expect(prepareScenarioRoadsNonFatal('does-not-exist')).resolves.toBeUndefined()
  })
})

// ── authoring pipeline on synthetic data ─────────────────────────────────────────────────────

const LAT0 = 40
const LNG0 = -100
const STEP_LAT = 0.002
const STEP_LNG = 0.0026

function gridFeatures(opts: { bridgeRow?: number; classOf?: (row: number) => string } = {}) {
  const features: unknown[] = []
  const cid = (x: number, y: number) => `c${x}_${y}`
  const point = (x: number, y: number) => [LNG0 + x * STEP_LNG, LAT0 + y * STEP_LAT]
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 4; x++) {
      features.push({
        id: `h${x}_${y}`,
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [point(x, y), point(x + 1, y)] },
        properties: {
          subtype: 'road',
          class: opts.classOf ? opts.classOf(y) : 'residential',
          connectors: [{ connector_id: cid(x, y), at: 0 }, { connector_id: cid(x + 1, y), at: 1 }],
          road_flags: opts.bridgeRow === y && x === 1 ? [{ values: ['is_bridge'], between: null }] : null,
          access_restrictions: null,
          speed_limits: [{ max_speed: { value: 25, unit: 'mph' }, when: null, between: null }],
        },
      })
    }
  }
  for (let x = 0; x < 5; x++) {
    for (let y = 0; y < 4; y++) {
      features.push({
        id: `v${x}_${y}`,
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [point(x, y), point(x, y + 1)] },
        properties: {
          subtype: 'road',
          class: 'residential',
          connectors: [{ connector_id: cid(x, y), at: 0 }, { connector_id: cid(x, y + 1), at: 1 }],
          road_flags: null,
          access_restrictions: null,
          speed_limits: [{ max_speed: { value: 25, unit: 'mph' }, when: null, between: null }],
        },
      })
    }
  }
  return features
}

const gridBox: [number, number, number, number] = [LNG0 - 0.001, LAT0 - 0.001, LNG0 + 4 * STEP_LNG + 0.001, LAT0 + 4 * STEP_LAT + 0.001]
const rect = (x0: number, y0: number, x1: number, y1: number) => ({
  type: 'Polygon',
  coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
})
const startPosition = { lat: LAT0, lng: LNG0 }
const run = (extra: Record<string, unknown>) =>
  buildNetwork({
    box: gridBox, startPosition, heatSources: [], config: ladderConfig(0, {}),
    segmentFeatures: [], waterFeatures: [], buildingCollection: null, ...extra,
  })

describe('authoring pipeline', () => {
  it('builds a connected two-way grid with exact speeds and entries', () => {
    const result = run({ segmentFeatures: gridFeatures() })
    const net = result.decoded
    expect(net.edges.length).toBeGreaterThanOrEqual(20)
    expect(stronglyConnectedComponents(net.nodes.length, net.edges).count).toBe(1)
    // 25 mph x 1.15 = 12.9 m/s, capped at the residential 11 m/s.
    expect(new Set(net.edges.map((e) => e.speedMps))).toEqual(new Set([11]))
    expect(result.validation).toMatchObject({ waterChecked: true, droppedWaterCrossings: 0, remainingWaterCrossings: 0 })
    expect(net.entries.length).toBeLessThanOrEqual(8)
  })

  it('drops an unbridged water crossing and keeps a bridged one', () => {
    // A 43 m wide band between junction columns 1 and 2 crossing every row.
    const bandW = LNG0 + 1.4 * STEP_LNG
    const bandE = LNG0 + 1.6 * STEP_LNG
    const water = [{ type: 'Feature', geometry: rect(bandW, LAT0 - 1, bandE, LAT0 + 1), properties: { subtype: 'water', class: 'water' } }]
    const result = run({ segmentFeatures: gridFeatures({ bridgeRow: 2 }), waterFeatures: water })
    expect(result.validation.droppedWaterCrossings).toBe(4)
    expect(result.validation.remainingWaterCrossings).toBe(0)
    const bridged = result.decoded.edges.filter((e) => e.flags & FLAG_BRIDGE)
    expect(bridged).toHaveLength(1)
    expect(stronglyConnectedComponents(result.decoded.nodes.length, result.decoded.edges).count).toBe(1)
  })

  it('ignores intermittent, pool, fountain and drain water, and crossings under the tolerance', () => {
    const bandW = LNG0 + 1.4 * STEP_LNG
    const bandE = LNG0 + 1.6 * STEP_LNG
    const geometry = rect(bandW, LAT0 - 1, bandE, LAT0 + 1)
    const ignored = [
      { is_intermittent: true, class: 'water', subtype: 'water' },
      { class: 'swimming_pool', subtype: 'human_made' },
      { class: 'fountain', subtype: 'human_made' },
      { class: 'drain', subtype: 'canal' },
    ].map((properties) => ({ type: 'Feature', geometry, properties }))
    const none = run({ segmentFeatures: gridFeatures(), waterFeatures: ignored })
    expect(none.validation.droppedWaterCrossings).toBe(0)
    const narrow = rect(LNG0 + 1.5 * STEP_LNG, LAT0 - 1, LNG0 + 1.5 * STEP_LNG + 0.00006, LAT0 + 1) // ~5 m
    const small = run({
      segmentFeatures: gridFeatures(),
      waterFeatures: [{ type: 'Feature', geometry: narrow, properties: { subtype: 'water', class: 'water' } }],
    })
    expect(small.validation.droppedWaterCrossings).toBe(0)
  })

  it('drops edges crossing a building footprint unless tunnel or covered', () => {
    const footprint = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature', properties: { h: 10 },
        geometry: rect(LNG0 + 1.4 * STEP_LNG, LAT0 + 1.9 * STEP_LAT, LNG0 + 1.6 * STEP_LNG, LAT0 + 2.1 * STEP_LAT),
      }],
    }
    const result = run({ segmentFeatures: gridFeatures(), buildingCollection: footprint })
    expect(result.validation.buildingsChecked).toBe(true)
    expect(result.validation.droppedBuildingCrossings).toBe(1)
  })

  it('keeps only the largest strongly connected component and counts the rest', () => {
    const island = [0, 1].map((i) => ({
      id: `island${i}`, type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[LNG0 + 10, LAT0 + i * 0.001], [LNG0 + 10.001, LAT0 + i * 0.001]] },
      properties: {
        subtype: 'road', class: 'residential',
        connectors: [{ connector_id: `i${i}a`, at: 0 }, { connector_id: `i${i}b`, at: 1 }],
      },
    }))
    const box: [number, number, number, number] = [LNG0 - 0.001, LAT0 - 0.001, LNG0 + 10.01, LAT0 + 0.01]
    const result = run({ segmentFeatures: [...gridFeatures(), ...island], box })
    expect(result.validation.droppedDisconnectedEdges).toBe(2)
  })

  it('splits at road_flags between boundaries so bridge status is exact per edge', () => {
    const features = gridFeatures()
    const target = features[0] as { properties: Record<string, unknown> }
    target.properties.road_flags = [{ values: ['is_tunnel'], between: [0.25, 0.75] }]
    const result = run({ segmentFeatures: features })
    const hidden = result.decoded.edges.filter((e) => e.flags & FLAG_HIDDEN)
    expect(hidden).toHaveLength(1)
    const len = hidden[0].pts.reduce((sum, p, i) => (i ? sum + metres(
      { lat: p.lat, lng: p.lng }, { lat: hidden[0].pts[i - 1].lat, lng: hidden[0].pts[i - 1].lng },
    ) : 0), 0)
    const whole = STEP_LNG * Math.cos(LAT0 * Math.PI / 180) * M_PER_DEG
    expect(len).toBeGreaterThan(whole * 0.45)
    expect(len).toBeLessThan(whole * 0.55)
  })
})

describe('budget ladder step 5: minor roads only near the start or a heat source', () => {
  const eastM = (m: number) => LNG0 + m / (Math.cos(LAT0 * Math.PI / 180) * M_PER_DEG)
  const proj = { x: (lng: number) => (lng - LNG0) * Math.cos(LAT0 * Math.PI / 180) * M_PER_DEG, y: (lat: number) => (lat - LAT0) * M_PER_DEG }
  const roadAt = (id: string, roadClass: string, fromM: number, toM: number) => ({
    id,
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [[eastM(fromM), LAT0], [eastM(toM), LAT0]] },
    properties: {
      subtype: 'road', class: roadClass,
      connectors: [{ connector_id: `${id}a`, at: 0 }, { connector_id: `${id}b`, at: 1 }],
      road_flags: null, access_restrictions: null, speed_limits: null,
    },
  })
  // One segment per class 100 m from the start, one 4 km away, one 8 km away next to a heat source.
  const classes = ['residential', 'living_street', 'unclassified', 'service', 'track', 'tertiary', 'primary']
  const features = classes.flatMap((c) => [roadAt(`near-${c}`, c, 100, 300), roadAt(`far-${c}`, c, 4000, 4200), roadAt(`heat-${c}`, c, 8000, 8200)])
  const heat = { lat: LAT0, lng: eastM(8100) }
  const select = (minorNearOnly: { points: Array<{ lat: number; lng: number }>; radiusM: number } | null) =>
    selectSegments(features, { proj, dropClasses: new Set(), minorNearOnly }).segments.map((seg: { id: string }) => seg.id).sort()

  it('names exactly residential, living_street, unclassified, service and track as the minor classes', () => {
    expect([...MINOR_ROAD_CLASSES].sort()).toEqual(['living_street', 'residential', 'service', 'track', 'unclassified'])
  })

  it('without the filter every class survives at every distance', () => {
    expect(select(null)).toHaveLength(classes.length * 3)
  })

  it('keeps a minor class only within 1000 m of the start or a heat source, and tertiary and higher everywhere', () => {
    const kept = new Set(select({ points: [startPosition, heat], radiusM: 1000 }))
    for (const c of classes) {
      expect(kept.has(`near-${c}`), `near-${c}`).toBe(true)
      expect(kept.has(`heat-${c}`), `heat-${c}`).toBe(true)
      expect(kept.has(`far-${c}`), `far-${c}`).toBe(!MINOR_ROAD_CLASSES.has(c))
    }
    expect(kept.has('far-tertiary') && kept.has('far-primary')).toBe(true)
    expect(kept.size).toBe(classes.length * 2 + 2)
  })

  it('is applied by ladderConfig step 5 (and not before) through buildNetwork', () => {
    expect(ladderConfig(4, {}).minorNearOnly).toBeUndefined()
    const step5 = ladderConfig(5, {})
    expect(step5.minorNearOnly).toBe(true)
    expect(step5.applied.join(' ')).toMatch(/residential.*living_street.*unclassified.*service.*track/)
    // The 5 x 4 residential grid spans ~890 m: its two far corner edges (h3_4 and v4_3) sit over 1000 m from the start corner.
    const kept = (step: number) => run({
      segmentFeatures: gridFeatures(), config: ladderConfig(step, { startPosition, heatSources: [] }),
    }).stats.select.kept
    expect(kept(4)).toBe(40)
    expect(kept(5)).toBe(38)
  })
})

describe('access, speed and flag normalisation (real Overture shapes)', () => {
  const when = (over: Record<string, unknown>) => ({ during: null, heading: null, using: null, recognized: null, mode: null, vehicle: null, ...over })

  it('a backward-denied road is one-way forward', () => {
    expect(directionalAccess([{ access_type: 'denied', when: when({ heading: 'backward' }), between: null }]))
      .toEqual({ forward: true, backward: false, ambiguous: 0 })
  })

  it('the last matching rule wins', () => {
    const rules = [
      { access_type: 'denied', when: null, between: null },
      { access_type: 'allowed', when: when({ mode: ['bicycle', 'motor_vehicle'] }), between: null },
    ]
    expect(directionalAccess(rules)).toMatchObject({ forward: true, backward: true })
    expect(directionalAccess([...rules].reverse())).toMatchObject({ forward: false, backward: false })
  })

  it('ignores non-vehicle modes, counts scoped rules as ambiguous, treats designated as allowed', () => {
    expect(directionalAccess([{ access_type: 'denied', when: when({ mode: ['foot', 'bicycle'] }), between: null }]))
      .toEqual({ forward: true, backward: true, ambiguous: 0 })
    expect(directionalAccess([{ access_type: 'denied', when: when({ mode: ['hgv'] }), between: null }]).forward).toBe(true)
    expect(directionalAccess([{ access_type: 'denied', when: when({ recognized: ['as_private'] }), between: null }]))
      .toEqual({ forward: true, backward: true, ambiguous: 1 })
    expect(directionalAccess([{ access_type: 'denied', when: null, between: [0, 0.5] }]).ambiguous).toBe(1)
    expect(directionalAccess([
      { access_type: 'denied', when: null, between: null },
      { access_type: 'designated', when: when({ mode: ['car'] }), between: null },
    ]).forward).toBe(true)
    expect(directionalAccess(null)).toEqual({ forward: true, backward: true, ambiguous: 0 })
  })

  it('speed limits: whole-segment only, mph and km/h converted, capped per class', () => {
    expect(wholeSegmentLimitMps([{ max_speed: { value: 35, unit: 'mph' }, when: null, between: null }])).toBeCloseTo(15.65, 1)
    expect(wholeSegmentLimitMps([{ max_speed: { value: 50, unit: 'km/h' }, when: null, between: null }])).toBeCloseTo(13.89, 1)
    expect(wholeSegmentLimitMps([{ max_speed: { value: 35, unit: 'mph' }, when: null, between: [0, 0.5] }])).toBeNull()
    expect(edgeSpeedCode('motorway', 65 * 0.44704)).toBe(58) // capped at 29 m/s
    expect(edgeSpeedCode('residential', null)).toBe(22)
    expect(edgeSpeedCode('living_street', 5)).toBe(11) // 5 x 1.15 = 5.75 -> 5.5
  })

  it('normalises road_flags objects and bare arrays', () => {
    expect(normalizeRoadFlags([{ values: ['is_bridge'], between: [0.1, 0.2] }])).toEqual([{ values: ['is_bridge'], between: [0.1, 0.2] }])
    expect(normalizeRoadFlags(['is_tunnel'])).toEqual([{ values: ['is_tunnel'], between: null }])
    expect(normalizeRoadFlags(null)).toEqual([])
  })
})

describe('budget guard counts roads.json', () => {
  it('assert-realism-fixture-budget fails when only roads.json pushes a scenario over 500 KB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'road-budget-'))
    try {
      const scenarioDir = join(dir, 'src', 'scenarios', 'fixtures', 'budget_probe')
      mkdirSync(scenarioDir, { recursive: true })
      writeFileSync(join(scenarioDir, 'roads.json'), JSON.stringify({ filler: randomBytes(600 * 1024).toString('base64') }))
      const script = fileURLToPath(new URL('../../scripts/assert-realism-fixture-budget.mjs', import.meta.url))
      const over = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' })
      expect(over.status).toBe(1)
      expect(over.stderr).toContain('budget_probe')
      expect(over.stderr).toContain('exceed')

      writeFileSync(join(scenarioDir, 'roads.json'), JSON.stringify({ filler: 'small' }))
      const ok = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' })
      expect(ok.status).toBe(0)
      expect(ok.stdout).toMatch(/budget_probe: .* KB shipped · roads [\d.]+ KB gzip/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
