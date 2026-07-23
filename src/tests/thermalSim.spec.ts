import { describe, expect, it } from 'vitest'
import {
  checkThermalDetections,
  thermalTargetGeometry,
  type ThermalDetectionEnvironment,
} from '@/sim/sensors/ThermalSim'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { effectiveDetectionRangeM } from '@/sim/sensors/thermalRange'
import { PLATFORM_CATALOG } from '@/sim/drone/platformCatalog'
import type { LosResult, OcclusionService } from '@/sim/terrain/OcclusionService'
import { offsetLatLng } from '@/utils/geometry'
import type { DroneState, HeatSource } from '@/types'

const ORIGIN = { lat: 37.77, lng: -122.42 }
const PERSON_HEIGHT_M = 1.7
const FT_TO_M = 0.3048

function drone(overrides: Partial<DroneState> = {}): DroneState {
  return {
    id: 'uav-full-id-01',
    label: 'UAV-01',
    color: '#fff',
    position: ORIGIN,
    altitudeFt: PERSON_HEIGHT_M / FT_TO_M,
    headingDeg: 0,
    speedMs: 0,
    batteryPct: 100,
    signalDbm: -55,
    missionState: 'navigate',
    currentWaypointIndex: 0,
    conflictFlag: false,
    geofenceBreachFlag: false,
    bvlosFlag: false,
    sortieCount: 0,
    ...overrides,
  }
}

function person(id: string, distanceM: number, overrides: Partial<HeatSource> = {}): HeatSource {
  return {
    id,
    class: 'generic-person',
    position: offsetLatLng(ORIGIN, 90, distanceM),
    tempC: 37,
    radiusM: 0,
    ...overrides,
  }
}

function environment(
  platform = PLATFORM_CATALOG.skydio_x10,
  overrides: Partial<ThermalDetectionEnvironment> = {},
): ThermalDetectionEnvironment {
  return {
    platform,
    weather: { activeHazards: [], visibilityMi: 10, tempF: 68 },
    ...overrides,
  }
}

function occlusion(clear: boolean, calls: Array<{ a: number; b: number }> = []): OcclusionService {
  const result: LosResult = clear
    ? { clear: true, blockedBy: null, blockHeight: null, blockedAt: null, clearanceM: 5 }
    : {
        clear: false,
        blockedBy: 'terrain',
        blockHeight: 104,
        blockedAt: ORIGIN,
        clearanceM: -1,
      }
  return {
    groundElevation: () => 100,
    surfaceHeight: () => 100,
    hasLineOfSight: (a, b) => {
      calls.push({ a: a.altMslM, b: b.altMslM })
      return result
    },
    skyVisibility: () => true,
  }
}

describe('strict thermal detection pipeline (WP-5)', () => {
  it('uses the computed Johnson range as the detection boundary', () => {
    const env = environment()
    const rangeM = effectiveDetectionRangeM(env.platform!.thermal, 0.5, 1)!

    expect(checkThermalDetections(drone(), [person('inside', rangeM - 0.25)], 100, 7331, env)).toHaveLength(1)
    expect(checkThermalDetections(drone(), [person('outside', rangeM + 0.25)], 100, 7331, env)).toHaveLength(0)
  })

  it('distinguishes X10 and Anafi using their published optics', () => {
    const source = person('mid-range', 150)
    expect(checkThermalDetections(drone(), [source], 100, 7331, environment(PLATFORM_CATALOG.skydio_x10))).toHaveLength(1)
    expect(checkThermalDetections(drone(), [source], 100, 7331, environment(PLATFORM_CATALOG.parrot_anafi_usa))).toHaveLength(0)
  })

  it('enforces object/background contrast scaled by NETD', () => {
    const lowContrast = person('low', 20, { tempC: 21.99, backgroundTempC: 20 })
    const threshold = person('threshold', 20, { tempC: 22, backgroundTempC: 20 })
    expect(checkThermalDetections(drone(), [lowContrast], 100, 7331, environment())).toHaveLength(0)
    expect(checkThermalDetections(drone(), [threshold], 100, 7331, environment())).toHaveLength(1)
  })

  it('passes MSL endpoints to LOS and rejects every blocked contact', () => {
    const calls: Array<{ a: number; b: number }> = []
    const source = person('los', 20)
    const activeDrone = drone({ altitudeFt: 30 })
    const clearEnv = environment(PLATFORM_CATALOG.skydio_x10, { occlusion: occlusion(true, calls) })
    const blockedEnv = environment(PLATFORM_CATALOG.skydio_x10, { occlusion: occlusion(false) })

    expect(checkThermalDetections(activeDrone, [source], 100, 7331, clearEnv)).toHaveLength(1)
    expect(checkThermalDetections(activeDrone, [source], 100, 7331, blockedEnv)).toHaveLength(0)
    expect(calls).toHaveLength(1)
    expect(calls[0].a).toBeCloseTo(100 + 30 * FT_TO_M, 6)
    expect(calls[0].b).toBeCloseTo(100 + PERSON_HEIGHT_M, 6)
  })

  it('uses 3D slant range, not horizontal range alone', () => {
    const directlyBelow = person('below', 0)
    expect(checkThermalDetections(drone({ altitudeFt: 1_000 }), [directlyBelow], 100, 7331, environment())).toHaveLength(0)
  })

  it('is deterministic and independent of heat-source ordering', () => {
    const sources = [person('source-complete-id-a', 40), person('source-complete-id-b', 60)]
    const forward = checkThermalDetections(drone(), sources, 222, 7331, environment())
    const reversed = checkThermalDetections(drone(), [...sources].reverse(), 222, 7331, environment())
    const repeated = checkThermalDetections(drone(), sources, 222, 7331, environment())

    expect(forward).toEqual(reversed)
    expect(forward).toEqual(repeated)
    expect(forward.map((detection) => detection.sourceId)).toEqual([
      'source-complete-id-a',
      'source-complete-id-b',
    ])
    expect(forward[0].confidence).not.toBe(forward[1].confidence)
  })

  it('derives campfire and heat-source geometry from their authored footprint', () => {
    const surface = person('surface', 20, { class: 'heat-source', radiusM: 2 })
    const fire = person('fire', 20, { class: 'campfire', radiusM: 3 })

    expect(thermalTargetGeometry(surface)).toEqual({ criticalDimensionM: 4, heightAglM: 0.5 })
    expect(thermalTargetGeometry(fire)).toEqual({ criticalDimensionM: 6, heightAglM: 3 })
    expect(checkThermalDetections(drone({ altitudeFt: 30 }), [surface, fire], 100, 7331, environment()))
      .toHaveLength(2)
  })

  it('keeps explicit geometry authoritative and fails closed without a positive size', () => {
    const source = person('surface', 20, { class: 'heat-source', radiusM: 0 })
    expect(thermalTargetGeometry(source)).toBeNull()
    expect(thermalTargetGeometry({
      ...source,
      criticalDimensionM: 1,
      heightAglM: 2,
    })).toEqual({ criticalDimensionM: 1, heightAglM: 2 })
  })

  it('resolves physical geometry for every shipped thermal target', () => {
    const unresolved = ALL_SCENARIOS.flatMap((scenario) => scenario.heatSources)
      .filter((source) => thermalTargetGeometry(source) == null)
      .map((source) => source.id)

    expect(unresolved).toEqual([])
  })
})
