import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { createDroneState } from '@/sim/drone/DroneEntity'
import { MAX_WAYPOINTS_PER_DRONE } from '@/sim/mission/routeLimits'
import { loadSavedDroneWaypointRoute } from '@/sim/mission/waypointPersistence'
import { useDroneStore } from '@/store/droneStore'
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
const droneId = 'uav-01'
const authoredRoute = scenario.perDroneWaypoints?.[droneId] ?? scenario.waypoints
const safePosition = authoredRoute[0]?.position ?? scenario.startPosition

describe('drone store route application', () => {
  let storage: Storage

  beforeEach(() => {
    storage = makeMemoryStorage()
    vi.stubGlobal('localStorage', storage)
    const drone = {
      ...createDroneState(droneId, 'UAV-01', '#00d4ff', safePosition),
      missionState: 'navigate' as const,
      currentWaypointIndex: 2,
    }
    useDroneStore.setState({
      scenario,
      scenarioVariant: VARIANT,
      drones: [drone],
      droneWaypoints: { [droneId]: makeRoute('old', 4) },
      routeSuggestions: [],
      routeCommandError: null,
      routeCommandWarning: null,
      routeSaveStatuses: {},
      lastRouteChange: null,
      events: [],
      lastHash: '0'.repeat(64),
      commandActorId: null,
    })
  })

  it('keeps existing calls in replacement mode by default', () => {
    expect(useDroneStore.getState().setDroneRoute(droneId, makeRoute('new', 2))).toBe(true)

    expect(useDroneStore.getState().droneWaypoints[droneId].map((item) => item.id)).toEqual(['new-0', 'new-1'])
    expect(useDroneStore.getState().drones[0].currentWaypointIndex).toBe(0)
    expect(useDroneStore.getState().routeCommandWarning).toBeNull()
  })

  it('applies divert-and-resume atomically, persists it, and records attribution', () => {
    const store = useDroneStore.getState()
    const applied = store.withCommandActor('classroom:instructor:test', () => (
      store.setDroneRoute(droneId, makeRoute('divert', 2), 'set_route', 'divert_resume')
    ))

    expect(applied).toBe(true)
    const state = useDroneStore.getState()
    expect(state.droneWaypoints[droneId].map((item) => item.id)).toEqual([
      'divert-0', 'divert-1', 'old-2', 'old-3',
    ])
    expect(state.drones[0].currentWaypointIndex).toBe(0)
    expect(state.lastRouteChange?.previous[droneId]).toMatchObject({ currentWaypointIndex: 2 })
    expect(loadSavedDroneWaypointRoute(storage, scenario.id, VARIANT, droneId)?.route).toEqual(state.droneWaypoints[droneId])
    expect(state.events.at(-1)).toMatchObject({
      eventType: 'operator_command',
      operatorId: 'classroom:instructor:test',
      payload: { command: 'set_route', mode: 'divert_resume', resumedWaypointCount: 2 },
    })

    expect(state.undoLastRouteChange()).toBe(true)
    expect(useDroneStore.getState().droneWaypoints[droneId].map((item) => item.id)).toEqual([
      'old-0', 'old-1', 'old-2', 'old-3',
    ])
    expect(useDroneStore.getState().drones[0].currentWaypointIndex).toBe(2)
  })

  it('caps a divert route and surfaces its omitted waypoint count', () => {
    useDroneStore.setState({
      droneWaypoints: { [droneId]: makeRoute('old', MAX_WAYPOINTS_PER_DRONE) },
      drones: [{ ...useDroneStore.getState().drones[0], currentWaypointIndex: 1 }],
    })

    expect(useDroneStore.getState().setDroneRoute(droneId, makeRoute('divert', 4), 'set_route', 'divert_resume')).toBe(true)

    const state = useDroneStore.getState()
    expect(state.droneWaypoints[droneId]).toHaveLength(MAX_WAYPOINTS_PER_DRONE)
    expect(state.routeCommandWarning).toMatchObject({ code: 'route_capped', droppedWaypointCount: 3 })
    expect(state.routeCommandError).toBeNull()
    expect(state.events.at(-1)?.payload).toMatchObject({ capped: true, droppedWaypointCount: 3 })
  })

  it('forwards divert-and-resume when accepting a route suggestion', () => {
    const suggestion: RouteSuggestion = {
      id: 'suggestion-1',
      droneId,
      source: 'ROUTE ADVISOR',
      priority: 'routine',
      title: 'Divert',
      rationale: 'Handle a temporary task, then resume.',
      riskLevel: 'routine',
      route: makeRoute('suggested', 1),
      requiresApproval: true,
      createdAtSec: 0,
    }
    useDroneStore.setState({ routeSuggestions: [suggestion] })

    expect(useDroneStore.getState().acceptRouteSuggestion(suggestion.id, 'divert_resume')).toBe(true)
    expect(useDroneStore.getState().droneWaypoints[droneId].map((item) => item.id)).toEqual([
      'suggested-0', 'old-2', 'old-3',
    ])
    expect(useDroneStore.getState().routeSuggestions).toEqual([])
  })

  it('rejects an unsafe divert without partially changing the route or undo snapshot', () => {
    const before = useDroneStore.getState().droneWaypoints[droneId]
    const unsafeRoute: Waypoint[] = [
      { id: 'unsafe-a', label: 'Unsafe A', position: { lat: 37.7995, lng: -122.2875 }, altitudeFt: 100 },
      { id: 'unsafe-b', label: 'Unsafe B', position: { lat: 37.7995, lng: -122.2820 }, altitudeFt: 100 },
    ]

    expect(useDroneStore.getState().setDroneRoute(droneId, unsafeRoute, 'set_route', 'divert_resume')).toBe(false)

    const state = useDroneStore.getState()
    expect(state.droneWaypoints[droneId]).toEqual(before)
    expect(state.lastRouteChange).toBeNull()
    expect(state.routeCommandError).toContain('route rejected')
    expect(state.routeCommandWarning).toBeNull()
  })
})

function makeRoute(prefix: string, count: number): Waypoint[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    label: `${prefix} ${index}`,
    position: { ...safePosition },
    altitudeFt: 120,
  }))
}

function makeMemoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() { return data.size },
    clear() { data.clear() },
    getItem(key: string) { return data.get(key) ?? null },
    key(index: number) { return Array.from(data.keys())[index] ?? null },
    removeItem(key: string) { data.delete(key) },
    setItem(key: string, value: string) { data.set(key, value) },
  }
}
