import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { useDroneStore } from '@/store/droneStore'
import { loadSavedDroneWaypointRoute } from '@/sim/mission/waypointPersistence'
import type { RouteSuggestion, ScenarioVariantConfig, Waypoint } from '@/types'

const VARIANT: ScenarioVariantConfig = {
  seed: 1337,
  timeOfDay: 'day',
  season: 'spring',
  weatherSeverity: 0,
  commsDegradation: 0,
  thermalDensity: 1,
  batteryPressure: 0,
  terrainDifficulty: 0,
}

const scenario = ALL_SCENARIOS.find((item) => item.id === 'demo_perimeter') ?? ALL_SCENARIOS[0]

describe('drone store waypoint autosave', () => {
  let storage: Storage

  beforeEach(() => {
    storage = makeMemoryStorage()
    vi.stubGlobal('localStorage', storage)
    useDroneStore.setState({
      scenario,
      scenarioVariant: VARIANT,
      drones: [],
      droneWaypoints: {
        'uav-01': scenario.perDroneWaypoints?.['uav-01'] ?? scenario.waypoints,
      },
      routeSuggestions: [],
      routeCommandError: null,
      routeSaveStatuses: {},
    })
  })

  it('autosaves a validated drag edit made through moveDroneWaypoint', () => {
    const route = useDroneStore.getState().droneWaypoints['uav-01']
    const first = route[0]

    const ok = useDroneStore.getState().moveDroneWaypoint('uav-01', first.id, first.position)

    expect(ok).toBe(true)
    expect(loadSavedDroneWaypointRoute(storage, scenario.id, VARIANT, 'uav-01')).toMatchObject({
      droneId: 'uav-01',
      source: 'operator_edit',
      route: useDroneStore.getState().droneWaypoints['uav-01'],
    })
    expect(useDroneStore.getState().routeSaveStatuses['uav-01']).toMatchObject({ state: 'autosaved' })
  })

  it('autosaves a generated command route as a command-route draft', () => {
    const ok = useDroneStore.getState().commandDroneRoute('uav-01', 'deep_scan')

    expect(ok).toBe(true)
    expect(loadSavedDroneWaypointRoute(storage, scenario.id, VARIANT, 'uav-01')).toMatchObject({
      source: 'command_route',
      route: useDroneStore.getState().droneWaypoints['uav-01'],
    })
  })

  it('autosaves an accepted route suggestion as a suggestion draft', () => {
    const route = scenario.perDroneWaypoints?.['uav-01'] ?? scenario.waypoints
    const suggestion: RouteSuggestion = {
      id: 'suggestion-1',
      droneId: 'uav-01',
      source: 'ROUTE ADVISOR',
      priority: 'routine',
      title: 'Test suggestion',
      rationale: 'Use known safe route.',
      riskLevel: 'routine',
      route,
      requiresApproval: true,
      createdAtSec: 0,
    }
    useDroneStore.setState({ routeSuggestions: [suggestion] })

    const ok = useDroneStore.getState().acceptRouteSuggestion('suggestion-1')

    expect(ok).toBe(true)
    expect(loadSavedDroneWaypointRoute(storage, scenario.id, VARIANT, 'uav-01')).toMatchObject({
      source: 'route_suggestion',
      route,
    })
  })

  it('does not autosave a rejected unsafe route', () => {
    const unsafeRoute: Waypoint[] = [
      { id: 'unsafe-a', label: 'Unsafe A', position: { lat: 37.7995, lng: -122.2875 }, altitudeFt: 100 },
      { id: 'unsafe-b', label: 'Unsafe B', position: { lat: 37.7995, lng: -122.2820 }, altitudeFt: 100 },
    ]

    const ok = useDroneStore.getState().setDroneRoute('uav-01', unsafeRoute)

    expect(ok).toBe(false)
    expect(loadSavedDroneWaypointRoute(storage, scenario.id, VARIANT, 'uav-01')).toBeNull()
    expect(useDroneStore.getState().routeSaveStatuses['uav-01']).toBeUndefined()
  })
})

function makeMemoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear() {
      data.clear()
    },
    getItem(key: string) {
      return data.get(key) ?? null
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null
    },
    removeItem(key: string) {
      data.delete(key)
    },
    setItem(key: string, value: string) {
      data.set(key, value)
    },
  }
}
