import { beforeEach, describe, expect, it, vi } from 'vitest'
import { executeInstructorCommand, validateInstructorCommand } from '@/classroom/commandRegistry'
import { CLASSROOM_INTERVENTION_ACTOR_PREFIX } from '@/classroom/commandAttribution'
import { useDroneStore } from '@/store/droneStore'
import { MAX_WAYPOINTS_PER_DRONE } from '@/sim/mission/routeLimits'
import type { DroneState } from '@/types'

function drone(id = 'uav-01'): DroneState {
  return {
    id,
    label: id.toUpperCase(),
    color: '#39d98a',
    position: { lat: 37.77, lng: -122.41 },
    altitudeFt: 180,
    headingDeg: 0,
    speedMs: 8,
    batteryPct: 80,
    signalDbm: -55,
    missionState: 'navigate',
    currentWaypointIndex: 0,
    conflictFlag: false,
    geofenceBreachFlag: false,
    bvlosFlag: false,
    sortieCount: 0,
  }
}

beforeEach(() => {
  useDroneStore.getState().resetMission()
  useDroneStore.getState().setDrones([drone()])
})

describe('classroom command registry security boundary', () => {
  it('rejects unknown kinds, extra fields and oversized routes', () => {
    expect(validateInstructorCommand({ commandId: 'cmd-1', kind: 'eval', script: 'x' })).toMatchObject({ ok: false, code: 'unknown_command' })
    expect(validateInstructorCommand({ commandId: 'cmd-2', kind: 'rtb', droneId: 'uav-01', admin: true })).toMatchObject({ ok: false, code: 'malformed' })
    expect(validateInstructorCommand({
      commandId: 'cmd-3',
      kind: 'set_route',
      droneId: 'uav-01',
      waypoints: Array.from({ length: MAX_WAYPOINTS_PER_DRONE + 1 }, (_, index) => ({
        id: `wp-${index}`,
        position: { lat: 37.77, lng: -122.41 },
        altitudeFt: 150,
      })),
    })).toMatchObject({ ok: false, code: 'malformed' })
  })

  it('executes only a validated command and attributes its evidence actor', () => {
    const checked = validateInstructorCommand({ commandId: 'cmd-hover', kind: 'hover', droneId: 'uav-01' })
    if (!checked.ok) throw new Error(checked.message)

    const result = executeInstructorCommand(checked.command, { actorSessionId: '7KX3M2' })

    expect(result).toEqual({ ok: true, commandId: 'cmd-hover', affectedDroneIds: ['uav-01'] })
    expect(useDroneStore.getState().drones[0].missionState).toBe('hover')
    expect(useDroneStore.getState().events.at(-1)?.operatorId).toBe(`${CLASSROOM_INTERVENTION_ACTOR_PREFIX}7KX3M2`)
  })

  it('rejects a valid command for an unknown drone without mutating evidence', () => {
    const checked = validateInstructorCommand({ commandId: 'cmd-rtb', kind: 'rtb', droneId: 'missing' })
    if (!checked.ok) throw new Error(checked.message)
    const before = useDroneStore.getState().events.length

    expect(executeInstructorCommand(checked.command, { actorSessionId: '7KX3M2' })).toMatchObject({
      ok: false,
      code: 'unknown_drone',
    })
    expect(useDroneStore.getState().events).toHaveLength(before)
  })

  it('normalizes set_route to replace and rejects unknown route modes', () => {
    const payload = {
      commandId: 'cmd-route',
      kind: 'set_route',
      droneId: 'uav-01',
      waypoints: [{ id: 'wp-1', position: { lat: 37.78, lng: -122.42 }, altitudeFt: 160 }],
    }

    expect(validateInstructorCommand(payload)).toMatchObject({
      ok: true,
      command: { mode: 'replace' },
    })
    expect(validateInstructorCommand({ ...payload, mode: 'append' })).toMatchObject({
      ok: false,
      code: 'malformed',
    })
  })

  it('passes divert_resume through to the shared route store action', () => {
    const checked = validateInstructorCommand({
      commandId: 'cmd-divert',
      kind: 'set_route',
      droneId: 'uav-01',
      mode: 'divert_resume',
      waypoints: [{ id: 'divert-1', position: { lat: 37.78, lng: -122.42 }, altitudeFt: 160 }],
    })
    if (!checked.ok) throw new Error(checked.message)
    const original = useDroneStore.getState().setDroneRoute
    const setDroneRoute = vi.fn(() => true)
    useDroneStore.setState({ setDroneRoute })
    try {
      expect(executeInstructorCommand(checked.command, { actorSessionId: '7KX3M2' })).toMatchObject({ ok: true })
      expect(setDroneRoute).toHaveBeenCalledWith(
        'uav-01',
        checked.command.kind === 'set_route' ? checked.command.waypoints : [],
        'set_route',
        'divert_resume',
      )
    } finally {
      useDroneStore.setState({ setDroneRoute: original })
    }
  })
})
