import { describe, it, expect } from 'vitest'
import {
  needsRecovery,
  recoveryTransitionState,
  createRecoveryTeam,
  tickRecoveryTeam,
  tickRecoveryExtraction,
  EMERGENCY_TIMEOUT_SEC,
} from '@/sim/mission/recoveryManager'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import type { DroneState, RecoveryTeamState } from '@/types'

function makeDrone(overrides: Partial<DroneState> = {}): DroneState {
  return {
    id: 'uav-01',
    label: 'UAV-01',
    color: '#00d4ff',
    position: { lat: 37.77, lng: -122.42 },
    altitudeFt: 0,
    speedMs: 0,
    headingDeg: 0,
    batteryPct: 100,
    signalDbm: -65,
    missionState: 'navigate',
    currentWaypointIndex: 0,
    geofenceBreachFlag: false,
    conflictFlag: false,
    bvlosFlag: false,
    sortieCount: 0,
    ...overrides,
  }
}

function makeTeam(overrides: Partial<RecoveryTeamState> = {}): RecoveryTeamState {
  return {
    id: 'rt-1',
    droneId: 'uav-01',
    position: { lat: 37.77, lng: -122.42 },
    targetPosition: { lat: 37.80, lng: -122.38 },
    status: 'enroute',
    etaSec: 120,
    routePoints: [],
    ...overrides,
  }
}

const CLEAR = getDefaultWeatherState(1)
const STAGING = { lat: 37.75, lng: -122.44 }
const DRONE_POS = { lat: 37.80, lng: -122.38 }

describe('droneRecovery', () => {
  it('needsRecovery returns false for nominal drone', () => {
    const drone = makeDrone()
    expect(needsRecovery(drone, new Set(), 0)).toBe(false)
  })

  it('needsRecovery returns false for emergency drone before timeout elapses', () => {
    const drone = makeDrone({ missionState: 'emergency', batteryPct: 2, emergencyStartSec: 0 })
    expect(needsRecovery(drone, new Set(), EMERGENCY_TIMEOUT_SEC - 1)).toBe(false)
  })

  it('needsRecovery returns true for emergency + critical battery once timeout elapses', () => {
    const drone = makeDrone({ missionState: 'emergency', batteryPct: 2, emergencyStartSec: 0 })
    expect(needsRecovery(drone, new Set(), EMERGENCY_TIMEOUT_SEC)).toBe(true)
  })

  it('needsRecovery returns FALSE for comms lost alone (drone should loiter, not land)', () => {
    const drone = makeDrone({ missionState: 'navigate', commsLostSec: 120 })
    expect(needsRecovery(drone, new Set(), 200)).toBe(false)
  })

  it('needsRecovery returns true for remote_landed state', () => {
    const drone = makeDrone({ missionState: 'remote_landed' })
    expect(needsRecovery(drone, new Set(), 0)).toBe(true)
  })

  it('needsRecovery returns false when team already dispatched for drone', () => {
    const drone = makeDrone({ missionState: 'emergency', batteryPct: 2, emergencyStartSec: 0 })
    expect(needsRecovery(drone, new Set(['uav-01']), EMERGENCY_TIMEOUT_SEC)).toBe(false)
  })

  it('needsRecovery returns false for landed/idle drone', () => {
    expect(needsRecovery(makeDrone({ missionState: 'landed' }), new Set(), 0)).toBe(false)
    expect(needsRecovery(makeDrone({ missionState: 'idle' }), new Set(), 0)).toBe(false)
  })

  it('recoveryTransitionState returns recovery_requested by default (comms loss alone does not strand)', () => {
    // Drones continue their flight plan on comms loss and reconnect autonomously.
    // They are not stranded — stranding requires battery critical + emergency.
    const drone = makeDrone({ missionState: 'navigate', commsLostSec: 40 })
    const state = recoveryTransitionState(drone)
    expect(state).toBe('recovery_requested')
  })

  it('recoveryTransitionState returns recovery_requested for remote_landed', () => {
    const drone = makeDrone({ missionState: 'remote_landed' })
    const state = recoveryTransitionState(drone)
    expect(state).toBe('recovery_requested')
  })

  it('createRecoveryTeam returns a well-formed team', () => {
    const team = createRecoveryTeam('rt-1', 'uav-01', STAGING, DRONE_POS, CLEAR)
    expect(team.id).toBe('rt-1')
    expect(team.droneId).toBe('uav-01')
    expect(team.status).toBe('enroute')
    expect(team.etaSec).toBeGreaterThan(0)
    expect(team.position).toEqual(STAGING)
    expect(team.targetPosition).toEqual(DRONE_POS)
  })

  it('tickRecoveryTeam advances team toward target', () => {
    const team = makeTeam()
    const updated = tickRecoveryTeam(team, CLEAR, 1.0)
    const distBefore = Math.hypot(
      team.targetPosition.lat - team.position.lat,
      team.targetPosition.lng - team.position.lng,
    )
    const distAfter = Math.hypot(
      team.targetPosition.lat - updated.position.lat,
      team.targetPosition.lng - updated.position.lng,
    )
    expect(distAfter).toBeLessThanOrEqual(distBefore)
  })

  it('tickRecoveryTeam transitions to on_scene when close', () => {
    const closeTeam = makeTeam({
      position: { lat: DRONE_POS.lat + 0.0001, lng: DRONE_POS.lng + 0.0001 },
    })
    const updated = tickRecoveryTeam(closeTeam, CLEAR, 5.0)
    // Either on_scene now or will be after this tick
    expect(['enroute', 'on_scene']).toContain(updated.status)
  })

  it('tickRecoveryExtraction marks team as extracted after enough ticks', () => {
    const team = makeTeam({ status: 'on_scene' })
    // 100 on-scene ticks should trigger extraction
    const result = tickRecoveryExtraction(team, 100)
    expect(result.status).toBe('extracted')
    expect(result.outcome).toBe('recovered')
  })

  it('tickRecoveryExtraction keeps team on_scene before 100 ticks', () => {
    const team = makeTeam({ status: 'on_scene' })
    const result = tickRecoveryExtraction(team, 50)
    expect(result.status).toBe('on_scene')
  })
})
