import { describe, it, expect } from 'vitest'
import { stepDrone, createDroneState } from '@/sim/drone/DroneEntity'
import { PLATFORM_CATALOG, type PlatformId } from '@/sim/drone/platformCatalog'

const BASE_POS = { lat: 37.7695, lng: -122.4862 }

describe('per-platform drone physics', () => {
  it('Skydio X10 exceeds the legacy 12 m/s cap', () => {
    let drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS, 120)
    for (let i = 0; i < 200; i++) {
      drone = stepDrone(drone, { throttle: 1 }, 0.05, PLATFORM_CATALOG.skydio_x10)
    }
    expect(drone.speedMs).toBeGreaterThan(12)
  })

  it('Teal 2 speed never exceeds its 10 m/s cap', () => {
    let drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS, 120)
    for (let i = 0; i < 400; i++) {
      drone = stepDrone(drone, { throttle: 1 }, 0.05, PLATFORM_CATALOG.teal_2)
      expect(drone.speedMs).toBeLessThanOrEqual(10 + 1e-6)
    }
    expect(drone.speedMs).toBeCloseTo(10, 3)
  })

  it('BRINC Lemur 2 turns at 120 deg/s', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS)
    const next = stepDrone(drone, { targetHeadingDeg: 90 }, 0.05, PLATFORM_CATALOG.brinc_lemur_2)
    // maxTurn = 120 * 0.05 = 6.0°
    expect(next.headingDeg).toBeCloseTo(6.0, 1)
  })

  // Oracle updated 2026-09-25 (owner-requested realism pass): 6.6 ft/s was unsourced; Freefly's
  // flight-speed table publishes 4 m/s climb / 3 m/s descent (see platformSources.ts).
  it('Freefly Astro Max climbs at its published 4 m/s (13.1 ft/s) and descends at 3 m/s', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS, 100)
    const up = stepDrone(drone, { targetAltitudeFt: 400, throttle: 0 }, 1, PLATFORM_CATALOG.freefly_astro_max)
    expect(up.altitudeFt - 100).toBeCloseTo(13.1, 1)
    const down = stepDrone(drone, { targetAltitudeFt: 0, throttle: 0 }, 1, PLATFORM_CATALOG.freefly_astro_max)
    expect(100 - down.altitudeFt).toBeCloseTo(9.8, 1)
  })

  it('descends at the published descent rate, not the climb rate', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS, 200)
    const x10 = stepDrone(drone, { targetAltitudeFt: 0, throttle: 0 }, 1, PLATFORM_CATALOG.skydio_x10)
    expect(200 - x10.altitudeFt).toBeCloseTo(13.1, 1) // 4 m/s, not the 6 m/s climb
    // No published descent rate → climb rate, which keeps the legacy airframe unchanged.
    const legacy = stepDrone(drone, { targetAltitudeFt: 0, throttle: 0 }, 1)
    expect(200 - legacy.altitudeFt).toBeCloseTo(5, 5)
  })

  it('default (no platform arg) is byte-identical to legacy — 4.5° turn', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS)
    // 0 → 90° in one 50ms step at the legacy 90 deg/s rate = 4.5°
    const next = stepDrone(drone, { targetHeadingDeg: 90 }, 0.05)
    expect(next.headingDeg).toBeCloseTo(4.5, 1)
  })

  it('catalog sanity — 6 platforms, positive fields, correct endurance, no DJI', () => {
    const ids = Object.keys(PLATFORM_CATALOG) as PlatformId[]
    expect(ids).toHaveLength(6)
    for (const id of ids) {
      const spec = PLATFORM_CATALOG[id]
      for (const value of Object.values(spec)) {
        if (typeof value === 'number') expect(value).toBeGreaterThan(0)
      }
      expect(spec.enduranceMultiplier).toBeCloseTo(spec.enduranceMin / 30, 2)
      const haystack = `${spec.id} ${spec.vendor} ${spec.displayName} ${spec.role}`.toLowerCase()
      expect(haystack).not.toContain('dji')
    }
  })
})
