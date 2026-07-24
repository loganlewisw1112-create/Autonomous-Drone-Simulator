/**
 * Regression: fleets must not hover-stuck indefinitely.
 * Pins waypoint advance, thermal-hold auto-resume, dwell caps, and default RTB
 * after the last waypoint.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  effectiveDwellSec,
  getNextCommand,
  MAX_WAYPOINT_DWELL_SEC,
  THERMAL_HOLD_TIMEOUT_SEC,
  type MissionManagerState,
} from '@/sim/mission/MissionManager'
import { createDroneState } from '@/sim/drone/DroneEntity'
import { useDroneStore, MAX_REPLAY_FRAMES } from '@/store/droneStore'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import type { FullMissionFrame, Waypoint } from '@/types'

const BASE = { lat: 37.7695, lng: -122.4862 }
const BASE_WP: Waypoint = { id: 'base', position: BASE, altitudeFt: 0, label: 'Base' }

const ROUTE: Waypoint[] = [
  { id: 'wp0', position: { lat: 37.7700, lng: -122.4870 }, altitudeFt: 120, dwellTimeSec: 5 },
  { id: 'wp1', position: { lat: 37.7710, lng: -122.4855 }, altitudeFt: 120, dwellTimeSec: 90 },
  { id: 'wp2', position: { lat: 37.7720, lng: -122.4840 }, altitudeFt: 120 },
]

function mm(elapsedSec: number, waypoints = ROUTE): MissionManagerState {
  return {
    waypoints,
    basePosition: BASE_WP,
    elapsedSec,
    tick: Math.floor(elapsedSec / 0.05),
    assignedAltitudeFt: 120,
  }
}

describe('mission progress / hover-stuck regression', () => {
  it('caps authored dwells at MAX_WAYPOINT_DWELL_SEC', () => {
    expect(effectiveDwellSec(90)).toBe(MAX_WAYPOINT_DWELL_SEC)
    expect(effectiveDwellSec(12)).toBe(12)
    expect(effectiveDwellSec(undefined)).toBeUndefined()
  })

  it('advances waypoint index after capped dwell completes', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', ROUTE[1].position, 120)
    const hovering = {
      ...drone,
      missionState: 'hover' as const,
      currentWaypointIndex: 1,
      hoverStartSec: 0,
    }

    const mid = getNextCommand(hovering, mm(MAX_WAYPOINT_DWELL_SEC - 1))
    expect(mid.nextState).toBe('hover')
    expect(mid.nextWaypointIndex).toBe(1)

    const done = getNextCommand(hovering, mm(MAX_WAYPOINT_DWELL_SEC))
    expect(done.nextState).toBe('navigate')
    expect(done.nextWaypointIndex).toBe(2)
  })

  it('auto-resumes from thermal_hold by THERMAL_HOLD_TIMEOUT_SEC', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', ROUTE[0].position, 120)
    const holding = {
      ...drone,
      missionState: 'thermal_hold' as const,
      inspectReturnState: 'navigate' as const,
      thermalHoldStartSec: 100,
      currentWaypointIndex: 0,
    }

    expect(getNextCommand(holding, mm(100 + THERMAL_HOLD_TIMEOUT_SEC - 1)).nextState).toBe('thermal_hold')
    const resumed = getNextCommand(holding, mm(100 + THERMAL_HOLD_TIMEOUT_SEC))
    expect(resumed.nextState).toBe('navigate')
    expect(resumed.nextWaypointIndex).toBe(0)
  })

  it('enters return_to_base (or land path) after the last waypoint by T+route-complete', () => {
    const last = ROUTE[ROUTE.length - 1]
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', last.position, 120)
    const atFinal = {
      ...drone,
      missionState: 'navigate' as const,
      currentWaypointIndex: ROUTE.length - 1,
    }
    const result = getNextCommand(atFinal, mm(600))
    expect(['return_to_base', 'landed', 'recharge']).toContain(result.nextState)
  })
})

describe('replay stop-at-25-min recording (store)', () => {
  beforeEach(() => {
    useDroneStore.getState().resetMission()
  })

  it('stops appending once MAX_REPLAY_FRAMES is reached without dropping the first frame', () => {
    const store = useDroneStore.getState()
    expect(store.replayFrames).toHaveLength(0)
    expect(store.replayRecordingStopped).toBe(false)

    for (let i = 0; i < MAX_REPLAY_FRAMES; i++) {
      const frame: FullMissionFrame = {
        tick: i * 40,
        elapsedSec: i * 2,
        drones: [],
        thermalContacts: [],
        groundUnits: [],
        recoveryTeams: [],
        weatherState: getDefaultWeatherState(1),
        activeEventIds: [],
      }
      useDroneStore.getState().addReplayFrame(frame)
    }

    const full = useDroneStore.getState()
    expect(full.replayFrames).toHaveLength(MAX_REPLAY_FRAMES)
    expect(full.replayFrames[0].tick).toBe(0)
    expect(full.replayRecordingStopped).toBe(true)

    useDroneStore.getState().addReplayFrame({
      tick: MAX_REPLAY_FRAMES * 40,
      elapsedSec: MAX_REPLAY_FRAMES * 2,
      drones: [],
      thermalContacts: [],
      groundUnits: [],
      recoveryTeams: [],
      weatherState: getDefaultWeatherState(1),
      activeEventIds: [],
    })

    const after = useDroneStore.getState()
    expect(after.replayFrames).toHaveLength(MAX_REPLAY_FRAMES)
    expect(after.replayFrames[0].tick).toBe(0)
    expect(after.replayFrames[after.replayFrames.length - 1].tick).toBe((MAX_REPLAY_FRAMES - 1) * 40)
  })
})
