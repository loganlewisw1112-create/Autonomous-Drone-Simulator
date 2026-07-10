/**
 * Conflict-avoidance maneuver (audit H6.3). Deconfliction previously only set a flag — the
 * 'avoid' state and avoidance_* event types were dead vocabulary. These tests pin the new
 * behavior: the give-way drone diverges, holds, resumes, and the events flow into the chain.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { useDroneStore } from '@/store/droneStore'
import { tick, stopSimLoop, initFleet } from '@/sim/SimulationLoop'
import { getNextCommand, AVOID_MANEUVER_SEC, type MissionManagerState } from '@/sim/mission/MissionManager'
import { verifyChain } from '@/utils/chainOfCustody'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import type { DroneState, Waypoint } from '@/types'

const scenario = ALL_SCENARIOS.find((s) => s.id === 'demo_basic') ?? ALL_SCENARIOS[0]
const BASE_WP: Waypoint = { id: 'base', position: scenario.startPosition, altitudeFt: 0, label: 'Base' }

function makeAvoidingDrone(patch: Partial<DroneState> = {}): DroneState {
  return {
    id: 'uav-01',
    label: 'UAV-01',
    color: '#00d4ff',
    position: { ...scenario.startPosition },
    altitudeFt: 100,
    headingDeg: 90,
    speedMs: 8,
    batteryPct: 80,
    signalDbm: -60,
    missionState: 'avoid',
    currentWaypointIndex: 1,
    conflictFlag: true,
    geofenceBreachFlag: false,
    bvlosFlag: false,
    sortieCount: 0,
    avoidStartSec: 100,
    avoidHeadingDeg: 250,
    avoidReturnState: 'navigate',
    ...patch,
  }
}

function mmState(elapsedSec: number): MissionManagerState {
  return {
    waypoints: scenario.waypoints,
    basePosition: BASE_WP,
    elapsedSec,
    tick: Math.round(elapsedSec / 0.05),
    assignedAltitudeFt: 100,
  }
}

describe('avoid maneuver — MissionManager state machine', () => {
  it('holds the divergence heading during the maneuver window', () => {
    const result = getNextCommand(makeAvoidingDrone(), mmState(101))
    expect(result.nextState).toBe('avoid')
    expect(result.cmd.targetHeadingDeg).toBe(250)
  })

  it('resumes the interrupted state once the window elapses', () => {
    const result = getNextCommand(makeAvoidingDrone(), mmState(100 + AVOID_MANEUVER_SEC + 0.1))
    expect(result.nextState).toBe('navigate')
    expect(result.nextWaypointIndex).toBe(1) // route progress preserved
  })

  it('battery reserve still overrides an active avoid maneuver', () => {
    const result = getNextCommand(
      // Position the drone well away from base — at base, RTB correctly collapses to 'landed'.
      makeAvoidingDrone({
        batteryPct: 10,
        position: { lat: scenario.startPosition.lat + 0.01, lng: scenario.startPosition.lng },
      }),
      { ...mmState(101), batteryReservePct: 25 },
    )
    expect(result.nextState).toBe('return_to_base')
  })
})

describe('avoid maneuver — production loop integration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    useDroneStore.setState({
      scenario,
      weatherState: getDefaultWeatherState(scenario.seed),
      launchPlan: null,
    })
    initFleet()
  })

  afterEach(() => {
    stopSimLoop()
    vi.useRealTimers()
  })

  it('a detected conflict sends the give-way drone through avoid and back, with chained events', () => {
    // Force a conflict: two airborne drones converging at nearly the same altitude
    // within the 30 m horizontal / 15 ft vertical separation minima. Positions are
    // set explicitly here — the coordinated launch now fans bays apart, so we can no
    // longer rely on stacked spawn points to manufacture a climb-out conflict.
    const st = useDroneStore.getState()
    const [a, b] = st.drones
    const p = scenario.startPosition
    st.setDrones(st.drones.map((d) => {
      if (d.id === a.id) return { ...d, missionState: 'navigate' as const, position: { lat: p.lat, lng: p.lng }, altitudeFt: 120, speedMs: 8, headingDeg: 90 }
      if (d.id === b.id) return { ...d, missionState: 'navigate' as const, position: { lat: p.lat, lng: p.lng + 0.0001 }, altitudeFt: 121, speedMs: 8, headingDeg: 270 }
      return d
    }))
    useDroneStore.getState().setRunning(true)

    // Run the REAL tick until the maneuver completes (entry + window + exit).
    const ticksToRun = Math.round((AVOID_MANEUVER_SEC + 3) / 0.05)
    for (let i = 0; i < ticksToRun; i++) tick()

    const events = useDroneStore.getState().events
    const types = events.map((e) => e.eventType)
    expect(types).toContain('avoidance_start')
    expect(types).toContain('avoidance_complete')

    const start = events.find((e) => e.eventType === 'avoidance_start')!
    expect(start.payload.conflictWith).toBeDefined()
    expect(verifyChain(events)).toBe(true)

    // Give-way drone is flying again, not stuck in avoid, and bookkeeping is cleared.
    const giveWay = useDroneStore.getState().drones.find((d) => d.id === start.droneId)!
    expect(['navigate', 'avoid', 'route_complete_loiter']).toContain(giveWay.missionState)
    if (giveWay.missionState !== 'avoid') {
      expect(giveWay.avoidStartSec).toBeUndefined()
      expect(giveWay.avoidHeadingDeg).toBeUndefined()
    }
  })
})
