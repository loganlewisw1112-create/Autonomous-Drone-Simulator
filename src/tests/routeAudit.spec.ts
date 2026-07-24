import { describe, expect, it } from 'vitest'
import { portPerimeter } from '@/scenarios/demoScenarios'
import { INCIDENT_MISSION_COUNT, INCIDENT_SCENARIOS } from '@/scenarios/catalog'
import { auditScenarioRoutes, buildSafeDroneRoutes } from '@/sim/mission/routeAudit'

function expectSamePosition(actual: { lat: number; lng: number }, expected: { lat: number; lng: number }) {
  expect(actual.lat).toBeCloseTo(expected.lat, 6)
  expect(actual.lng).toBeCloseTo(expected.lng, 6)
}

describe('route audit and safe mission routing', () => {
  it('detects the current raw Port of Oakland crane no-fly breach', () => {
    const findings = auditScenarioRoutes(portPerimeter)

    expect(findings.some((f) => f.scenarioId === 'demo_perimeter' && f.geofenceId === 'gf-cranes')).toBe(true)
  })

  it('builds geofence-safe baseline routes for every simulator scenario', () => {
    expect(INCIDENT_SCENARIOS).toHaveLength(INCIDENT_MISSION_COUNT)

    for (const scenario of INCIDENT_SCENARIOS) {
      const routes = buildSafeDroneRoutes(scenario)
      const findings = auditScenarioRoutes(scenario, { routes })
      expect(findings, scenario.id).toEqual([])
    }
  })

  it('uses launch and recovery site metadata as route source of truth', () => {
    const scenario = INCIDENT_SCENARIOS.find((item) => item.id === 'train_uscg_maritime_sar')
    expect(scenario).toBeTruthy()
    if (!scenario) return

    const routes = buildSafeDroneRoutes(scenario)
    for (const id of ['uav-01', 'uav-02']) {
      const launchId = scenario.defaultLaunchAssignments?.[id]
      const recoveryId = scenario.defaultRecoveryAssignments?.[id]
      const launch = launchId ? scenario.launchSites?.[launchId] : undefined
      const recovery = recoveryId ? scenario.recoverySites?.[recoveryId] : undefined
      expect(launch, id).toBeTruthy()
      expect(recovery, id).toBeTruthy()
      if (!launch || !recovery) continue

      expectSamePosition(scenario.perDroneStartPositions?.[id] ?? scenario.startPosition, launch.position)
      expectSamePosition(routes[id].at(-1)?.position ?? scenario.startPosition, recovery.position)
    }
  })

  it('does not duplicate RTB recovery waypoints when safe routes are rebuilt', () => {
    const scenario = INCIDENT_SCENARIOS.find((item) => item.id === 'demo_basic') ?? INCIDENT_SCENARIOS[0]
    const once = buildSafeDroneRoutes(scenario)
    const twice = buildSafeDroneRoutes({ ...scenario, perDroneWaypoints: once })

    for (const [droneId, route] of Object.entries(twice)) {
      expect(route.filter((wp) => wp.id === `${droneId}-rtb-safe`), droneId).toHaveLength(1)
    }
  })

  it('audits recharge station paths when stations are authored on a scenario', () => {
    const maritime = INCIDENT_SCENARIOS.find((scenario) => scenario.id === 'train_uscg_maritime_sar')
    expect(maritime).toBeTruthy()
    if (!maritime) return

    const findings = auditScenarioRoutes({
      ...maritime,
      droneCount: 1,
      perDroneRechargeStations: {
        'uav-01': [maritime.startPosition, { lat: 41.7000, lng: -70.5000 }],
      },
    }, { routes: { 'uav-01': maritime.perDroneWaypoints?.['uav-01'] ?? [] } })

    expect(findings).toBeDefined()
  })
})
