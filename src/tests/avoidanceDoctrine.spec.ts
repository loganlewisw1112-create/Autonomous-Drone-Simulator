/**
 * Conflict-avoidance doctrine (audit F-05).
 *
 * Detection always covered every airborne state, but the maneuver was entered only from
 * navigate/sar_grid/launch, so conflicts in hover, inspect, thermal_hold,
 * route_complete_loiter and return_to_base were flagged while both aircraft flew on. A
 * second, unnamed gap: the give-way aircraft was always idB, so a (maneuverable idA,
 * protected idB) pair produced no maneuver from either aircraft.
 *
 * These tests pin the doctrine table, the give-way selection including its fallback, and
 * the crossing-geometry behavior through the real production tick.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  AVOIDANCE_DOCTRINE,
  canEnterAvoidance,
  resolveGiveWayAssignments,
  selectGiveWayDrone,
} from '@/sim/safety/avoidanceDoctrine'
import type { ConflictPair } from '@/sim/safety/DeconflictEngine'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { useDroneStore } from '@/store/droneStore'
import { tick, stopSimLoop, initFleet } from '@/sim/SimulationLoop'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import type { DroneState, MissionState } from '@/types'

const scenario = ALL_SCENARIOS.find((s) => s.id === 'demo_basic') ?? ALL_SCENARIOS[0]

/** Exactly the states that were detected-but-never-maneuvered before this fix. */
const PREVIOUSLY_FLAG_ONLY: MissionState[] = [
  'hover', 'inspect', 'thermal_hold', 'route_complete_loiter', 'return_to_base',
]

describe('avoidance doctrine table', () => {
  it('assigns a disposition to every mission state', () => {
    // The Record<MissionState, …> type makes this a compile-time guarantee; this asserts it
    // at runtime too so a loosened type cannot silently reintroduce an undecided state.
    for (const [state, role] of Object.entries(AVOIDANCE_DOCTRINE)) {
      expect(['maneuver', 'protected', 'grounded'], `${state} has no valid role`).toContain(role)
    }
  })

  it('now maneuvers from every state that was previously flag-only', () => {
    for (const state of PREVIOUSLY_FLAG_ONLY) {
      expect(canEnterAvoidance(state), `${state} should give way`).toBe(true)
    }
  })

  it('keeps the originally covered states maneuvering', () => {
    for (const state of ['navigate', 'sar_grid', 'launch'] as MissionState[]) {
      expect(canEnterAvoidance(state)).toBe(true)
    }
  })

  it('protects emergency, lost link and an already-diverging aircraft', () => {
    for (const state of ['emergency', 'lost_link_hold', 'avoid'] as MissionState[]) {
      expect(canEnterAvoidance(state), `${state} must not be pulled off`).toBe(false)
      expect(AVOIDANCE_DOCTRINE[state]).toBe('protected')
    }
  })

  it('never asks a grounded aircraft to maneuver', () => {
    for (const state of ['idle', 'preflight', 'landed', 'recharge', 'stranded'] as MissionState[]) {
      expect(AVOIDANCE_DOCTRINE[state]).toBe('grounded')
      expect(canEnterAvoidance(state)).toBe(false)
    }
  })
})

describe('give-way selection', () => {
  const conflict: ConflictPair = { idA: 'uav-01', idB: 'uav-02', horizDistM: 12, vertDistFt: 4 }

  it('prefers idB so the choice stays deterministic', () => {
    const drones = [drone('uav-01', 'navigate'), drone('uav-02', 'navigate')]

    const selection = selectGiveWayDrone(conflict, drones)

    expect(selection?.giveWay.id).toBe('uav-02')
    expect(selection?.conflictWith.id).toBe('uav-01')
  })

  it('falls back to idA when idB is protected — the pair that used to separate nobody', () => {
    const drones = [drone('uav-01', 'navigate'), drone('uav-02', 'emergency')]

    const selection = selectGiveWayDrone(conflict, drones)

    expect(selection?.giveWay.id).toBe('uav-01')
    expect(selection?.conflictWith.id).toBe('uav-02')
  })

  it('returns no assignment when neither aircraft may maneuver', () => {
    const drones = [drone('uav-01', 'emergency'), drone('uav-02', 'lost_link_hold')]

    expect(selectGiveWayDrone(conflict, drones)).toBeNull()
  })

  it('assigns each aircraft at most one divergence per tick', () => {
    const drones = [drone('uav-01', 'navigate'), drone('uav-02', 'navigate'), drone('uav-03', 'navigate')]
    const conflicts: ConflictPair[] = [
      { idA: 'uav-01', idB: 'uav-02', horizDistM: 10, vertDistFt: 2 },
      { idA: 'uav-03', idB: 'uav-02', horizDistM: 11, vertDistFt: 3 },
    ]

    const assignments = resolveGiveWayAssignments(conflicts, drones)

    // uav-02 is give-way in both pairs; it can only fly one heading, so first wins.
    expect(assignments.size).toBe(1)
    expect(assignments.get('uav-02')?.conflictWith.id).toBe('uav-01')
  })
})

describe('crossing geometry through the production tick', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    useDroneStore.setState({
      // Heat sources removed so the automatic inspect hold cannot confound the geometry.
      scenario: { ...scenario, heatSources: [] },
      weatherState: getDefaultWeatherState(scenario.seed),
      launchPlan: null,
    })
    initFleet()
  })

  afterEach(() => {
    stopSimLoop()
    vi.useRealTimers()
  })

  it.each(PREVIOUSLY_FLAG_ONLY)('diverges an aircraft crossing while in %s', (state) => {
    const giveWay = setupCrossingPair(state)

    tick()

    const after = useDroneStore.getState().drones.find((d) => d.id === giveWay)!
    // avoidReturnState records the state the aircraft actually broke off from, which is the
    // precise thing this finding was about — a plain missionState check would pass even if
    // the mission manager had already moved it into navigate.
    expect(after.avoidReturnState, `${state} did not enter the maneuver`).toBe(state)
    expect(after.missionState).toBe('avoid')
  })

  it('does not pull an emergency aircraft off its descent', () => {
    setupCrossingPair('emergency')

    tick()

    const emergencyDrone = useDroneStore.getState().drones[1]
    expect(emergencyDrone.missionState).not.toBe('avoid')
  })

  it('makes the other aircraft give way instead when the pair includes a protected one', () => {
    setupCrossingPair('emergency')

    tick()

    // uav-01 is idA and navigating; with idB protected it must now take the maneuver.
    const other = useDroneStore.getState().drones[0]
    expect(other.missionState).toBe('avoid')
    expect(other.avoidReturnState).toBe('navigate')
  })

  it('emits avoidance_start naming the aircraft that was conflicted with', () => {
    setupCrossingPair('hover')

    tick()

    const start = useDroneStore.getState().events.find((e) => e.eventType === 'avoidance_start')
    expect(start).toBeDefined()
    expect(start!.payload.conflictWith).toBe(useDroneStore.getState().drones[0].id)
  })
})

describe('safety overrides still outrank the avoidance maneuver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    useDroneStore.setState({
      // Reserve is stated explicitly rather than inherited: the assertion below depends on
      // the aircraft sitting between the reserve and critical thresholds, and a scenario is
      // free to author its own reservePct.
      scenario: {
        ...scenario,
        heatSources: [],
        batteryProfile: {
          id: 'doctrine-test-pack',
          label: 'Doctrine test pack',
          capacityWh: 300,
          enduranceMultiplier: 1,
          notes: 'Reserve stated explicitly so the precedence assertion is deterministic.',
          ...scenario.batteryProfile,
          reservePct: 40,
        },
      },
      weatherState: getDefaultWeatherState(scenario.seed),
      launchPlan: null,
    })
    initFleet()
  })

  afterEach(() => {
    stopSimLoop()
    vi.useRealTimers()
  })

  it('keeps a reserve-triggered aircraft giving way while the conflict persists', () => {
    // 15% is below the 40% reserve set above but above the 8% critical cut — below 8 the
    // aircraft would go straight to emergency and never enter the maneuver at all.
    const giveWay = setupCrossingPair('return_to_base', { batteryPct: 15 })

    tick()
    expect(droneById(giveWay).missionState).toBe('avoid')

    // The mission manager pulls it back to return_to_base at the top of each tick, but the
    // pair is still converging, so the deconfliction pass re-assigns the divergence.
    // Separation is the immediate hazard; reserve is the slower one.
    tick()
    expect(droneById(giveWay).missionState).toBe('avoid')
  })

  it('settles the aircraft back onto RTB once separation is regained', () => {
    const giveWay = setupCrossingPair('return_to_base', { batteryPct: 15 })

    tick()
    expect(droneById(giveWay).missionState).toBe('avoid')

    // Move the other aircraft far away so no conflict is predicted, then let the reserve
    // override reclaim the give-way aircraft.
    const store = useDroneStore.getState()
    const otherId = store.drones[0].id
    store.setDrones(store.drones.map((d) => (
      d.id === otherId
        ? { ...d, position: { lat: d.position.lat + 0.05, lng: d.position.lng + 0.05 } }
        : d
    )))
    tick()

    const after = droneById(giveWay)
    expect(after.missionState).not.toBe('avoid')
    expect(['return_to_base', 'emergency']).toContain(after.missionState)
  })
})

/**
 * Place the first two drones on a converging head-on geometry inside the 30 m / 25 ft
 * training thresholds, with drone[1] (idB) in `state`. Returns the id expected to give way.
 *
 * The pair is deliberately staged ~1.1 km north of the scenario start: inside the 10 m
 * arrival radius a return_to_base aircraft completes its return and lands before the
 * deconfliction pass ever runs, so it could never be observed giving way.
 */
function setupCrossingPair(state: MissionState, patch: Partial<DroneState> = {}): string {
  const store = useDroneStore.getState()
  const [a, b] = store.drones
  const p = { lat: scenario.startPosition.lat + 0.01, lng: scenario.startPosition.lng }
  store.setDrones(store.drones.map((d) => {
    if (d.id === a.id) {
      return {
        ...d,
        missionState: 'navigate' as const,
        position: { lat: p.lat, lng: p.lng },
        altitudeFt: 120, speedMs: 8, headingDeg: 90, batteryPct: 80,
      }
    }
    if (d.id === b.id) {
      return {
        ...d,
        missionState: state,
        position: { lat: p.lat, lng: p.lng + 0.0001 },
        altitudeFt: 121, speedMs: 8, headingDeg: 270, batteryPct: 80,
        currentWaypointIndex: 0,
        hoverStartSec: 0,
        inspectStartSec: 0,
        thermalHoldStartSec: 0,
        emergencyStartSec: 0,
        ...patch,
      }
    }
    return d
  }))
  // A hover only holds while its current waypoint declares a dwell; without one the state
  // machine advances to navigate on the same tick and the hover case is never exercised.
  useDroneStore.setState({
    droneWaypoints: {
      ...useDroneStore.getState().droneWaypoints,
      [b.id]: [{ id: 'dwell-wp', position: { ...p }, altitudeFt: 120, dwellTimeSec: 20 }],
    },
  })
  useDroneStore.getState().setRunning(true)
  return b.id
}

function droneById(id: string): DroneState {
  return useDroneStore.getState().drones.find((d) => d.id === id)!
}

function drone(id: string, missionState: MissionState): DroneState {
  return {
    id,
    label: id.toUpperCase(),
    color: '#00d4ff',
    position: { ...scenario.startPosition },
    altitudeFt: 120,
    headingDeg: 90,
    speedMs: 8,
    batteryPct: 80,
    signalDbm: -60,
    missionState,
    currentWaypointIndex: 0,
    conflictFlag: true,
    geofenceBreachFlag: false,
    bvlosFlag: false,
    sortieCount: 0,
  }
}
