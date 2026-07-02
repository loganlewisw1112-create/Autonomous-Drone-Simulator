import { describe, expect, it } from 'vitest'
import { portPerimeter } from '@/scenarios/demoScenarios'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { auditScenarioRoutes, buildSafeDroneRoutes, defaultDroneStartPosition } from '@/sim/mission/routeAudit'

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
    expect(ALL_SCENARIOS).toHaveLength(21)

    for (const scenario of ALL_SCENARIOS) {
      const routes = buildSafeDroneRoutes(scenario)
      const findings = auditScenarioRoutes(scenario, { routes })
      expect(findings, scenario.id).toEqual([])
    }
  })

  it('uses launch and recovery site metadata as route source of truth', () => {
    const scenario = ALL_SCENARIOS.find((item) => item.id === 'extreme_multiagency_sf_pursuit')
    expect(scenario).toBeTruthy()
    if (!scenario) return

    const routes = buildSafeDroneRoutes(scenario)
    for (const [index, id] of ['uav-03', 'uav-04', 'uav-05'].entries()) {
      const droneIndex = index + 2
      const launch = scenario.launchSites?.[id]
      const recovery = scenario.recoverySites?.[id]
      expect(launch, id).toBeTruthy()
      expect(recovery, id).toBeTruthy()
      if (!launch || !recovery) continue

      expectSamePosition(defaultDroneStartPosition(scenario, droneIndex), launch.position)
      expectSamePosition(scenario.perDroneStartPositions?.[id] ?? scenario.startPosition, launch.position)
      expectSamePosition(routes[id].at(-1)?.position ?? scenario.startPosition, recovery.position)
    }
  })

  it('does not duplicate RTB recovery waypoints when safe routes are rebuilt', () => {
    const scenario = ALL_SCENARIOS.find((item) => item.id === 'extreme_cbp_rio_grande_longrange') ?? ALL_SCENARIOS[0]
    const once = buildSafeDroneRoutes(scenario)
    const twice = buildSafeDroneRoutes({ ...scenario, perDroneWaypoints: once })

    for (const [droneId, route] of Object.entries(twice)) {
      expect(route.filter((wp) => wp.id === `${droneId}-rtb-safe`), droneId).toHaveLength(1)
    }
  })

  it('audits every staged recharge station instead of only the first station', () => {
    const rioGrande = ALL_SCENARIOS.find((scenario) => scenario.id === 'extreme_cbp_rio_grande_longrange')
    expect(rioGrande).toBeTruthy()
    if (!rioGrande) return

    const unsafeLaterStation = { lat: 26.2700, lng: -98.7000 }
    const findings = auditScenarioRoutes({
      ...rioGrande,
      droneCount: 1,
      perDroneRechargeStations: {
        'uav-01': [
          { lat: 26.5950, lng: -99.1050 },
          unsafeLaterStation,
        ],
      },
    }, { routes: { 'uav-01': rioGrande.perDroneWaypoints?.['uav-01'] ?? [] } })

    expect(findings.some((finding) =>
      finding.droneId === 'uav-01' &&
      (finding.waypointId === 'recharge-station-2' || finding.segmentId?.includes('recharge-station-2')) &&
      finding.geofenceId === 'gf-rg-mexico'
    )).toBe(true)
  })
})
