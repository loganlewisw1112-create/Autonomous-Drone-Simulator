import { describe, it, expect } from 'vitest'
import { getNextCommand } from '@/sim/mission/MissionManager'
import { createDroneState } from '@/sim/drone/DroneEntity'
import type { MissionManagerState } from '@/sim/mission/MissionManager'
import type { Waypoint } from '@/types'

const BASE_POS = { lat: 37.7695, lng: -122.4862 }

const BASE_WP: Waypoint = { id: 'base', position: BASE_POS, altitudeFt: 0, label: 'Base' }

const WPS: Waypoint[] = [
  { id: 'wp1', position: { lat: 37.7700, lng: -122.4870 }, altitudeFt: 120 },
  { id: 'wp2', position: { lat: 37.7710, lng: -122.4855 }, altitudeFt: 120 },
]

function makeMM(waypoints = WPS, assignedAltitudeFt = 120): MissionManagerState {
  return { waypoints, basePosition: BASE_WP, elapsedSec: 0, tick: 0, assignedAltitudeFt }
}

describe('MissionManager state machine', () => {
  it('idle drone stays idle', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS)
    const { nextState } = getNextCommand({ ...drone, missionState: 'idle' }, makeMM())
    expect(nextState).toBe('idle')
  })

  it('low battery triggers RTB from navigate', () => {
    // drone must be away from base to avoid immediate landing resolution
    const awayPos = { lat: 37.7750, lng: -122.4900 }
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', awayPos, 120)
    const { nextState } = getNextCommand(
      { ...drone, missionState: 'navigate', batteryPct: 20 },
      makeMM(),
    )
    expect(nextState).toBe('return_to_base')
  })

  it('critical battery triggers emergency', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS, 120)
    const { nextState } = getNextCommand(
      { ...drone, missionState: 'navigate', batteryPct: 5 },
      makeMM(),
    )
    expect(nextState).toBe('emergency')
  })

  it('launch transitions to navigate when altitude reached', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS, 116)
    const { nextState } = getNextCommand(
      { ...drone, missionState: 'launch', altitudeFt: 116 },
      makeMM(),
    )
    expect(nextState).toBe('navigate')
  })

  it('no RTB override when already landed', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS)
    const { nextState } = getNextCommand(
      { ...drone, missionState: 'landed', batteryPct: 3 },
      makeMM(),
    )
    expect(nextState).toBe('landed')
  })

  it('navigate with no waypoints goes RTB', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS, 120)
    const { nextState } = getNextCommand(
      { ...drone, missionState: 'navigate' },
      makeMM([]),
    )
    expect(nextState).toBe('return_to_base')
  })

  it('inspect holds position until INSPECT_DWELL_SEC elapses, then enters thermal_hold', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS, 120)
    const inspecting = { ...drone, missionState: 'inspect' as const, inspectStartSec: 0, inspectReturnState: 'navigate' as const }

    const stillInspecting = getNextCommand(inspecting, { ...makeMM(), elapsedSec: 5 })
    expect(stillInspecting.nextState).toBe('inspect')
    expect(stillInspecting.cmd.throttle).toBe(0)

    const held = getNextCommand(inspecting, { ...makeMM(), elapsedSec: 8 })
    expect(held.nextState).toBe('thermal_hold')
    expect(held.cmd.throttle).toBe(0)
  })

  it('inspect enters thermal_hold even when no return state was recorded', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS, 120)
    const inspecting = { ...drone, missionState: 'inspect' as const, inspectStartSec: 0 }
    const { nextState } = getNextCommand(inspecting, { ...makeMM(), elapsedSec: 9999 })
    expect(nextState).toBe('thermal_hold')
  })

  it('thermal_hold hovers in place with throttle 0 until operator resumes', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS, 120)
    const holding = { ...drone, missionState: 'thermal_hold' as const, inspectReturnState: 'navigate' as const, thermalHoldStartSec: 0 }
    const { nextState, cmd } = getNextCommand(holding, { ...makeMM(), elapsedSec: 999 })
    expect(nextState).toBe('thermal_hold')
    expect(cmd.throttle).toBe(0)
  })

  it('recovered transitions to landed instead of staying terminal', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS)
    const { nextState } = getNextCommand({ ...drone, missionState: 'recovered' }, makeMM())
    expect(nextState).toBe('landed')
  })

  it('unrecoverable_sim stays terminal', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS)
    const { nextState } = getNextCommand({ ...drone, missionState: 'unrecoverable_sim' }, makeMM())
    expect(nextState).toBe('unrecoverable_sim')
  })

  it('recovery-pending states hold throttle at 0 instead of silently freezing the switch', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS)
    for (const state of ['remote_landed', 'stranded', 'recovery_requested', 'recovery_enroute'] as const) {
      const { nextState, cmd } = getNextCommand({ ...drone, missionState: state }, makeMM())
      expect(nextState).toBe(state)
      expect(cmd.throttle).toBe(0)
    }
  })

  it('reaching the final waypoint transitions to route_complete_loiter (NOT return_to_base)', () => {
    const finalWp = WPS[WPS.length - 1]
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', finalWp.position, 120)
    const { nextState, cmd } = getNextCommand(
      { ...drone, missionState: 'navigate', currentWaypointIndex: WPS.length - 1 },
      makeMM(),
    )
    expect(nextState).toBe('route_complete_loiter')
    expect(cmd.throttle).toBe(0)
    expect(cmd.targetAltitudeFt).toBe(120)
  })

  it('route_complete_loiter self-loops at assigned altitude with throttle 0', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS, 120)
    const { nextState, cmd } = getNextCommand(
      { ...drone, missionState: 'route_complete_loiter' },
      makeMM(),
    )
    expect(nextState).toBe('route_complete_loiter')
    expect(cmd.throttle).toBe(0)
    expect(cmd.targetAltitudeFt).toBe(120)
  })

  it('battery reserve interrupts route_complete_loiter and forces return_to_base', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', { lat: 37.7750, lng: -122.4900 }, 120)
    const { nextState } = getNextCommand(
      { ...drone, missionState: 'route_complete_loiter', batteryPct: 20 },
      makeMM(),
    )
    expect(nextState).toBe('return_to_base')
  })

  it('weatherForceRtb interrupts route_complete_loiter and forces return_to_base', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', { lat: 37.7750, lng: -122.4900 }, 120)
    const { nextState } = getNextCommand(
      { ...drone, missionState: 'route_complete_loiter' },
      { ...makeMM(), weatherForceRtb: true },
    )
    expect(nextState).toBe('return_to_base')
  })
})
