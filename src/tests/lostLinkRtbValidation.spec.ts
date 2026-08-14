import { describe, expect, it } from 'vitest'
import { lostLinkProbeRoute } from '@/sim/SimulationLoop'
import { resolveRtbDestination } from '@/sim/mission/rtbDestination'
import { offsetLatLng } from '@/utils/geometry'
import type { DroneState, LaunchRecoverySite, ScenarioConfig } from '@/types'

// Audit F-04 regression guard.
//
// Before the fix, the lost-link probe route was built to scenario.startPosition regardless of
// where the aircraft would actually return to, so the validator could clear a route the
// aircraft never flew (and reject one it did). These tests pin the probe target to the same
// resolver the tick flies to. Each case below is one where the two answers disagree, so a
// regression to scenario.startPosition fails here immediately.

const origin = { lat: 37, lng: -122 }
const recoveryPosition = offsetLatLng(origin, 90, 1_000)
const stationPosition = offsetLatLng(origin, 45, 700)

describe('lost-link probe route targets the destination actually flown', () => {
  it('probes the assigned recovery site, not the scenario start', () => {
    const scenario = makeScenario()

    const [waypoint] = lostLinkProbeRoute(scenario, makeDrone())

    expect(waypoint.position).toEqual(recoveryPosition)
    expect(waypoint.position).not.toEqual(scenario.startPosition)
  })

  it('probes the forward recharge station when one outranks the recovery site', () => {
    const scenario = makeScenario({
      perDroneRechargeStations: { 'uav-01': [stationPosition] },
    })

    const [waypoint] = lostLinkProbeRoute(scenario, makeDrone())

    expect(waypoint.position).toEqual(stationPosition)
    expect(waypoint.position).not.toEqual(scenario.startPosition)
  })

  it('follows an operator site relocation', () => {
    const moved = offsetLatLng(origin, 270, 600)

    const [waypoint] = lostLinkProbeRoute(makeScenario(), makeDrone(), { 'mobile-recovery': moved })

    expect(waypoint.position).toEqual(moved)
  })

  it('agrees with the shared resolver for every destination case', () => {
    const cases: ScenarioConfig[] = [
      makeScenario({ perDroneRechargeStations: { 'uav-01': [stationPosition] } }),
      makeScenario(),
      makeScenario({ recoverySites: {}, defaultRecoveryAssignments: {} }),
    ]

    for (const scenario of cases) {
      const drone = makeDrone()
      const [waypoint] = lostLinkProbeRoute(scenario, drone)
      expect(waypoint.position).toEqual(resolveRtbDestination(scenario, drone).position)
    }
  })

  it('never probes below the modeled 20 ft surface threshold', () => {
    const [waypoint] = lostLinkProbeRoute(makeScenario(), makeDrone({ altitudeFt: 4 }))

    expect(waypoint.altitudeFt).toBe(20)
  })
})

function makeScenario(overrides: Partial<ScenarioConfig> = {}): ScenarioConfig {
  return {
    id: 'lost-link-rtb-test',
    name: 'Lost-link RTB validation test',
    description: 'Home resolution differs from the scenario start',
    seed: 17,
    droneCount: 1,
    missionType: 'waypoint',
    startPosition: origin,
    waypoints: [{ id: 'task', position: offsetLatLng(origin, 0, 500), altitudeFt: 120 }],
    perDroneWaypoints: {
      'uav-01': [{ id: 'task-01', position: offsetLatLng(origin, 0, 500), altitudeFt: 120 }],
    },
    geofences: [],
    heatSources: [],
    batteryStartPct: 100,
    batteryDrainRatePerSec: 0.01,
    commsLossWindows: [],
    launchSites: { mobile: makeSite() },
    recoverySites: {
      'mobile-recovery': { ...makeSite(), id: 'mobile-recovery', position: recoveryPosition },
    },
    defaultLaunchAssignments: { 'uav-01': 'mobile' },
    defaultRecoveryAssignments: { 'uav-01': 'mobile-recovery' },
    ...overrides,
  }
}

function makeDrone(overrides: Partial<DroneState> = {}): DroneState {
  return {
    id: 'uav-01',
    label: 'UAV-01',
    color: '#00ff88',
    position: origin,
    altitudeFt: 200,
    headingDeg: 90,
    speedMs: 12,
    batteryPct: 60,
    signalDbm: -95,
    missionState: 'navigate',
    currentWaypointIndex: 0,
    conflictFlag: false,
    geofenceBreachFlag: false,
    bvlosFlag: false,
    sortieCount: 0,
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
    repositionRadiusM: 5_000,
    repositionTimeSec: 90,
    ...overrides,
  }
}
