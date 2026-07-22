import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { loadSavedDroneWaypointRoute } from '@/sim/mission/waypointPersistence'
import { useDroneStore, type RouteChangeSnapshot } from '@/store/droneStore'
import type { DroneState, ScenarioVariantConfig, Waypoint } from '@/types'

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

describe('drone store route undo', () => {
  let storage: Storage

  beforeEach(() => {
    storage = makeMemoryStorage()
    vi.stubGlobal('localStorage', storage)
    useDroneStore.setState({
      scenario,
      scenarioVariant: VARIANT,
      drones: [],
      droneWaypoints: {},
      routeCommandError: null,
      routeSaveStatuses: {},
      lastRouteChange: null,
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('captures an accepted route mutation and restores it once without cancelling a safety state', () => {
    const originalRoute = cloneRoute(scenario.perDroneWaypoints?.['uav-01'] ?? scenario.waypoints)
    const expectedRoute = cloneRoute(originalRoute)
    const originalIndex = Math.min(1, Math.max(0, originalRoute.length - 1))
    const originalPosition = { lat: scenario.startPosition.lat, lng: scenario.startPosition.lng }
    useDroneStore.setState({
      drones: [makeDrone('uav-01', originalPosition, originalIndex)],
      droneWaypoints: { 'uav-01': originalRoute },
    })

    expect(useDroneStore.getState().setDroneRoute('uav-01', cloneRoute(originalRoute))).toBe(true)
    expect(useDroneStore.getState().lastRouteChange?.previous['uav-01']).toMatchObject({
      hadRoute: true,
      currentWaypointIndex: originalIndex,
      route: expectedRoute,
    })

    originalRoute[0].position.lat += 1
    const safetyPosition = { lat: originalPosition.lat + 0.001, lng: originalPosition.lng + 0.001 }
    useDroneStore.setState((state) => ({
      droneWaypoints: {
        ...state.droneWaypoints,
        'uav-01': [{ ...expectedRoute[0], id: 'retasked' }],
      },
      drones: state.drones.map((drone) => ({
        ...drone,
        position: safetyPosition,
        missionState: 'emergency' as const,
        currentWaypointIndex: 0,
      })),
    }))

    expect(useDroneStore.getState().undoLastRouteChange()).toBe(true)
    const restored = useDroneStore.getState()
    expect(restored.droneWaypoints['uav-01']).toEqual(expectedRoute)
    expect(restored.drones[0]).toMatchObject({
      position: safetyPosition,
      missionState: 'emergency',
      currentWaypointIndex: originalIndex,
    })
    expect(restored.lastRouteChange).toBeNull()
    expect(restored.undoLastRouteChange()).toBe(false)
    expect(loadSavedDroneWaypointRoute(storage, scenario.id, VARIANT, 'uav-01')).toMatchObject({
      route: expectedRoute,
      source: 'route_undo',
    })
  })

  it('restores a multi-drone snapshot atomically while preserving each live state', () => {
    const routeA = cloneRoute(scenario.perDroneWaypoints?.['uav-01'] ?? scenario.waypoints)
    const routeB = cloneRoute(scenario.perDroneWaypoints?.['uav-02'] ?? scenario.waypoints)
    const positionA = { lat: scenario.startPosition.lat + 0.001, lng: scenario.startPosition.lng }
    const positionB = { lat: scenario.startPosition.lat, lng: scenario.startPosition.lng + 0.001 }
    const snapshot: RouteChangeSnapshot = {
      scenarioId: scenario.id,
      changedAt: 1234,
      previous: {
        'uav-01': { hadRoute: true, route: routeA, currentWaypointIndex: Math.min(1, Math.max(0, routeA.length - 1)) },
        'uav-02': { hadRoute: true, route: routeB, currentWaypointIndex: 0 },
      },
    }
    useDroneStore.setState({
      drones: [
        makeDrone('uav-01', positionA, 0, 'return_to_base'),
        makeDrone('uav-02', positionB, 0, 'emergency'),
      ],
      droneWaypoints: {
        'uav-01': [{ ...routeA[0], id: 'new-a' }],
        'uav-02': [{ ...routeB[0], id: 'new-b' }],
      },
      lastRouteChange: snapshot,
    })

    expect(useDroneStore.getState().undoLastRouteChange()).toBe(true)
    const restored = useDroneStore.getState()
    expect(restored.droneWaypoints).toMatchObject({ 'uav-01': routeA, 'uav-02': routeB })
    expect(restored.drones[0]).toMatchObject({ position: positionA, missionState: 'return_to_base' })
    expect(restored.drones[1]).toMatchObject({ position: positionB, missionState: 'emergency' })
    expect(restored.lastRouteChange).toBeNull()
  })

  it('retains the live routes and snapshot when undo persistence fails', () => {
    const previousRoute = cloneRoute(scenario.perDroneWaypoints?.['uav-01'] ?? scenario.waypoints)
    const liveRoute = [{ ...previousRoute[0], id: 'live-route' }]
    const snapshot: RouteChangeSnapshot = {
      scenarioId: scenario.id,
      changedAt: 1234,
      previous: {
        'uav-01': { hadRoute: true, route: previousRoute, currentWaypointIndex: 0 },
      },
    }
    vi.stubGlobal('localStorage', makeFailingStorage())
    useDroneStore.setState({
      drones: [makeDrone('uav-01', scenario.startPosition, 0, 'emergency')],
      droneWaypoints: { 'uav-01': liveRoute },
      lastRouteChange: snapshot,
    })

    expect(useDroneStore.getState().undoLastRouteChange()).toBe(false)
    const state = useDroneStore.getState()
    expect(state.droneWaypoints['uav-01']).toEqual(liveRoute)
    expect(state.lastRouteChange).toEqual(snapshot)
    expect(state.routeSaveStatuses['uav-01']).toMatchObject({
      state: 'failed',
      source: 'route_undo',
    })
  })

  it('clears route history on scenario changes and both reset paths', () => {
    const snapshot: RouteChangeSnapshot = { scenarioId: scenario.id, changedAt: 1, previous: {} }

    useDroneStore.setState({ lastRouteChange: snapshot })
    useDroneStore.getState().setScenario(scenario)
    expect(useDroneStore.getState().lastRouteChange).toBeNull()

    useDroneStore.setState({ lastRouteChange: snapshot })
    useDroneStore.getState().resetMission()
    expect(useDroneStore.getState().lastRouteChange).toBeNull()

    useDroneStore.setState({ lastRouteChange: snapshot })
    useDroneStore.getState().resetInvestorDemo()
    expect(useDroneStore.getState().lastRouteChange).toBeNull()
  })
})

function makeDrone(
  id: string,
  position: DroneState['position'],
  currentWaypointIndex: number,
  missionState: DroneState['missionState'] = 'navigate',
): DroneState {
  return {
    id,
    label: id.toUpperCase(),
    color: '#00d4ff',
    position,
    altitudeFt: 120,
    headingDeg: 90,
    speedMs: 8,
    batteryPct: 80,
    signalDbm: -60,
    missionState,
    currentWaypointIndex,
    conflictFlag: false,
    geofenceBreachFlag: false,
    bvlosFlag: false,
    sortieCount: 0,
  }
}

function cloneRoute(route: Waypoint[]): Waypoint[] {
  return route.map((waypoint) => ({ ...waypoint, position: { ...waypoint.position } }))
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

function makeFailingStorage(): Storage {
  return {
    length: 0,
    clear() {},
    getItem() { return null },
    key() { return null },
    removeItem() { throw new Error('storage unavailable') },
    setItem() { throw new Error('storage unavailable') },
  }
}
