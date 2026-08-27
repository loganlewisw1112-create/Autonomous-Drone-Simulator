import { describe, expect, it } from 'vitest'
import {
  resolvePlannedRtbDestination,
  resolveRtbDestination,
  type RtbDestinationDrone,
} from '@/sim/mission/rtbDestination'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { buildSafeDroneRoutes, droneIdForIndex } from '@/sim/mission/routeAudit'
import { offsetLatLng } from '@/utils/geometry'
import type { LaunchRecoverySite, ScenarioConfig } from '@/types'

// Audit F-04 regression suite.
//
// The defect: the lost-link validator checked a route to scenario.startPosition while the
// tick flew to (recharge station -> recovery site -> start). Validation could therefore
// clear a route the aircraft never flew, and reject one it did. These tests pin the
// precedence, the sortie-count semantics, and — most importantly — that a scenario with a
// real recovery destination never resolves home to scenario.startPosition.

const origin = { lat: 37, lng: -122 }
const stationA = offsetLatLng(origin, 90, 800)
const stationB = offsetLatLng(origin, 90, 1_600)

describe('shared RTB destination resolution', () => {
  it('prefers the assigned forward recharge station over the recovery site', () => {
    const scenario = makeScenario({
      perDroneRechargeStations: { 'uav-01': [stationA, stationB] },
    })

    const destination = resolveRtbDestination(scenario, makeDrone())

    expect(destination.source).toBe('recharge_station')
    expect(destination.position).toEqual(stationA)
    expect(destination.rechargeStation).not.toBeNull()
    // The recovery site is still reported even though the station outranks it — the tick
    // needs the id to look up relocation availability.
    expect(destination.recoverySiteId).toBe('mobile-recovery')
  })

  it('falls back to the assigned recovery site when no station network exists', () => {
    const destination = resolveRtbDestination(makeScenario(), makeDrone())

    expect(destination.source).toBe('recovery_site')
    expect(destination.position).toEqual(origin)
    expect(destination.rechargeStation).toBeNull()
    expect(destination.label).toBe('Mobile ICP')
  })

  it('honors an operator site relocation when resolving the recovery site', () => {
    const moved = offsetLatLng(origin, 0, 450)

    const destination = resolveRtbDestination(
      makeScenario(),
      makeDrone(),
      { 'mobile-recovery': moved },
    )

    expect(destination.source).toBe('recovery_site')
    expect(destination.position).toEqual(moved)
  })

  it('falls back to the scenario start only when there is no station and no recovery site', () => {
    const scenario = makeScenario({ recoverySites: {}, defaultRecoveryAssignments: {} })

    const destination = resolveRtbDestination(scenario, makeDrone())

    expect(destination.source).toBe('scenario_start')
    expect(destination.position).toEqual(scenario.startPosition)
    expect(destination.recoverySiteId).toBeUndefined()
  })

  it('treats a drone sitting on a station as completing that sortie, not the next one', () => {
    const scenario = makeScenario({
      perDroneRechargeStations: { 'uav-01': [stationA, stationB] },
    })

    const airborne = resolveRtbDestination(scenario, makeDrone({ sortieCount: 1 }))
    const charging = resolveRtbDestination(
      scenario,
      makeDrone({ sortieCount: 1, missionState: 'recharge' }),
    )

    expect(airborne.position).toEqual(stationB)
    expect(charging.position).toEqual(stationA)
  })

  it('never resolves home to the scenario start when a real recovery destination exists', () => {
    // This is the exact drift the audit found: validating against scenario.startPosition
    // while the aircraft flies somewhere else entirely.
    const withStation = makeScenario({
      perDroneRechargeStations: { 'uav-01': [stationA] },
      startPosition: offsetLatLng(origin, 180, 5_000),
    })
    const withRecoveryOnly = makeScenario({
      startPosition: offsetLatLng(origin, 180, 5_000),
    })

    for (const scenario of [withStation, withRecoveryOnly]) {
      const destination = resolveRtbDestination(scenario, makeDrone())
      expect(destination.source).not.toBe('scenario_start')
      expect(destination.position).not.toEqual(scenario.startPosition)
    }
  })
})

// Guards the LAST copy of "home" logic, in the static route planner/auditor.
//
// routeAudit.ts used to carry a third precedence of its own — recovery site → last recharge
// station → scenario start — which disagreed with the flown destination whenever a scenario
// had both a recovery site and staged stations. It now derives from the shared resolver.
// Measured at the time of unification: the two agreed on every catalog scenario/drone (0
// divergences), so this is a no-op today and a drift alarm tomorrow.
describe('planned RTB destination matches the flown resolver across the catalog', () => {
  it('appends a safe-recovery waypoint at the shared resolver destination for every drone', () => {
    for (const scenario of ALL_SCENARIOS) {
      const safeRoutes = buildSafeDroneRoutes(scenario)
      for (let i = 0; i < scenario.droneCount; i++) {
        const droneId = droneIdForIndex(i)
        const route = safeRoutes[droneId] ?? []
        const recovery = [...route].reverse().find((wp) => wp.id.startsWith(`${droneId}-rtb-safe`))
        expect(recovery, `${scenario.id}/${droneId} has no safe-recovery waypoint`).toBeDefined()

        const expected = resolvePlannedRtbDestination(
          scenario,
          droneId,
          scenario.perDroneWaypoints?.[droneId] ?? scenario.waypoints,
        )
        // The planner may detour the leg around geofences, so the authored recovery point is
        // compared against the resolver rather than asserting an exact flown path.
        expect(
          recovery!.position,
          `${scenario.id}/${droneId} recovery point drifted from the shared resolver`,
        ).toEqual(expected.position)
      }
    }
  })
})

function makeDrone(overrides: Partial<RtbDestinationDrone> = {}): RtbDestinationDrone {
  return {
    id: 'uav-01',
    missionState: 'navigate',
    sortieCount: 0,
    currentWaypointIndex: 0,
    ...overrides,
  }
}

function makeScenario(overrides: Partial<ScenarioConfig> = {}): ScenarioConfig {
  return {
    id: 'rtb-destination-test',
    name: 'RTB destination test',
    description: 'Pure home-resolution fixture',
    seed: 17,
    droneCount: 1,
    missionType: 'waypoint',
    startPosition: origin,
    waypoints: [{ id: 'task', position: offsetLatLng(origin, 0, 1_000), altitudeFt: 120 }],
    perDroneWaypoints: {
      'uav-01': [{ id: 'task-01', position: offsetLatLng(origin, 0, 1_000), altitudeFt: 120 }],
    },
    geofences: [],
    heatSources: [],
    batteryStartPct: 100,
    batteryDrainRatePerSec: 0.01,
    commsLossWindows: [],
    launchSites: { mobile: makeSite() },
    recoverySites: { 'mobile-recovery': { ...makeSite(), id: 'mobile-recovery' } },
    defaultLaunchAssignments: { 'uav-01': 'mobile' },
    defaultRecoveryAssignments: { 'uav-01': 'mobile-recovery' },
    ...overrides,
  }
}

function makeSite(overrides: Partial<LaunchRecoverySite> = {}): LaunchRecoverySite {
  return {
    id: 'mobile',
    kind: 'field_icp',
    label: 'Mobile ICP',
    agency: 'UAS OPS',
    position: origin,
    surfaceNote: 'Vehicle pad',
    repositionRadiusM: 500,
    repositionTimeSec: 90,
    ...overrides,
  }
}
