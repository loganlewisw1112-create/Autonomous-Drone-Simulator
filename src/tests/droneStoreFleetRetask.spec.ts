import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clampAdvisorRoute } from '@/sim/mission/fleetRetaskApply'
import { MAX_WAYPOINTS_PER_DRONE } from '@/sim/mission/routeLimits'
import { loadSavedDroneWaypointRoute } from '@/sim/mission/waypointPersistence'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import {
  FLEET_RETASK_COOLDOWN_MS,
  FLEET_RETASK_UNDO_WINDOW_MS,
  useDroneStore,
  type RouteChangeSnapshot,
} from '@/store/droneStore'
import type { DroneState, ScenarioConfig, ScenarioVariantConfig, Waypoint } from '@/types'

const origin = { lat: 37, lng: -122 }
const variant: ScenarioVariantConfig = {
  seed: 7,
  timeOfDay: 'day',
  season: 'spring',
  weatherSeverity: 0,
  commsDegradation: 0,
  thermalDensity: 1,
  batteryPressure: 0,
  terrainDifficulty: 0,
}

describe('drone store fleet retask apply', () => {
  let storage: CountingStorage

  beforeEach(() => {
    storage = makeCountingStorage()
    vi.stubGlobal('localStorage', storage)
    seedStore(makeScenario())
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('applies multiple routes with one write and restores them with the shared undo', () => {
    const before = cloneRoutes(useDroneStore.getState().droneWaypoints)
    const result = useDroneStore.getState().retaskFleet(10_000)

    expect(result.status).toBe('applied')
    expect(result.changedDroneIds).toEqual(['uav-01', 'uav-02'])
    expect(result.entries.filter((entry) => entry.status === 'applied')).toHaveLength(2)
    expect(storage.setCount).toBe(1)
    expect(useDroneStore.getState().lastRouteChange?.changedAt).toBe(10_000)
    expect(useDroneStore.getState().drones.map(({ missionState, currentWaypointIndex }) => ({ missionState, currentWaypointIndex }))).toEqual([
      { missionState: 'navigate', currentWaypointIndex: 0 },
      { missionState: 'navigate', currentWaypointIndex: 0 },
    ])
    expect(loadSavedDroneWaypointRoute(storage, 'fleet-retask-test', variant, 'uav-01')?.source).toBe('fleet_retask')
    expect(useDroneStore.getState().events.filter((event) => event.payload.source === 'fleet_retask')).toHaveLength(2)

    expect(useDroneStore.getState().undoFleetRetask(10_001)).toBe(true)
    expect(useDroneStore.getState().droneWaypoints).toEqual(before)
    expect(storage.setCount).toBe(2)
  })

  it('reports advisor holds and protected drones without mutating routes', () => {
    const scenario = makeScenario({ operationalFeatures: [], rechargeStations: [], perDroneRechargeStationIds: {} })
    seedStore(scenario, [
      makeDrone('uav-01', { position: { lat: 37.02, lng: -122.02 }, batteryPct: 25.01 }),
      makeDrone('uav-02', { missionState: 'emergency' }),
    ])
    const before = cloneRoutes(useDroneStore.getState().droneWaypoints)

    const result = useDroneStore.getState().retaskFleet(20_000)

    expect(result.status).toBe('no_change')
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ droneId: 'uav-01', status: 'held', reason: 'advisor_hold' }),
      expect.objectContaining({ droneId: 'uav-02', status: 'skipped', reason: 'not_retaskable' }),
    ]))
    expect(useDroneStore.getState().droneWaypoints).toEqual(before)
    expect(useDroneStore.getState().lastRouteChange).toBeNull()
    expect(storage.setCount).toBe(0)
  })

  it('applies RTB state intentionally and undoes it safely at the eight-second boundary', () => {
    const scenario = makeScenario({ operationalFeatures: [], rechargeStations: [], perDroneRechargeStationIds: {} })
    seedStore(scenario, [makeDrone('uav-01', { position: { lat: 37.002, lng: -122.002 } })])
    const beforeRoute = cloneRoutes(useDroneStore.getState().droneWaypoints)

    const applied = useDroneStore.getState().retaskFleet(90_000)

    expect(applied.entries).toContainEqual(expect.objectContaining({
      droneId: 'uav-01', status: 'applied', action: 'rtb_now',
    }))
    expect(applied.undoUntil).toBe(90_000 + FLEET_RETASK_UNDO_WINDOW_MS)
    expect(useDroneStore.getState().fleetRetaskUndo?.undoUntil).toBe(applied.undoUntil)
    expect(useDroneStore.getState().drones[0].missionState).toBe('return_to_base')

    expect(useDroneStore.getState().undoFleetRetask(90_000 + FLEET_RETASK_UNDO_WINDOW_MS)).toBe(true)
    expect(useDroneStore.getState().drones[0].missionState).toBe('navigate')
    expect(useDroneStore.getState().droneWaypoints).toEqual(beforeRoute)

    seedStore(scenario, [makeDrone('uav-01', { position: { lat: 37.002, lng: -122.002 } })])
    useDroneStore.getState().retaskFleet(100_000)
    useDroneStore.setState((state) => ({
      drones: state.drones.map((drone) => ({ ...drone, batteryPct: 5, missionState: 'emergency' as const })),
    }))
    vi.spyOn(Date, 'now').mockReturnValue(100_001)
    expect(useDroneStore.getState().undoLastRouteChange()).toBe(true)
    expect(useDroneStore.getState().drones[0].missionState).toBe('emergency')
  })

  it('expires fleet undo immediately after the eight-second boundary', () => {
    useDroneStore.getState().retaskFleet(110_000)
    const appliedRoutes = cloneRoutes(useDroneStore.getState().droneWaypoints)

    expect(useDroneStore.getState().undoFleetRetask(110_000 + FLEET_RETASK_UNDO_WINDOW_MS + 1)).toBe(false)
    expect(useDroneStore.getState().droneWaypoints).toEqual(appliedRoutes)
    expect(useDroneStore.getState().fleetRetaskUndo).toBeNull()
    expect(useDroneStore.getState().lastRouteChange).toBeNull()
  })

  it('fails closed when persistence fails without changing routes, snapshot, cache, or history', () => {
    vi.stubGlobal('localStorage', makeFailingStorage())
    const beforeRoutes = cloneRoutes(useDroneStore.getState().droneWaypoints)
    const snapshot: RouteChangeSnapshot = {
      scenarioId: 'fleet-retask-test',
      changedAt: 123,
      previous: {},
    }
    useDroneStore.setState({ lastRouteChange: snapshot })

    const result = useDroneStore.getState().retaskFleet(30_000)
    const state = useDroneStore.getState()

    expect(result.status).toBe('failed')
    expect(result.entries.filter((entry) => entry.reason === 'persistence_failed')).toHaveLength(2)
    expect(state.droneWaypoints).toEqual(beforeRoutes)
    expect(state.lastRouteChange).toEqual(snapshot)
    expect(state.fleetRetaskCache).toBeNull()
    expect(state.fleetRetaskHistory).toEqual([])
  })

  it('keeps applied routes and fleet snapshot when fleet undo persistence fails', () => {
    useDroneStore.getState().retaskFleet(120_000)
    const appliedRoutes = cloneRoutes(useDroneStore.getState().droneWaypoints)
    const undoSnapshot = useDroneStore.getState().fleetRetaskUndo
    vi.stubGlobal('localStorage', makeFailingStorage())

    expect(useDroneStore.getState().undoFleetRetask(120_001)).toBe(false)
    expect(useDroneStore.getState().droneWaypoints).toEqual(appliedRoutes)
    expect(useDroneStore.getState().fleetRetaskUndo).toEqual(undoSnapshot)
    expect(useDroneStore.getState().lastRouteChange?.source).toBe('fleet_retask')
  })

  it('blocks duplicate writes during cooldown and returns a same-situation cached result', () => {
    const first = useDroneStore.getState().retaskFleet(40_000)
    expect(first.status).toBe('applied')
    expect(storage.setCount).toBe(1)

    const changedSituation = useDroneStore.getState().retaskFleet(40_001)
    expect(changedSituation.status).toBe('cooldown')
    expect(changedSituation.cooldownUntil).toBe(40_000 + FLEET_RETASK_COOLDOWN_MS)
    expect(storage.setCount).toBe(1)

    const holdScenario = makeScenario({ operationalFeatures: [], rechargeStations: [], perDroneRechargeStationIds: {} })
    seedStore(holdScenario, [makeDrone('uav-01', { position: { lat: 37.02, lng: -122.02 }, batteryPct: 25.01 })])
    const noChange = useDroneStore.getState().retaskFleet(50_000)
    const cached = useDroneStore.getState().retaskFleet(50_001)
    expect(noChange.status).toBe('no_change')
    expect(cached.status).toBe('cached')
    expect(cached.fromCache).toBe(true)
    expect(cached.situationHash).toBe(noChange.situationHash)
    expect(useDroneStore.getState().fleetRetaskHistory).toHaveLength(1)
    expect(storage.setCount).toBe(1)
  })

  it('clears plan, result, cache, and history on scenario and reset paths', () => {
    const result = useDroneStore.getState().retaskFleet(60_000)
    expect(result.status).toBe('applied')
    expect(useDroneStore.getState().fleetRetaskHistory).toHaveLength(1)

    useDroneStore.getState().setScenario(makeScenario())
    expectRetaskStateCleared()

    seedStore(makeScenario())
    useDroneStore.getState().retaskFleet(70_000)
    useDroneStore.getState().resetMission()
    expectRetaskStateCleared()

    seedStore(makeScenario())
    useDroneStore.getState().retaskFleet(80_000)
    useDroneStore.getState().resetInvestorDemo()
    expectRetaskStateCleared()
  })

  it('invalidates fleet planning state on route, variant, and weather mutations', () => {
    useDroneStore.getState().retaskFleet(130_000)
    const currentRoute = useDroneStore.getState().droneWaypoints['uav-01']
    const manualRoute = currentRoute.map((item, index) => ({ ...item, id: `manual-${index}`, position: { ...item.position } }))
    expect(useDroneStore.getState().setDroneRoute('uav-01', manualRoute)).toBe(true)
    expect(useDroneStore.getState().latestFleetRetaskPlan).toBeNull()
    expect(useDroneStore.getState().latestFleetRetaskResult).toBeNull()
    expect(useDroneStore.getState().fleetRetaskCache).toBeNull()
    expect(useDroneStore.getState().fleetRetaskUndo).toBeNull()
    expect(useDroneStore.getState().lastRouteChange?.source).toBe('manual')

    seedStore(makeScenario())
    useDroneStore.getState().retaskFleet(140_000)
    useDroneStore.getState().setScenarioVariant({ ...variant, seed: 99 })
    expectCurrentFleetPlanningCleared()

    seedStore(makeScenario())
    useDroneStore.getState().retaskFleet(150_000)
    useDroneStore.getState().setWeatherState({ ...getDefaultWeatherState(7), gustKts: 20 })
    expectCurrentFleetPlanningCleared()
  })

  it.each(['hover', 'resume', 'rtb'] as const)('invalidates fleet undo after manual %s on an affected drone', (command) => {
    seedStore(makeScenario())
    useDroneStore.getState().retaskFleet(160_000)
    expect(useDroneStore.getState().fleetRetaskUndo?.previous['uav-01']).toBeDefined()
    expect(useDroneStore.getState().latestFleetRetaskPlan).not.toBeNull()
    expect(useDroneStore.getState().latestFleetRetaskResult).not.toBeNull()
    expect(useDroneStore.getState().fleetRetaskCache).not.toBeNull()

    if (command === 'hover') useDroneStore.getState().hoverDrone('uav-01')
    else if (command === 'resume') useDroneStore.getState().resumeDrone('uav-01')
    else useDroneStore.getState().returnDroneToBase('uav-01')

    expect(useDroneStore.getState().fleetRetaskUndo).toBeNull()
    expect(useDroneStore.getState().lastRouteChange).toBeNull()
    expect(useDroneStore.getState().latestFleetRetaskPlan).toBeNull()
    expect(useDroneStore.getState().latestFleetRetaskResult).toBeNull()
    expect(useDroneStore.getState().fleetRetaskCache).toBeNull()
    expect(useDroneStore.getState().undoLastRouteChange()).toBe(false)
  })

  it('caps advisor routes at the shared fleet limit without mutating the input', () => {
    const route = Array.from({ length: MAX_WAYPOINTS_PER_DRONE + 3 }, (_, index) => waypoint(`wp-${index}`, index))
    const capped = clampAdvisorRoute(route)

    expect(capped).toHaveLength(MAX_WAYPOINTS_PER_DRONE)
    expect(route).toHaveLength(MAX_WAYPOINTS_PER_DRONE + 3)
    expect(capped[0]).not.toBe(route[0])
    expect(capped[0].position).not.toBe(route[0].position)
  })
})

function seedStore(scenario: ScenarioConfig, drones = [makeDrone('uav-01'), makeDrone('uav-02')]): void {
  useDroneStore.setState({
    scenario,
    scenarioVariant: variant,
    drones,
    tick: 1_000,
    elapsedSec: 50,
    droneWaypoints: cloneRoutes(scenario.perDroneWaypoints ?? {}),
    thermalContacts: [],
    groundUnits: [],
    positionHistory: Object.fromEntries(drones.map((drone) => [drone.id, [origin, drone.position]])),
    weatherState: getDefaultWeatherState(scenario.seed),
    events: [],
    lastHash: '0'.repeat(64),
    routeSaveStatuses: {},
    lastRouteChange: null,
    latestFleetRetaskPlan: null,
    latestFleetRetaskResult: null,
    fleetRetaskCache: null,
    fleetRetaskHistory: [],
    fleetRetaskUndo: null,
  })
}

function makeScenario(overrides: Partial<ScenarioConfig> = {}): ScenarioConfig {
  return {
    id: 'fleet-retask-test',
    name: 'Fleet Retask Test',
    description: 'Fleet apply fixture',
    seed: 7,
    droneCount: 2,
    missionType: 'waypoint',
    startPosition: origin,
    waypoints: [waypoint('base', 1)],
    perDroneWaypoints: {
      'uav-01': [waypoint('route-a', 1)],
      'uav-02': [waypoint('route-b', 2)],
    },
    geofences: [],
    heatSources: [],
    batteryStartPct: 100,
    batteryDrainRatePerSec: 0.002,
    commsLossWindows: [],
    operationalFeatures: [
      { id: 'lkl', type: 'last_known', label: 'Last Known', points: [{ lat: 37.004, lng: -121.997 }], priority: 'urgent' },
      { id: 'sector', type: 'search_sector', label: 'Search Sector', points: [{ lat: 37.003, lng: -122.004 }], priority: 'urgent' },
    ],
    rechargeStations: [{
      id: 'station-a',
      label: 'Station A',
      position: { lat: 37.0002, lng: -122.0002 },
      road: 'Access Road',
      agency: 'UAS OPS',
    }],
    perDroneRechargeStationIds: { 'uav-01': ['station-a'], 'uav-02': ['station-a'] },
    ...overrides,
  }
}

function makeDrone(id: string, overrides: Partial<DroneState> = {}): DroneState {
  return {
    id,
    label: id.toUpperCase(),
    color: '#00d4ff',
    position: { ...origin, lng: origin.lng + (id === 'uav-02' ? 0.0001 : 0) },
    altitudeFt: 120,
    headingDeg: 90,
    speedMs: 8,
    batteryPct: 80,
    signalDbm: -60,
    missionState: 'navigate',
    currentWaypointIndex: 1,
    conflictFlag: false,
    geofenceBreachFlag: false,
    bvlosFlag: false,
    sortieCount: 0,
    ...overrides,
  }
}

function waypoint(id: string, offset: number): Waypoint {
  return {
    id,
    position: { lat: origin.lat + offset * 0.0002, lng: origin.lng + offset * 0.0002 },
    altitudeFt: 120,
  }
}

function cloneRoutes(routes: Record<string, Waypoint[]>): Record<string, Waypoint[]> {
  return Object.fromEntries(Object.entries(routes).map(([droneId, route]) => [
    droneId,
    route.map((item) => ({ ...item, position: { ...item.position } })),
  ]))
}

function expectRetaskStateCleared(): void {
  const state = useDroneStore.getState()
  expect(state.latestFleetRetaskPlan).toBeNull()
  expect(state.latestFleetRetaskResult).toBeNull()
  expect(state.fleetRetaskCache).toBeNull()
  expect(state.fleetRetaskHistory).toEqual([])
  expect(state.fleetRetaskUndo).toBeNull()
}

function expectCurrentFleetPlanningCleared(): void {
  const state = useDroneStore.getState()
  expect(state.latestFleetRetaskPlan).toBeNull()
  expect(state.latestFleetRetaskResult).toBeNull()
  expect(state.fleetRetaskCache).toBeNull()
  expect(state.fleetRetaskUndo).toBeNull()
  expect(state.lastRouteChange).toBeNull()
}

interface CountingStorage extends Storage {
  setCount: number
}

function makeCountingStorage(): CountingStorage {
  const data = new Map<string, string>()
  return {
    setCount: 0,
    get length() { return data.size },
    clear() { data.clear() },
    getItem(key: string) { return data.get(key) ?? null },
    key(index: number) { return Array.from(data.keys())[index] ?? null },
    removeItem(key: string) { data.delete(key) },
    setItem(key: string, value: string) {
      this.setCount += 1
      data.set(key, value)
    },
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
