/**
 * WP-3 — real FAA UAS Facility Map ceilings (REALISM_ROADMAP §WP-3).
 *
 * Four things are under test, in the order the roadmap cares about them:
 *   1. the AO bbox the fixture tool derives from a scenario's own committed geometry,
 *   2. the frozen fixture → published-ceiling lookup,
 *   3. §WP-3's stated accept criterion — "a route that exceeds the real published ceiling
 *      raises the existing Part 107 attention flag",
 *   4. the determinism-safety case: a scenario with NO fixture must be bit-identical to
 *      pre-WP-3, which is §3's guarantee and the reason this package is safe to land.
 *
 * The bbox helper is imported straight from tools/fixtures/ — it is authoring-time code that
 * must never enter a bundle (§3), so it stays plain ESM and carries a .d.mts for typing here.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { aoBbox, aoPoints, DEFAULT_AO_MARGIN_M } from '../../tools/fixtures/aoBbox.mjs'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { observedAirspaceFor } from '@/scenarios/observedAirspace'
import {
  airspaceCeilingCaption,
  airspaceForScenario,
  findCeilingBreaches,
  plannedRoutePoints,
  publishedCeilingFtAt,
  worstCeilingBreach,
} from '@/sim/mission/airspace'
import { buildComplianceState } from '@/sim/demo/complianceEngine'
import { buildAirspaceCeilingFeatures } from '@/components/tacticalMapGeoJson'
import type { ComplianceState, DroneState, ObservedAirspace, ScenarioConfig, ScenarioVariantConfig, Waypoint } from '@/types'

// One UASFM cell is 30 arc-seconds = 30/3600 degrees. The fetcher asserts the grid is
// axis-aligned; this is the independent check that what got frozen really is that graticule.
const ARC_SEC_30_DEG = 30 / 3600
const METRES_PER_DEG_LAT = 111320

const VARIANT: ScenarioVariantConfig = {
  seed: 2026,
  timeOfDay: 'day',
  season: 'summer',
  weatherSeverity: 1,
  commsDegradation: 0,
  thermalDensity: 1,
  batteryPressure: 0,
  terrainDifficulty: 0,
}

const scenarioById = (id: string): ScenarioConfig => {
  const found = ALL_SCENARIOS.find((s) => s.id === id)
  if (!found) throw new Error(`scenario ${id} missing from the catalog`)
  return found
}

/** Every planned route point of a scenario, as drones parked on them at their planned altitude. */
function droneFleetOnRoute(scenario: ScenarioConfig, altitudeOverrideFt?: number): DroneState[] {
  const routes: Waypoint[][] = Object.values(scenario.perDroneWaypoints ?? {})
  const points = (routes.length > 0 ? routes.flat() : scenario.waypoints)
  return points.map((wp, i) => makeDrone(`uav-${String(i + 1).padStart(2, '0')}`, {
    position: wp.position,
    altitudeFt: altitudeOverrideFt ?? wp.altitudeFt,
  }))
}

function makeDrone(id: string, patch: Partial<DroneState> = {}): DroneState {
  return {
    id,
    label: id.toUpperCase(),
    color: '#00d4ff',
    position: { lat: 40.757, lng: -73.9862 },
    altitudeFt: 120,
    headingDeg: 0,
    speedMs: 10,
    batteryPct: 82,
    signalDbm: -62,
    missionState: 'navigate',
    currentWaypointIndex: 1,
    conflictFlag: false,
    geofenceBreachFlag: false,
    bvlosFlag: false,
    sortieCount: 0,
    ...patch,
  }
}

function makeScenario(overrides: Partial<ScenarioConfig> = {}): ScenarioConfig {
  return {
    id: 'test-scenario',
    name: 'Test Scenario',
    description: 'Synthetic scenario',
    seed: 1,
    droneCount: 1,
    missionType: 'waypoint',
    startPosition: { lat: 37.7695, lng: -122.4862 },
    waypoints: [],
    geofences: [],
    heatSources: [],
    batteryStartPct: 100,
    batteryDrainRatePerSec: 0.01,
    commsLossWindows: [],
    ...overrides,
  }
}

/** A hand-built two-cell grid, so the lookup rules are tested independently of any fixture. */
const SYNTHETIC: ObservedAirspace = {
  source: 'synthetic',
  mapEffective: '1/1/2020',
  unit: 'ft AGL',
  facilities: ['Test Fld (KTST)'],
  airspaceClasses: ['D'],
  bbox: [-100, 40, -99.98, 40.02],
  minCeilingFt: 0,
  maxCeilingFt: 200,
  // Share the -99.99 edge so the shared-boundary rule has something to bite on.
  cells: [
    { ceilingFt: 200, bounds: [-100, 40, -99.99, 40.01] },
    { ceilingFt: 0, bounds: [-99.99, 40, -99.98, 40.01] },
  ],
}

// ── 1. AO bbox derivation ────────────────────────────────────────────────────────────────
describe('WP-3 AO bbox derivation (tools/fixtures/aoBbox.mjs)', () => {
  it('encloses every AO point of every catalog scenario', () => {
    for (const scenario of ALL_SCENARIOS) {
      const bbox = aoBbox(scenario)
      for (const point of aoPoints(scenario)) {
        expect(point.lng).toBeGreaterThanOrEqual(bbox.xmin)
        expect(point.lng).toBeLessThanOrEqual(bbox.xmax)
        expect(point.lat).toBeGreaterThanOrEqual(bbox.ymin)
        expect(point.lat).toBeLessThanOrEqual(bbox.ymax)
      }
    }
  })

  it('pulls in search areas, geofence corners and per-drone routes, not just the start point', () => {
    // Each extreme sits in a different direction, so a bbox that dropped any one source would
    // fail to contain it. Geofences count because the safe-path router detours around them.
    const scenario = makeScenario({
      startPosition: { lat: 40.0, lng: -100.0 },
      searchArea: [{ lat: 40.05, lng: -100.0 }],                                     // north
      geofences: [{ id: 'gf', label: 'GF', polygon: [{ lat: 40.0, lng: -100.06 }], maxAltitudeFt: 100, type: 'restricted' }], // west
      perDroneWaypoints: { 'uav-01': [{ id: 'w', position: { lat: 39.95, lng: -100.0 }, altitudeFt: 100 }] }, // south
      recoverySites: { 'uav-01': { kind: 'helipad', label: 'R', agency: 'PD', position: { lat: 40.0, lng: -99.94 }, surfaceNote: '' } }, // east
    })
    const points = aoPoints(scenario)
    expect(points).toHaveLength(5)

    const bbox = aoBbox(scenario, { marginM: 0 })
    expect(bbox.ymax).toBeCloseTo(40.05, 6)
    expect(bbox.ymin).toBeCloseTo(39.95, 6)
    expect(bbox.xmin).toBeCloseTo(-100.06, 6)
    expect(bbox.xmax).toBeCloseTo(-99.94, 6)
  })

  it('applies the margin on all four sides, at least one UASFM cell wide', () => {
    const bbox = aoBbox(makeScenario({ startPosition: { lat: 40.0, lng: -100.0 } }))
    const latMarginDeg = 40.0 - bbox.ymin
    const lngMarginDeg = -100.0 - bbox.xmin

    expect(latMarginDeg).toBeCloseTo(DEFAULT_AO_MARGIN_M / METRES_PER_DEG_LAT, 5)
    expect(bbox.ymax - 40.0).toBeCloseTo(latMarginDeg, 9)
    expect(bbox.xmax + 100.0).toBeCloseTo(lngMarginDeg, 9)
    // Longitude degrees are shorter away from the equator, so the same metres buy more degrees.
    expect(lngMarginDeg).toBeGreaterThan(latMarginDeg)
    // The whole point of the margin: a point on the AO edge still gets its containing cell.
    expect(latMarginDeg).toBeGreaterThan(ARC_SEC_30_DEG)
  })

  it('gives a degenerate single-point scenario a real, non-zero-area box', () => {
    const bbox = aoBbox(makeScenario({ startPosition: { lat: 40.0, lng: -74.0 }, waypoints: [] }))
    expect(bbox.xmax).toBeGreaterThan(bbox.xmin)
    expect(bbox.ymax).toBeGreaterThan(bbox.ymin)
  })

  it('is deterministic and rounded to 6dp, so a regenerated fixture hashes identically', () => {
    const scenario = scenarioById('train_hazmat_plume')
    expect(aoBbox(scenario)).toEqual(aoBbox(scenario))
    for (const value of Object.values(aoBbox(scenario))) {
      expect(value).toBe(Math.round(value * 1e6) / 1e6)
    }
  })

  it('throws rather than inventing a box when a scenario has no usable geometry', () => {
    expect(() => aoBbox({ id: 'empty' })).toThrow(/no usable geometry/)
  })
})

// ── 2. The frozen fixtures ───────────────────────────────────────────────────────────────
describe('WP-3 frozen UASFM fixtures', () => {
  const withGrid = ALL_SCENARIOS.filter((s) => observedAirspaceFor(s.id))

  it('covers the scenarios the FAA actually publishes a facility map over', () => {
    expect(withGrid.length).toBeGreaterThanOrEqual(2)
    expect(withGrid.map((s) => s.id)).toContain('train_hazmat_plume')
    expect(withGrid.map((s) => s.id)).toContain('train_uscg_maritime_sar')
  })

  it('freezes a well-formed 30 arc-second grid with sane published ceilings', () => {
    for (const scenario of withGrid) {
      const airspace = observedAirspaceFor(scenario.id) as ObservedAirspace
      expect(airspace.cells.length).toBeGreaterThan(0)
      expect(airspace.mapEffective).toMatch(/\d/)
      expect(airspace.unit).toBe('ft AGL')

      for (const cell of airspace.cells) {
        expect(cell.bounds).toHaveLength(4)
        const [west, south, east, north] = cell.bounds
        expect(east).toBeGreaterThan(west)
        expect(north).toBeGreaterThan(south)
        expect(east - west).toBeCloseTo(ARC_SEC_30_DEG, 4)
        expect(north - south).toBeCloseTo(ARC_SEC_30_DEG, 4)
        // Published ceilings are whole 50ft steps from 0 to the Part 107 400ft limit.
        expect(cell.ceilingFt).toBeGreaterThanOrEqual(0)
        expect(cell.ceilingFt).toBeLessThanOrEqual(400)
        expect(cell.ceilingFt % 50).toBe(0)
      }

      const ceilings = airspace.cells.map((c) => c.ceilingFt)
      expect(airspace.minCeilingFt).toBe(Math.min(...ceilings))
      expect(airspace.maxCeilingFt).toBe(Math.max(...ceilings))
    }
  })

  it('stays inside §19\'s ~20 KB per-scenario airspace budget', () => {
    const fixtureSourceByScenario: Record<string, string> = {
      train_uscg_maritime_sar: 'extreme_uscg_cape_cod_sar',
      train_hazmat_plume: 'extreme_dhs_port_la_chemical',
      demo_perimeter: 'demo_perimeter',
    }
    for (const scenario of withGrid) {
      const fixtureId = fixtureSourceByScenario[scenario.id] ?? scenario.id
      const bytes = readFileSync(`src/scenarios/fixtures/${fixtureId}/airspace.json`).byteLength
      expect(bytes).toBeLessThanOrEqual(20 * 1024)
    }
  })

  it('keys the static import map only to real scenario ids', () => {
    const catalogIds = new Set(ALL_SCENARIOS.map((s) => s.id))
    for (const scenario of withGrid) expect(catalogIds.has(scenario.id)).toBe(true)
  })
})

// ── 3. The lookup ────────────────────────────────────────────────────────────────────────
describe('WP-3 published-ceiling lookup', () => {
  it('reads the published ceiling inside a cell and undefined outside the grid', () => {
    expect(publishedCeilingFtAt(SYNTHETIC, { lat: 40.005, lng: -99.995 })).toBe(200)
    expect(publishedCeilingFtAt(SYNTHETIC, { lat: 40.005, lng: -99.985 })).toBe(0)
    expect(publishedCeilingFtAt(SYNTHETIC, { lat: 41.0, lng: -99.985 })).toBeUndefined()
    expect(publishedCeilingFtAt(undefined, { lat: 40.005, lng: -99.995 })).toBeUndefined()
  })

  it('takes the lowest ceiling on a shared cell boundary', () => {
    // -99.99 is the east edge of the 200ft cell and the west edge of the 0ft cell. Erring low
    // on a regulatory surface is the defensible direction to be wrong.
    expect(publishedCeilingFtAt(SYNTHETIC, { lat: 40.005, lng: -99.99 })).toBe(0)
  })

  it('flags only points strictly above their published ceiling', () => {
    const at = { lat: 40.005, lng: -99.995 }
    expect(findCeilingBreaches(SYNTHETIC, [{ position: at, altitudeFt: 199 }])).toHaveLength(0)
    expect(findCeilingBreaches(SYNTHETIC, [{ position: at, altitudeFt: 200 }])).toHaveLength(0)
    expect(findCeilingBreaches(SYNTHETIC, [{ position: at, altitudeFt: 201 }])).toHaveLength(1)
  })

  it('never flags a grounded aircraft or a point outside the published grid', () => {
    const overZero = { lat: 40.005, lng: -99.985 }   // published 0ft
    const offGrid = { lat: 41.0, lng: -99.985 }      // no published ceiling at all
    expect(findCeilingBreaches(SYNTHETIC, [{ position: overZero, altitudeFt: 0 }])).toHaveLength(0)
    expect(findCeilingBreaches(SYNTHETIC, [{ position: offGrid, altitudeFt: 400 }])).toHaveLength(0)
    expect(findCeilingBreaches(undefined, [{ position: overZero, altitudeFt: 400 }])).toHaveLength(0)
  })

  it('picks the largest exceedance as the worst breach, independent of input order', () => {
    const small = { position: { lat: 40.005, lng: -99.995 }, altitudeFt: 250 } // 50ft over 200ft
    const big = { position: { lat: 40.005, lng: -99.985 }, altitudeFt: 120 }   // 120ft over 0ft
    expect(worstCeilingBreach(SYNTHETIC, [small, big])?.altitudeFt).toBe(120)
    expect(worstCeilingBreach(SYNTHETIC, [big, small])?.altitudeFt).toBe(120)
    expect(worstCeilingBreach(SYNTHETIC, [small])?.publishedCeilingFt).toBe(200)
    expect(worstCeilingBreach(SYNTHETIC, [])).toBeUndefined()
  })

  it('collects planned route points from both shared and per-drone routes', () => {
    const timesSquare = scenarioById('train_hazmat_plume')
    const planned = plannedRoutePoints(timesSquare)
    expect(planned.length).toBe(Object.values(timesSquare.perDroneWaypoints ?? {}).flat().length)
    expect(planned.every((p) => Number.isFinite(p.altitudeFt))).toBe(true)
    expect(plannedRoutePoints(null)).toEqual([])
    expect(plannedRoutePoints({ waypoints: [], perDroneWaypoints: {}, authoredRoutes: {} })).toEqual([])
  })

  it('carries MAP_EFF into every finding and into the UI caption', () => {
    const breach = worstCeilingBreach(SYNTHETIC, [{ position: { lat: 40.005, lng: -99.985 }, altitudeFt: 300 }])
    expect(breach?.mapEffective).toBe('1/1/2020')

    const timesSquare = airspaceForScenario('train_hazmat_plume') as ObservedAirspace
    expect(airspaceCeilingCaption(timesSquare)).toContain(`eff ${timesSquare.mapEffective}`)
    expect(airspaceCeilingCaption(undefined)).toBeUndefined()
  })
})

// ── 4. §WP-3's stated accept criterion ───────────────────────────────────────────────────
describe('WP-3 accept criterion — the Part 107 attention flag', () => {
  // Port of Oakland perimeter overwatch holds at 140ft; the FAA publishes 100ft over some cells.
  const scenario = scenarioById('demo_perimeter')

  it('raises the existing Part 107 attention flag when a route exceeds the real published ceiling', () => {
    const compliance = buildComplianceState({
      scenario,
      drones: droneFleetOnRoute(scenario),
      scenarioVariant: VARIANT,
      elapsedSec: 60,
    })

    const flag = compliance.waiverFlags.find((f) => f.label === 'Published ceiling attention')
    expect(flag).toBeDefined()
    // The EXISTING flag kind — WP-3 raises the Part 107 flag the panel already renders rather
    // than inventing a parallel one.
    expect(flag?.kind).toBe('altitude_limit')
    expect(flag?.detail).toMatch(/the FAA publishes at \d+ft/)
    expect(flag?.detail).toContain(`eff ${(airspaceForScenario(scenario.id) as ObservedAirspace).mapEffective}`)
    // "attention", the roadmap's own word for this criterion — not "blocked".
    expect(compliance.airspace.authorization.status).toBe('attention')
  })

  it('raises it from the plan alone, before anything has launched', () => {
    // Every airframe grounded at 0ft: the finding comes from the *planned* route, which is what
    // makes it a pre-launch warning an operator can act on rather than an after-the-fact note.
    const compliance = buildComplianceState({
      scenario,
      drones: [makeDrone('uav-01', { position: scenario.startPosition, altitudeFt: 0, missionState: 'preflight' })],
      scenarioVariant: VARIANT,
      elapsedSec: 0,
    })
    expect(compliance.waiverFlags.some((f) => f.label === 'Published ceiling attention')).toBe(true)
  })

  it('stays clear when a real published grid accommodates the planned route', () => {
    // train_hazmat_plume routes sit outside the committed KTOA grid envelope — no published
    // ceiling is not the same as a breach, and must stay clear.
    const clear = scenarioById('train_hazmat_plume')
    expect(airspaceForScenario(clear.id)).toBeDefined()

    const compliance = buildComplianceState({
      scenario: clear,
      drones: droneFleetOnRoute(clear),
      scenarioVariant: VARIANT,
      elapsedSec: 60,
    })
    expect(compliance.waiverFlags.some((f) => f.label === 'Published ceiling attention')).toBe(false)
    // No Part 107 altitude flag of any kind — WP-3 must not manufacture findings.
    expect(compliance.waiverFlags.some((f) => f.kind === 'altitude_limit')).toBe(false)
  })

  it('leaves the blanket 400ft Part 107 check exactly as it was', () => {
    const compliance = buildComplianceState({
      scenario,
      drones: [makeDrone('uav-01', { position: scenario.startPosition, altitudeFt: 420 })],
      scenarioVariant: VARIANT,
      elapsedSec: 60,
    })
    const blanket = compliance.waiverFlags.find((f) => f.label === 'Altitude limit attention')
    expect(blanket?.kind).toBe('altitude_limit')
    expect(blanket?.severity).toBe('critical')
    expect(blanket?.detail).toBe('Max observed altitude is 420ft AGL; demo should show mitigation below 400ft.')
  })

  it('keeps the simulation-only labelling at full strength (§17 — real data, simulated authorisation)', () => {
    const perimeter = scenarioById('demo_perimeter')
    const compliance = buildComplianceState({
      scenario: perimeter,
      drones: droneFleetOnRoute(perimeter),
      scenarioVariant: VARIANT,
      elapsedSec: 60,
    })
    expect(compliance.disclaimer).toBe(
      'simulation-only compliance readiness for demonstration use; no real FAA, LAANC, USS, or drone broadcast integration is performed.',
    )
    expect(compliance.airspace.authorization.label).toContain('Simulated')
    const ceilingFlag = compliance.waiverFlags.find((f) => f.label === 'Published ceiling attention')
    if (ceilingFlag) {
      expect(ceilingFlag.detail).toContain('simulated authorization only')
    }
    // The published grid is stated as real data on the checklist, and never as an authorisation.
    const provenance = compliance.checklist.find((f) => f.label === 'Published UAS Facility Map ceilings')
    expect(provenance?.detail).toContain('Real FAA published data; authorization remains simulated.')
  })
})

// ── 5. The determinism-safety case ───────────────────────────────────────────────────────
describe('WP-3 determinism safety — scenarios with no published grid', () => {
  // demo_sar_coastal is Ocean Beach. The San Francisco facility-map grid stops at 37.7333 N,
  // south of the AO, so the FAA publishes nothing here — a real answer, not a gap in the work.
  const scenario = scenarioById('demo_sar_coastal')
  const drones = [makeDrone('uav-01', { position: { ...scenario.startPosition }, altitudeFt: 120 })]

  /** The exact ComplianceState this scenario produced before WP-3 existed. */
  const PRE_WP3: ComplianceState = {
    remoteId: { status: 'broadcasting', broadcastingDroneIds: ['uav-01'], degradedDroneIds: [] },
    airspace: {
      authorization: {
        kind: 'simulated_laanc',
        status: 'ready',
        label: 'Simulated LAANC / USS authorization',
        reference: 'Authorization state is derived locally from scenario metadata and visible constraints.',
      },
      maxObservedAltitudeFt: 120,
    },
    waiverFlags: [],
    checklist: [
      {
        kind: 'remote_id',
        severity: 'routine',
        label: 'Remote ID broadcast',
        detail: '1 simulated airframes broadcasting (independent of C2 link).',
      },
      {
        kind: 'laanc',
        severity: 'routine',
        label: 'Simulated LAANC / USS authorization',
        detail: 'Authorization state is derived locally from scenario metadata and visible constraints.',
      },
    ],
    disclaimer: 'simulation-only compliance readiness for demonstration use; no real FAA, LAANC, USS, or drone broadcast integration is performed.',
  }

  it('has no fixture, because the FAA publishes no facility map over the AO', () => {
    expect(observedAirspaceFor('demo_sar_coastal')).toBeUndefined()
    expect(airspaceForScenario('demo_sar_coastal')).toBeUndefined()
    expect(airspaceForScenario(undefined)).toBeUndefined()
  })

  it('is bit-identical to its pre-WP-3 compliance output', () => {
    const compliance = buildComplianceState({ scenario, drones, scenarioVariant: VARIANT, elapsedSec: 30 })
    expect(compliance).toEqual(PRE_WP3)
    expect(JSON.stringify(compliance)).toBe(JSON.stringify(PRE_WP3))
  })

  it('leaves no WP-3 trace anywhere in the output', () => {
    const serialized = JSON.stringify(
      buildComplianceState({ scenario, drones, scenarioVariant: VARIANT, elapsedSec: 30 }),
    )
    expect(serialized).not.toContain('Published ceiling')
    expect(serialized).not.toContain('UAS Facility Map')
    expect(buildAirspaceCeilingFeatures(airspaceForScenario('demo_sar_coastal'))).toEqual([])
  })

  it('reports honestly that most of the catalog has no published grid', () => {
    const covered = ALL_SCENARIOS.filter((s) => observedAirspaceFor(s.id))
    expect(covered.length).toBeLessThan(ALL_SCENARIOS.length)
    expect(covered.length).toBeGreaterThan(0)
  })
})

// ── 6. The rendered layer ────────────────────────────────────────────────────────────────
describe('WP-3 ceiling grid rendering', () => {
  it('rebuilds each stored cell into a closed ring carrying its ceiling and MAP_EFF', () => {
    const features = buildAirspaceCeilingFeatures(SYNTHETIC)
    expect(features).toHaveLength(2)

    const [first] = features
    expect(first.geometry.type).toBe('Polygon')
    const ring = first.geometry.coordinates[0]
    expect(ring).toHaveLength(5)
    expect(ring[0]).toEqual(ring[4])                       // closed
    expect(ring[0]).toEqual([-100, 40])                    // [west, south]
    expect(ring[2]).toEqual([-99.99, 40.01])               // [east, north]
    expect(first.properties.ceilingFt).toBe(200)
    expect(first.properties.mapEffective).toBe('1/1/2020')
    expect(first.properties.label).toContain('eff 1/1/2020')
  })

  it('renders the real Times Square grid and nothing at all without a fixture', () => {
    const airspace = airspaceForScenario('train_hazmat_plume') as ObservedAirspace
    expect(buildAirspaceCeilingFeatures(airspace)).toHaveLength(airspace.cells.length)
    expect(buildAirspaceCeilingFeatures(undefined)).toEqual([])
  })
})
