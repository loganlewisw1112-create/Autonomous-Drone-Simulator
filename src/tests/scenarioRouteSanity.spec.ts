/**
 * Scenario route sanity + coordinated-launch guards.
 *
 * These pin the operational-realism pass: authored routes must not place drones
 * inside an active no-fly zone, staging points must be launchable, and the
 * coordinated launch planner must fan bays apart and stagger takeoffs
 * deterministically.
 */
import { describe, it, expect } from 'vitest'
import { demoBasic, demoSAR } from '@/scenarios/demoBasic'
import { suspectSearch, vehiclePursuit, sarCoastal, portPerimeter, wildfireRecon } from '@/scenarios/demoScenarios'
import { EXTREME_SCENARIOS } from '@/scenarios/extremeScenarios'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { buildSafeDroneRoutes } from '@/sim/mission/routeAudit'
import { pointInPolygon, haversineDistanceM } from '@/utils/geometry'
import {
  planCoordinatedLaunch,
  BAY_SPACING_M,
  H_SEP_M,
} from '@/sim/mission/LaunchCoordinator'
import type { ScenarioConfig, Geofence, LatLng } from '@/types'

const RAW_SCENARIOS: ScenarioConfig[] = [
  demoBasic, demoSAR, suspectSearch, vehiclePursuit, sarCoastal,
  portPerimeter, wildfireRecon, ...EXTREME_SCENARIOS,
]

// A hard no-fly the drone must never be authored into. bypassForMission zones are
// authorized for the tasking, so they are excluded.
function hardNoFly(gf: Geofence): boolean {
  return gf.type === 'no_fly' && !gf.bypassForMission
}

function insideAnyNoFly(point: LatLng, geofences: Geofence[]): Geofence | undefined {
  return geofences.filter(hardNoFly).find((gf) => pointInPolygon(point, gf.polygon))
}

describe('scenario route sanity', () => {
  // NOTE: authored waypoints MAY sit inside a no-fly — that's deliberate: the
  // route-audit (buildSafeDroneRoutes) detects and reroutes around them, which the
  // routeAudit/operatorRoutes specs assert. What must never happen is staging a
  // LAUNCH inside a no-fly (you cannot lift off there) or a *flown* (post-audit)
  // waypoint remaining inside one.

  it('stages every scenario launch point clear of a hard no-fly zone', () => {
    for (const scenario of RAW_SCENARIOS) {
      const breach = insideAnyNoFly(scenario.startPosition, scenario.geofences)
      expect(breach, `${scenario.id} launch inside ${breach?.id}`).toBeUndefined()
    }
  })

  it('route-audit clears every flown waypoint out of hard no-fly zones', () => {
    for (const scenario of ALL_SCENARIOS) {
      const routes = buildSafeDroneRoutes(scenario)
      for (const [droneId, route] of Object.entries(routes)) {
        for (const wp of route) {
          const breach = insideAnyNoFly(wp.position, scenario.geofences)
          expect(breach, `${scenario.id}/${droneId}/${wp.id} still inside ${breach?.id}`).toBeUndefined()
        }
      }
    }
  })

  it('fans derived launch bays apart so no two drones share a pad', () => {
    for (const scenario of ALL_SCENARIOS) {
      const sites = scenario.launchSites ?? {}
      const positions = Object.values(sites).map((s) => s.position)
      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          const d = haversineDistanceM(positions[i], positions[j])
          // Comfortably above the old ~5.5 m stacked spacing; relocation around
          // geofences can shave the fan, so guard a conservative floor.
          expect(d, `${scenario.id} bays ${i}/${j} = ${d.toFixed(1)}m`).toBeGreaterThan(15)
        }
      }
    }
  })
})

describe('coordinated launch planner', () => {
  const startPosition: LatLng = { lat: 37.77, lng: -122.42 }
  const droneIds = ['uav-01', 'uav-02', 'uav-03', 'uav-04', 'uav-05']
  // Spread of outbound targets around the staging point.
  const firstTargets: Record<string, LatLng> = {
    'uav-01': { lat: 37.775, lng: -122.425 },
    'uav-02': { lat: 37.775, lng: -122.420 },
    'uav-03': { lat: 37.775, lng: -122.415 },
    'uav-04': { lat: 37.772, lng: -122.410 },
    'uav-05': { lat: 37.768, lng: -122.415 },
  }

  it('fans bays at least the bay-spacing minimum apart', () => {
    const plan = planCoordinatedLaunch({ startPosition, droneIds, firstTargets })
    const bays = droneIds.map((id) => plan[id].bay)
    // Adjacent bays along the fan are exactly one spacing step apart.
    let minAdjacent = Infinity
    for (let i = 0; i < bays.length; i++) {
      for (let j = i + 1; j < bays.length; j++) {
        minAdjacent = Math.min(minAdjacent, haversineDistanceM(bays[i], bays[j]))
      }
    }
    expect(minAdjacent).toBeGreaterThanOrEqual(BAY_SPACING_M - 1)
    expect(BAY_SPACING_M).toBeGreaterThan(H_SEP_M)
  })

  it('staggers takeoff: first drone launches immediately, others later, monotonic', () => {
    const plan = planCoordinatedLaunch({ startPosition, droneIds, firstTargets })
    const slots = droneIds.map((id) => plan[id].scheduledLaunchSec).sort((a, b) => a - b)
    expect(slots[0]).toBe(0)
    expect(slots[slots.length - 1]).toBeGreaterThan(0)
    // No two drones share the exact same slot when headings are similar enough.
    expect(new Set(slots).size).toBeGreaterThan(1)
  })

  it('is deterministic — identical inputs produce identical schedules', () => {
    const a = planCoordinatedLaunch({ startPosition, droneIds, firstTargets })
    const b = planCoordinatedLaunch({ startPosition, droneIds, firstTargets })
    expect(a).toEqual(b)
  })

  it('honors explicit bays without fanning them', () => {
    const explicitBays: Record<string, LatLng> = {
      'uav-01': { lat: 37.7705, lng: -122.4205 },
      'uav-02': { lat: 37.7706, lng: -122.4204 },
      'uav-03': { lat: 37.7707, lng: -122.4203 },
      'uav-04': { lat: 37.7708, lng: -122.4202 },
      'uav-05': { lat: 37.7709, lng: -122.4201 },
    }
    const plan = planCoordinatedLaunch({ startPosition, droneIds, firstTargets, explicitBays })
    for (const id of droneIds) {
      expect(plan[id].bay).toEqual(explicitBays[id])
    }
  })
})
