import { describe, expect, it } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { buildOperatorCommandRoute, buildRouteSuggestions, validateOperatorRoute } from '@/sim/mission/operatorRoutes'

const portScenario = ALL_SCENARIOS.find((s) => s.id === 'demo_perimeter') ?? ALL_SCENARIOS[0]
const rioGrande = ALL_SCENARIOS.find((s) => s.id === 'extreme_cbp_rio_grande_longrange') ?? ALL_SCENARIOS[0]

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
