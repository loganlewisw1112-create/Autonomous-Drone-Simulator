import { describe, expect, it } from 'vitest'
import { getMissionSafetyOverride } from '@/sim/mission/MissionManager'
import type { DroneState } from '@/types'

function drone(patch: Partial<DroneState> = {}): DroneState {
  return {
    id: 'uav-01', label: 'UAV-01', color: '#fff', position: { lat: 0, lng: 0 },
    altitudeFt: 120, headingDeg: 0, speedMs: 8, batteryPct: 80, signalDbm: -55,
    missionState: 'navigate', currentWaypointIndex: 0, conflictFlag: false,
    geofenceBreachFlag: false, bvlosFlag: false, sortieCount: 0,
    ...patch,
  }
}

describe('earliest confirmed battery reserve policy', () => {
  it('triggers RTB on percentage reserve', () => {
    expect(getMissionSafetyOverride(drone({ batteryPct: 24.9 }), { batteryReservePct: 25 })?.reason).toBe('battery_reserve')
  })

  it('triggers RTB on voltage reserve before percentage reserve', () => {
    expect(getMissionSafetyOverride(drone({ batteryPct: 60, cellVoltageV: 3.59 }), { batteryReservePct: 25 })?.reason).toBe('battery_reserve')
  })

  it('triggers RTB when estimated energy-to-home exceeds remaining percentage', () => {
    expect(getMissionSafetyOverride(drone({ batteryPct: 45, cellVoltageV: 3.9 }), {
      batteryReservePct: 25,
      batteryRequiredToHomePct: 46,
    })?.reason).toBe('battery_reserve')
  })

  it('treats invalid battery state conservatively as critical', () => {
    expect(getMissionSafetyOverride(drone({ batteryPct: Number.NaN }), {})?.reason).toBe('critical_battery')
    expect(getMissionSafetyOverride(drone({ cellVoltageV: Number.NaN }), {})?.reason).toBe('critical_battery')
  })
})
