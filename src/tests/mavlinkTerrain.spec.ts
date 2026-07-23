import { describe, expect, it, vi } from 'vitest'
import { encodeDroneTelemetry, encodeGlobalPositionInt } from '@/utils/mavlink'
import type { DroneState } from '@/types'

const drone: DroneState = {
  id: 'uav-01', label: 'UAV-01', color: '#00d4ff',
  position: { lat: 37.9, lng: -122.24 }, altitudeFt: 100,
  headingDeg: 90, speedMs: 5, batteryPct: 90, signalDbm: -55,
  missionState: 'navigate', currentWaypointIndex: 0, conflictFlag: false,
  geofenceBreachFlag: false, bvlosFlag: false, sortieCount: 0,
}

describe('MAVLink terrain altitude semantics', () => {
  it('keeps relative_alt AGL while encoding sourced alt as MSL', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const fields = encodeGlobalPositionInt(drone, 152.4).fields
    expect(fields.relative_alt).toBe(30_480)
    expect(fields.alt).toBe(152_400)
    vi.restoreAllMocks()
  })

  it('uses an explicit unknown sentinel instead of mislabelling AGL as ASL', () => {
    const fields = encodeGlobalPositionInt(drone).fields
    expect(fields.alt).toBe(-1)
    expect(fields.relative_alt).toBe(30_480)
  })

  it('threads sourced MSL through the full decoded telemetry set', () => {
    const position = encodeDroneTelemetry(drone, 200)
      .find((message) => message.msgName === 'GLOBAL_POSITION_INT')
    expect(position?.fields.alt).toBe(200_000)
  })
})
