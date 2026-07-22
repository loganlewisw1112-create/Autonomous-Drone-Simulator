import { describe, expect, it } from 'vitest'
import {
  assessSiteReposition,
  clampSiteReposition,
  isMobileLaunchSite,
  resolveLaunchSite,
} from '@/sim/mission/siteReposition'
import { haversineDistanceM, offsetLatLng } from '@/utils/geometry'
import type { LaunchRecoverySite, ScenarioConfig } from '@/types'

const origin = { lat: 37, lng: -122 }

describe('mobile launch-site reposition rules', () => {
  it('derives mobile defaults and resolves a copied override without mutating scenario config', () => {
    const scenario = makeScenario()
    const original = structuredClone(scenario)
    const moved = offsetLatLng(origin, 90, 300)

    const resolved = resolveLaunchSite(scenario, 'mobile', { mobile: moved })
    const recovery = resolveLaunchSite(scenario, 'mobile-recovery', { 'mobile-recovery': moved })

    expect(isMobileLaunchSite(scenario.launchSites!.mobile)).toBe(true)
    expect(resolved).toMatchObject({ id: 'mobile', mobile: true, position: moved })
    expect(recovery?.position).toEqual(moved)
    expect(resolved).not.toBe(scenario.launchSites!.mobile)
    expect(resolved?.position).not.toBe(scenario.launchSites!.mobile.position)
    expect(scenario).toEqual(original)
  })

  it('honors an explicit fixed override on a mobile-kind site', () => {
    const site = makeSite({ mobile: false })
    expect(isMobileLaunchSite(site)).toBe(false)

    const result = assessSiteReposition({
      scenario: makeScenario({ launchSites: { fixed: { ...site, id: 'fixed' } } }),
      siteId: 'fixed',
      requestedPosition: offsetLatLng(origin, 45, 100),
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/fixed site/i)
  })

  it('assesses a mobile site that exists only in the recovery pool', () => {
    const recoveryOnly = makeScenario({
      launchSites: {},
      recoverySites: { mobile: makeSite() },
      defaultLaunchAssignments: {},
      defaultRecoveryAssignments: { 'uav-01': 'mobile' },
    })
    const result = assessSiteReposition({
      scenario: recoveryOnly,
      siteId: 'mobile',
      requestedPosition: offsetLatLng(origin, 90, 200),
    })

    expect(result.ok).toBe(true)
    expect(result.affectedDrones).toEqual(['uav-01'])
    expect(result.overridePatch).toEqual({ mobile: result.position })
  })

  it('clamps moves to the authored radius instead of allowing repeated-move ratcheting', () => {
    const site = makeSite({ repositionRadiusM: 500 })
    const requested = offsetLatLng(origin, 30, 1_500)

    const clamped = clampSiteReposition(site, requested)

    expect(clamped.clamped).toBe(true)
    expect(clamped.distanceFromOriginM).toBeCloseTo(500, 1)
    expect(haversineDistanceM(site.position, clamped.position)).toBeCloseTo(500, 1)
  })

  it('rejects a clamped destination inside an active geofence but ignores mission-authorized zones', () => {
    const center = offsetLatLng(origin, 90, 200)
    const scenario = makeScenario({
      geofences: [{
        id: 'active',
        label: 'Active exclusion',
        type: 'no_fly',
        maxAltitudeFt: 400,
        polygon: boxAround(center, 0.0003),
      }],
    })

    const blocked = assessSiteReposition({ scenario, siteId: 'mobile', requestedPosition: center })
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toBe('Active exclusion is an active geofence.')

    scenario.geofences[0].bypassForMission = true
    expect(assessSiteReposition({ scenario, siteId: 'mobile', requestedPosition: center }).ok).toBe(true)
  })

  it('returns deterministic preview deltas and an associated recovery override patch', () => {
    const scenario = makeScenario()
    const original = structuredClone(scenario)
    const closer = offsetLatLng(origin, 0, 400)

    const result = assessSiteReposition({
      scenario,
      siteId: 'mobile',
      requestedPosition: closer,
      objectivePosition: scenario.waypoints[0].position,
    })

    expect(result.ok).toBe(true)
    expect(result.distanceToObjectiveDeltaM).toBeLessThan(0)
    expect(result.reserveDeltaPct).toBeGreaterThan(0)
    expect(result.affectedDrones).toEqual(['uav-01'])
    expect(result.affectedSiteIds).toEqual(['mobile', 'mobile-recovery'])
    expect(result.overridePatch).toEqual({ mobile: closer, 'mobile-recovery': closer })
    expect(result.message).toMatch(/km to sector.*reserve.*1 drone re-planned/i)
    expect(scenario).toEqual(original)
  })

  it('blocks a live move when an affected aircraft has no reachable alternative recovery', () => {
    const scenario = makeScenario()
    const result = assessSiteReposition({
      scenario,
      siteId: 'mobile',
      requestedPosition: offsetLatLng(origin, 180, 300),
      drones: [{
        id: 'uav-01',
        position: offsetLatLng(origin, 0, 1_000),
        batteryPct: 20,
        missionState: 'return_to_base',
      }],
    })

    expect(result.ok).toBe(false)
    expect(result.blockers).toEqual(['uav-01 has no reachable alternative recovery site.'])
  })

  it('does not apply the emergency stranding block while an aircraft remains above reserve', () => {
    const scenario = makeScenario()
    const result = assessSiteReposition({
      scenario,
      siteId: 'mobile',
      requestedPosition: offsetLatLng(origin, 180, 300),
      drones: [{
        id: 'uav-01',
        position: offsetLatLng(origin, 0, 1_000),
        batteryPct: 50,
        missionState: 'return_to_base',
      }],
    })

    expect(result.ok).toBe(true)
  })
})

function makeScenario(overrides: Partial<ScenarioConfig> = {}): ScenarioConfig {
  return {
    id: 'site-reposition-test',
    name: 'Site reposition test',
    description: 'Pure relocation fixture',
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

function boxAround(center: typeof origin, delta: number) {
  return [
    { lat: center.lat - delta, lng: center.lng - delta },
    { lat: center.lat + delta, lng: center.lng - delta },
    { lat: center.lat + delta, lng: center.lng + delta },
    { lat: center.lat - delta, lng: center.lng + delta },
  ]
}
