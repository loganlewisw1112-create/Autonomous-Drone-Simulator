import { beforeEach, describe, expect, it } from 'vitest'
import { useDroneStore } from '@/store/droneStore'
import type { DroneState } from '@/types'

function drone(): DroneState {
  return {
    id: 'uav-01', label: 'UAV-01', color: '#fff', position: { lat: 37, lng: -122 },
    altitudeFt: 120, headingDeg: 0, speedMs: 8, batteryPct: 80, signalDbm: -60,
    missionState: 'navigate', currentWaypointIndex: 0, conflictFlag: false,
    geofenceBreachFlag: false, bvlosFlag: false, sortieCount: 0,
  }
}

describe('generic command actor attribution', () => {
  beforeEach(() => {
    useDroneStore.setState({
      drones: [drone()],
      events: [],
      lastHash: '0'.repeat(64),
      commandActorId: null,
      operatorRole: 'pic',
    })
  })

  it('attributes synchronous operator evidence to the scoped actor and restores the prior actor', () => {
    const store = useDroneStore.getState()
    store.withCommandActor('control:teacher-7', () => store.returnDroneToBase('uav-01'))

    const state = useDroneStore.getState()
    expect(state.commandActorId).toBeNull()
    expect(state.events).toHaveLength(1)
    expect(state.events[0]).toMatchObject({
      eventType: 'operator_command',
      operatorId: 'control:teacher-7',
      droneId: 'uav-01',
      payload: { command: 'rtb' },
    })
  })

  it('restores the prior actor even when the command throws', () => {
    const store = useDroneStore.getState()
    expect(() => store.withCommandActor('control:teacher-7', () => {
      throw new Error('stop')
    })).toThrow('stop')
    expect(useDroneStore.getState().commandActorId).toBeNull()
  })

  it('uses the active operator outside an actor scope', () => {
    useDroneStore.getState().hoverDrone('uav-01')
    expect(useDroneStore.getState().events[0].operatorId).not.toBe('control:teacher-7')
  })
})
