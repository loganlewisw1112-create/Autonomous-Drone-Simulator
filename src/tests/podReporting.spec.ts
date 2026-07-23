import { describe, expect, it } from 'vitest'
import { buildSectorPodReport, polygonAreaM2, SAR_TARGET_SIZE_M } from '@/sim/sensors/podReporting'
import { PLATFORM_CATALOG } from '@/sim/drone/platformCatalog'
import { effectiveDetectionRangeM } from '@/sim/sensors/thermalRange'
import { sweepWidthM } from '@/sim/sensors/sweepWidth'
import type { OcclusionService } from '@/sim/terrain/OcclusionService'
import type { DroneState, LatLng, ScenarioConfig } from '@/types'

// A ~1 km square sector at the equator-ish origin, big enough that a few hundred metres of track
// gives a coverage figure in the interesting part of the POD curve rather than saturating it.
const SW = { lat: 37, lng: -122 }
const SECTOR: LatLng[] = [
  { lat: 37, lng: -122 },
  { lat: 37.009, lng: -122 },
  { lat: 37.009, lng: -121.9887 },
  { lat: 37, lng: -121.9887 },
]

function scenario(overrides: Partial<ScenarioConfig> = {}): ScenarioConfig {
  return {
    id: 'pod-test',
    name: 'POD Test',
    description: 'POD test fixture',
    seed: 1,
    droneCount: 1,
    missionType: 'sar_parallel',
    startPosition: SW,
    waypoints: [],
    geofences: [],
    heatSources: [],
    batteryStartPct: 100,
    batteryDrainRatePerSec: 0.01,
    commsLossWindows: [],
    searchArea: SECTOR,
    ...overrides,
  }
}

function drone(overrides: Partial<DroneState> = {}): DroneState {
  return {
    id: 'uav-01',
    label: 'UAV-01',
    color: '#fff',
    position: SW,
    altitudeFt: 120,
    headingDeg: 90,
    speedMs: 8,
    batteryPct: 80,
    signalDbm: -60,
    missionState: 'sar_grid',
    currentWaypointIndex: 0,
    conflictFlag: false,
    geofenceBreachFlag: false,
    bvlosFlag: false,
    sortieCount: 1,
    launchTimeSec: 0,
    ...overrides,
  }
}

/** A single straight east-west leg inside the sector, `fraction` of the full sector width. */
function leg(fraction: number): LatLng[] {
  const west = -121.999
  return [{ lat: 37.004, lng: west }, { lat: 37.004, lng: west + 0.0093 * fraction }]
}

/** An east-west track inside the sector, `rows` passes long. */
function track(rows: number): LatLng[] {
  const points: LatLng[] = []
  for (let row = 0; row < rows; row += 1) {
    const lat = 37.001 + row * 0.001
    points.push({ lat, lng: -121.999 }, { lat, lng: -121.9897 })
  }
  return points
}

/** Flat bare-earth occlusion: everything visible. Isolates the effort term from the LOS term. */
const clearOcclusion: OcclusionService = {
  groundElevation: () => 0,
  surfaceHeight: () => 0,
  hasLineOfSight: () => ({ clear: true, blockedBy: null, blockHeight: null, blockedAt: null, clearanceM: 100 }),
  skyVisibility: () => true,
}

/** Everything occluded — the "never achieved LOS" case the accept criterion names. */
const blockedOcclusion: OcclusionService = {
  ...clearOcclusion,
  hasLineOfSight: () => ({ clear: false, blockedBy: 'terrain', blockHeight: 500, blockedAt: SW, clearanceM: -50 }),
}

// Skydio X10 publishes the full optics chain (12 µm pitch, 13.6 mm EFL, 30 mK NETD), so it is
// the platform that can produce a sourced R_d. Freefly publishes no thermal payload at all.
const SOURCED = { 'uav-01': 'skydio_x10' } as const
const UNSOURCED = { 'uav-01': 'freefly_astro_max' } as const

describe('sector POD reporting (WP-6)', () => {
  it('closes the R_d → W → coverage → POD chain with the live WP-5 detection range', () => {
    const report = buildSectorPodReport({
      scenario: scenario({ dronePlatforms: { ...SOURCED } }),
      drones: [drone()],
      positionHistory: { 'uav-01': track(4) },
      occlusion: clearOcclusion,
    })

    const sweep = report.sweeps[0]
    expect(sweep.status).toBe('ok')

    // R_d is the same function the live thermal gate calls — not a re-derivation.
    const expectedRd = effectiveDetectionRangeM(PLATFORM_CATALOG.skydio_x10.thermal, SAR_TARGET_SIZE_M, 1)
    expect(sweep.detectionRadiusM).toBeCloseTo(expectedRd as number, 6)
    expect(sweep.sweepWidthM).toBeCloseTo(sweepWidthM(expectedRd as number), 6)

    // ...and the reported POD is exactly the documented curve over that chain.
    const expectedCoverage = (sweep.effectiveEffortM * sweep.sweepWidthM) / report.sectorAreaM2
    expect(sweep.coverage).toBeCloseTo(expectedCoverage, 9)
    expect(sweep.pod).toBeCloseTo(1 - Math.exp(-expectedCoverage), 9)
    expect(report.cumulativePod).toBeCloseTo(sweep.pod as number, 9)
  })

  it('a second sweep of the same sector raises POD along the documented curve', () => {
    const base = {
      scenario: scenario({ dronePlatforms: { ...SOURCED } }),
      drones: [drone()],
      occlusion: clearOcclusion,
    }
    // A single straight leg, then exactly twice that leg — so effort doubles precisely and the
    // shape of the POD curve is what is under test, not the geometry of a zigzag.
    const one = buildSectorPodReport({ ...base, positionHistory: { 'uav-01': leg(0.5) } })
    const two = buildSectorPodReport({ ...base, positionHistory: { 'uav-01': leg(1) } })

    expect(two.sweeps[0].trackLengthM).toBeCloseTo(one.sweeps[0].trackLengthM * 2, 6)
    expect(two.sweeps[0].pod as number).toBeGreaterThan(one.sweeps[0].pod as number)
    // Twice the effort is the same coverage doubled, so POD lands on 1 − e^(−2c), not on 2·POD.
    // That diminishing return is the whole "re-sweep or move on" tradeoff.
    expect(two.sweeps[0].coverage).toBeCloseTo(one.sweeps[0].coverage * 2, 6)
    expect(two.sweeps[0].pod as number).toBeCloseTo(1 - Math.exp(-one.sweeps[0].coverage * 2), 9)
    expect(two.sweeps[0].pod as number).toBeLessThan((one.sweeps[0].pod as number) * 2)
  })

  it('a second drone sweeping the sector raises cumulative POD as an independent sweep', () => {
    const two = buildSectorPodReport({
      scenario: scenario({ droneCount: 2, dronePlatforms: { 'uav-01': 'skydio_x10', 'uav-02': 'skydio_x10' } }),
      drones: [drone(), drone({ id: 'uav-02', label: 'UAV-02' })],
      positionHistory: { 'uav-01': track(2), 'uav-02': track(2) },
      occlusion: clearOcclusion,
    })
    const [a, b] = two.sweeps
    expect(two.cumulativePod).toBeCloseTo(1 - (1 - (a.pod as number)) * (1 - (b.pod as number)), 9)
    expect(two.cumulativePod as number).toBeGreaterThan(a.pod as number)
  })

  it('POD is 0 where LOS was never achieved', () => {
    const report = buildSectorPodReport({
      scenario: scenario({ dronePlatforms: { ...SOURCED } }),
      drones: [drone()],
      positionHistory: { 'uav-01': track(4) },
      occlusion: blockedOcclusion,
    })
    const sweep = report.sweeps[0]
    expect(sweep.status).toBe('no_los')
    expect(sweep.losFraction).toBe(0)
    expect(sweep.effectiveEffortM).toBe(0)
    // Zero, not null: the sweep is fully sourced and genuinely detected nothing.
    expect(sweep.pod).toBe(0)
    expect(report.cumulativePod).toBe(0)
    // The track was still flown, and is still reported as flown.
    expect(sweep.trackLengthM).toBeGreaterThan(0)
  })

  it('partial occlusion scales coverage below the fully visible sweep', () => {
    let call = 0
    const halfOccluded: OcclusionService = {
      ...clearOcclusion,
      // Probes run in (left, right) pairs per sample; block one edge of every swath.
      hasLineOfSight: () => (call++ % 2 === 0
        ? { clear: true, blockedBy: null, blockHeight: null, blockedAt: null, clearanceM: 10 }
        : { clear: false, blockedBy: 'building', blockHeight: 40, blockedAt: SW, clearanceM: -5 }),
    }
    const input = {
      scenario: scenario({ dronePlatforms: { ...SOURCED } }),
      drones: [drone()],
      positionHistory: { 'uav-01': track(4) },
    }
    const full = buildSectorPodReport({ ...input, occlusion: clearOcclusion })
    const half = buildSectorPodReport({ ...input, occlusion: halfOccluded })

    expect(half.sweeps[0].losFraction).toBeCloseTo(0.5, 6)
    expect(half.sweeps[0].effectiveEffortM).toBeCloseTo(full.sweeps[0].effectiveEffortM / 2, 6)
    expect(half.sweeps[0].pod as number).toBeLessThan(full.sweeps[0].pod as number)
    expect(half.sweeps[0].status).toBe('ok')
  })

  it('never invents a detection radius for a platform with unpublished optics', () => {
    const report = buildSectorPodReport({
      scenario: scenario({ dronePlatforms: { ...UNSOURCED } }),
      drones: [drone()],
      positionHistory: { 'uav-01': track(4) },
      occlusion: clearOcclusion,
    })
    const sweep = report.sweeps[0]
    expect(sweep.status).toBe('unsourced')
    expect(sweep.detectionRadiusM).toBeNull()
    expect(sweep.sweepWidthM).toBe(0)
    // Null, never 0 and never a plausible default — "cannot say" is not "found nothing".
    expect(sweep.pod).toBeNull()
    expect(report.cumulativePod).toBeNull()
    expect(report.supported).toBe(false)
    expect(report.unsourcedPlatforms).toEqual(['Freefly Astro Max'])
    // The pre-WP-6 sector objective fell back to a flat 60 m radius. Pin that it stays gone.
    expect(sweep.trackLengthM).toBeGreaterThan(0)
    expect(sweep.coverage).toBe(0)
  })

  it('excludes unsourced sweeps from cumulative POD instead of scoring them 0', () => {
    const mixed = buildSectorPodReport({
      scenario: scenario({ droneCount: 2, dronePlatforms: { 'uav-01': 'skydio_x10', 'uav-02': 'freefly_astro_max' } }),
      drones: [drone(), drone({ id: 'uav-02', label: 'UAV-02' })],
      positionHistory: { 'uav-01': track(2), 'uav-02': track(2) },
      occlusion: clearOcclusion,
    })
    const sourcedOnly = buildSectorPodReport({
      scenario: scenario({ dronePlatforms: { ...SOURCED } }),
      drones: [drone()],
      positionHistory: { 'uav-01': track(2) },
      occlusion: clearOcclusion,
    })
    // The unsourced airframe neither helps nor drags the figure down; it is simply not evidence.
    expect(mixed.cumulativePod).toBeCloseTo(sourcedOnly.cumulativePod as number, 9)
    expect(mixed.supported).toBe(true)
    expect(mixed.unsourcedPlatforms).toEqual(['Freefly Astro Max'])
  })

  it('fog shortens the detection radius and so lowers POD', () => {
    const input = {
      scenario: scenario({ dronePlatforms: { ...SOURCED } }),
      drones: [drone()],
      positionHistory: { 'uav-01': track(4) },
      occlusion: clearOcclusion,
    }
    const clear = buildSectorPodReport({ ...input, weather: { activeHazards: [], visibilityMi: 10 } })
    const foggy = buildSectorPodReport({ ...input, weather: { activeHazards: ['fog'], visibilityMi: 0.5 } })

    expect(foggy.sweeps[0].detectionRadiusM as number).toBeLessThan(clear.sweeps[0].detectionRadiusM as number)
    expect(foggy.sweeps[0].pod as number).toBeLessThan(clear.sweeps[0].pod as number)
  })

  it('scores no effort where the drone never entered the sector', () => {
    const report = buildSectorPodReport({
      scenario: scenario({ dronePlatforms: { ...SOURCED } }),
      drones: [drone()],
      // Well west of the sector.
      positionHistory: { 'uav-01': [{ lat: 37.004, lng: -122.05 }, { lat: 37.004, lng: -122.04 }] },
      occlusion: clearOcclusion,
    })
    expect(report.sweeps[0].status).toBe('no_effort')
    expect(report.sweeps[0].trackLengthM).toBe(0)
    expect(report.sweeps[0].pod).toBe(0)
  })

  it('reports nothing at all for a scenario with no authored search area', () => {
    const report = buildSectorPodReport({
      scenario: scenario({ searchArea: undefined, dronePlatforms: { ...SOURCED } }),
      drones: [drone()],
      positionHistory: { 'uav-01': track(4) },
    })
    expect(report.sweeps).toEqual([])
    expect(report.cumulativePod).toBeNull()
    expect(report.supported).toBe(false)
    expect(report.sectorAreaM2).toBe(0)
  })

  it('assumes a visible swath when no terrain fixture is loaded', () => {
    const report = buildSectorPodReport({
      scenario: scenario({ dronePlatforms: { ...SOURCED } }),
      drones: [drone()],
      positionHistory: { 'uav-01': track(4) },
    })
    // No occlusion service is honest ignorance, not an obstruction — the fixture has no evidence
    // of terrain, so it must not manufacture a POD penalty out of that absence.
    expect(report.sweeps[0].losFraction).toBe(1)
    expect(report.sweeps[0].status).toBe('ok')
  })

  it('is deterministic and order-independent across drones', () => {
    const input = {
      scenario: scenario({ droneCount: 2, dronePlatforms: { 'uav-01': 'skydio_x10', 'uav-02': 'teal_2' } }),
      positionHistory: { 'uav-01': track(3), 'uav-02': track(2) },
      occlusion: clearOcclusion,
    }
    const forward = buildSectorPodReport({ ...input, drones: [drone(), drone({ id: 'uav-02', label: 'UAV-02' })] })
    const reversed = buildSectorPodReport({ ...input, drones: [drone({ id: 'uav-02', label: 'UAV-02' }), drone()] })
    expect(reversed).toEqual(forward)
    expect(forward.sweeps.map((s) => s.droneId)).toEqual(['uav-01', 'uav-02'])
    expect(buildSectorPodReport({ ...input, drones: [drone()] }))
      .toEqual(buildSectorPodReport({ ...input, drones: [drone()] }))
  })

  it('computes sector area by the shoelace on a local equal-area projection', () => {
    // The SECTOR fixture is ~1 km × ~1 km at 37°N.
    expect(polygonAreaM2(SECTOR) / 1_000_000).toBeCloseTo(1, 1)
    expect(polygonAreaM2([SW, { lat: 37.001, lng: -122 }])).toBe(0)
  })
})
