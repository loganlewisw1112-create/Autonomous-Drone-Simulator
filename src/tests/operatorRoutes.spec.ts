import { describe, expect, it } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { buildOperatorCommandRoute, buildRouteSuggestions, validateOperatorRoute } from '@/sim/mission/operatorRoutes'
import { defaultDroneStartPosition } from '@/sim/mission/routeAudit'
import type { ScenarioConfig } from '@/types'

const portScenario = ALL_SCENARIOS.find((s) => s.id === 'demo_perimeter') ?? ALL_SCENARIOS[0]
const rioGrande = ALL_SCENARIOS.find((s) => s.id === 'extreme_cbp_rio_grande_longrange') ?? ALL_SCENARIOS[0]
const livePosition = { lat: 37, lng: -122 }
const liveTarget = { lat: 37, lng: -121.99 }
const liveOriginScenario: ScenarioConfig = {
  ...portScenario,
  id: 'live-origin-test',
  droneCount: 1,
  startPosition: { lat: 37.01, lng: -122 },
  launchSites: undefined,
  recoverySites: undefined,
  perDroneStartPositions: undefined,
  perDroneWaypoints: undefined,
  waypoints: [],
  operationalFeatures: undefined,
  heatSources: [],
  geofences: [{
    id: 'live-leg-blocker',
    label: 'Live Leg Blocker',
    type: 'no_fly',
    maxAltitudeFt: 400,
    polygon: [
      { lat: 36.999, lng: -121.996 },
      { lat: 36.999, lng: -121.994 },
      { lat: 37.001, lng: -121.994 },
      { lat: 37.001, lng: -121.996 },
    ],
  }],
}

describe('operator retasking and route suggestions', () => {
  it('blocks an operator route that crosses a non-authorized geofence', () => {
    const route = [
      { id: 'unsafe-a', label: 'Unsafe A', position: { lat: 37.7995, lng: -122.2875 }, altitudeFt: 100 },
      { id: 'unsafe-b', label: 'Unsafe B', position: { lat: 37.7995, lng: -122.2820 }, altitudeFt: 100 },
    ]

    const result = validateOperatorRoute(portScenario, 'uav-01', route)

    expect(result.accepted).toBe(false)
    expect(result.findings.some((f) => f.geofenceId === 'gf-cranes')).toBe(true)
  })

  it('creates a safe deep-scan route around the selected location', () => {
    const route = buildOperatorCommandRoute({
      command: 'deep_scan',
      scenario: portScenario,
      droneId: 'uav-01',
      center: { lat: 37.7968, lng: -122.2845 },
      altitudeFt: 120,
    })

    expect(route.length).toBeGreaterThanOrEqual(5)
    expect(validateOperatorRoute(portScenario, 'uav-01', route).accepted).toBe(true)
  })

  it('preserves launch-origin planning when fromPosition is omitted', () => {
    const input = {
      command: 'route_lkl' as const,
      scenario: liveOriginScenario,
      droneId: 'uav-01',
      center: liveTarget,
      altitudeFt: 120,
    }

    expect(buildOperatorCommandRoute(input)).toEqual(buildOperatorCommandRoute({
      ...input,
      fromPosition: defaultDroneStartPosition(liveOriginScenario, 0),
    }))
  })

  it('plans and validates the first leg from the live aircraft position', () => {
    const input = {
      command: 'route_lkl' as const,
      scenario: liveOriginScenario,
      droneId: 'uav-01',
      center: liveTarget,
      altitudeFt: 120,
    }
    const legacyRoute = buildOperatorCommandRoute(input)
    const liveRoute = buildOperatorCommandRoute({ ...input, fromPosition: livePosition })

    expect(validateOperatorRoute(liveOriginScenario, 'uav-01', legacyRoute).accepted).toBe(true)
    expect(validateOperatorRoute(liveOriginScenario, 'uav-01', legacyRoute, livePosition).accepted).toBe(false)
    expect(liveRoute.length).toBeGreaterThan(legacyRoute.length)
    expect(validateOperatorRoute(liveOriginScenario, 'uav-01', liveRoute, livePosition).accepted).toBe(true)
  })

  it('generates deterministic route suggestions that require operator approval', () => {
    const input = {
      scenario: portScenario,
      droneId: 'uav-01',
      elapsedSec: 90,
      thermalDetections: [{ sourceId: 'hs-poi', class: 'generic-person' as const, position: { lat: 37.7985, lng: -122.2822 }, confidence: 0.8, tick: 90 }],
      warnings: ['thermal_contact'] as const,
    }

    const first = buildRouteSuggestions(input)
    const second = buildRouteSuggestions(input)

    expect(first).toEqual(second)
    expect(first[0]?.requiresApproval).toBe(true)
    expect(first[0]?.route.length).toBeGreaterThan(0)
  })

  it('suggests the next forward Rio Grande recharge route by sortie progress', () => {
    const suggestions = buildRouteSuggestions({
      scenario: rioGrande,
      droneId: 'uav-03',
      elapsedSec: 180,
      thermalDetections: [],
      warnings: [],
      sortieCount: 2,
      currentWaypointIndex: 0,
    })

    expect(suggestions[0]?.title).toBe('Forward recharge staging')
    expect(suggestions[0]?.rationale).toContain('Rio Grande City / US-83 Recharge')
    expect(suggestions[0]?.route[0]?.label).toContain('Rio Grande City / US-83 Recharge')
  })

  it('suggests a visible Rio Grande recharge route for the default selected drone', () => {
    const suggestions = buildRouteSuggestions({
      scenario: rioGrande,
      droneId: 'uav-01',
      elapsedSec: 0,
      thermalDetections: [],
      warnings: [],
      sortieCount: 0,
      currentWaypointIndex: 0,
    })

    expect(suggestions[0]?.title).toBe('Forward recharge staging')
    expect(suggestions[0]?.route.length).toBeGreaterThan(0)
  })
})
