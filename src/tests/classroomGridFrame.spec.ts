import { describe, it, expect } from 'vitest'
import {
  Alert, alertSeverity, buildGridFrame, droneAlerts, decodeDrone,
  parseGridFrame, stateToCode, codeToState, MISSION_STATE_CODES,
  frameActiveDroneCount, frameLowestBattery,
} from '@/classroom/gridFrame'
import type { DroneState, MissionState } from '@/types'

function drone(over: Partial<DroneState> = {}): DroneState {
  return {
    id: 'd1', label: 'D1', color: '#39d98a',
    position: { lat: 37.7749, lng: -122.4194 },
    altitudeFt: 200, headingDeg: 90, speedMs: 12, batteryPct: 88, signalDbm: -55,
    missionState: 'navigate', currentWaypointIndex: 0,
    conflictFlag: false, geofenceBreachFlag: false, bvlosFlag: false, sortieCount: 0,
    ...over,
  }
}

describe('grid frame packing', () => {
  it('packs drones into fixed tuples with lat/lng ×1e5', () => {
    const frame = buildGridFrame({
      elapsedSec: 42.6, status: 1,
      drones: [drone({ id: 'alpha', position: { lat: 37.7749, lng: -122.4194 }, headingDeg: 91.4, batteryPct: 87.6, missionState: 'sar_grid' })],
      thermalContactCount: 2, eventCount: 5,
    })
    expect(frame.t).toBe(43)
    expect(frame.th).toBe(2)
    expect(frame.ev).toBe(5)
    expect(frame.d[0]).toEqual(['alpha', 3777490, -12241940, 91, 88, stateToCode('sar_grid')])
  })

  it('round-trips through JSON and parse, and decodeDrone inverts the tuple', () => {
    const frame = buildGridFrame({ elapsedSec: 10, status: 1, drones: [drone({ id: 'x' })], thermalContactCount: 0, eventCount: 0 })
    const reparsed = parseGridFrame(JSON.parse(JSON.stringify(frame)))
    expect(reparsed).toEqual(frame)
    const d = decodeDrone(reparsed.d[0])
    expect(d.id).toBe('x')
    expect(d.lat).toBeCloseTo(37.7749, 4)
    expect(d.lng).toBeCloseTo(-122.4194, 4)
  })

  it('state codes are a stable bijection over every MissionState', () => {
    for (const s of MISSION_STATE_CODES) {
      expect(codeToState(stateToCode(s))).toBe(s)
    }
    expect(codeToState(999)).toBe('idle')
  })
})

describe('alert bitfield', () => {
  const cases: Array<[Partial<DroneState>, number]> = [
    [{ geofenceBreachFlag: true }, Alert.GEOFENCE_BREACH],
    [{ conflictFlag: true }, Alert.CONFLICT],
    [{ signalDbm: -95 }, Alert.COMMS_LOST],
    [{ signalDbm: -82 }, Alert.COMMS_DEGRADED],
    [{ batteryPct: 8 }, Alert.BATTERY_CRIT],
    [{ batteryPct: 15 }, Alert.BATTERY_LOW],
    [{ missionState: 'emergency' as MissionState }, Alert.EMERGENCY],
    [{ missionState: 'return_to_base' as MissionState }, Alert.RTB],
    [{ missionState: 'recovery_requested' as MissionState }, Alert.RECOVERY_NEEDED],
  ]
  it('sets exactly the expected bit for each condition', () => {
    for (const [patch, bit] of cases) {
      expect(droneAlerts(drone(patch))).toBe(bit)
    }
  })

  it('combines bits across conditions on one drone', () => {
    const bits = droneAlerts(drone({ geofenceBreachFlag: true, batteryPct: 5, signalDbm: -95 }))
    expect(bits & Alert.GEOFENCE_BREACH).toBeTruthy()
    expect(bits & Alert.BATTERY_CRIT).toBeTruthy()
    expect(bits & Alert.COMMS_LOST).toBeTruthy()
  })

  it('promotes thermal-new via the input flag and grades severity', () => {
    const frame = buildGridFrame({
      elapsedSec: 1, status: 1, drones: [drone({ batteryPct: 15 })],
      thermalContactCount: 1, eventCount: 1, newThermalContact: true,
    })
    expect(frame.a & Alert.THERMAL_NEW).toBeTruthy()
    expect(frame.a & Alert.BATTERY_LOW).toBeTruthy()
    expect(alertSeverity(frame.a)).toBe('warn')

    expect(alertSeverity(Alert.GEOFENCE_BREACH | Alert.BATTERY_LOW)).toBe('crit')
    expect(alertSeverity(0)).toBe('none')
  })
})

describe('tile chrome helpers', () => {
  it('counts active drones and finds the lowest battery', () => {
    const frame = buildGridFrame({
      elapsedSec: 1, status: 1,
      drones: [
        drone({ id: 'a', missionState: 'navigate', batteryPct: 70 }),
        drone({ id: 'b', missionState: 'landed', batteryPct: 40 }),
        drone({ id: 'c', missionState: 'hover', batteryPct: 55 }),
      ],
      thermalContactCount: 0, eventCount: 0,
    })
    expect(frameActiveDroneCount(frame)).toBe(2) // navigate + hover, not landed
    expect(frameLowestBattery(frame)).toBe(40)
  })
})
