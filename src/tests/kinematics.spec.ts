import { describe, it, expect } from 'vitest'
import { stepDrone, createDroneState } from '@/sim/drone/DroneEntity'

const BASE_POS = { lat: 37.7695, lng: -122.4862 }

describe('DroneEntity kinematics', () => {
  it('stays at rest with zero throttle', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS, 120)
    const next = stepDrone(drone, { throttle: 0 }, 0.05)
    expect(next.speedMs).toBeCloseTo(0, 2)
    expect(next.position.lat).toBeCloseTo(BASE_POS.lat, 6)
    expect(next.position.lng).toBeCloseTo(BASE_POS.lng, 6)
  })

  it('moves north when heading=0 and throttle>0', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS, 120)
    const d1 = stepDrone({ ...drone, headingDeg: 0 }, { targetHeadingDeg: 0, throttle: 1 }, 1.0)
    expect(d1.position.lat).toBeGreaterThan(BASE_POS.lat)
  })

  it('drains battery over time', () => {
    let drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS, 120)
    for (let i = 0; i < 100; i++) {
      drone = stepDrone(drone, { throttle: 0.8 }, 0.05)
    }
    expect(drone.batteryPct).toBeLessThan(100)
  })

  it('honors scenario-provided battery drain rate overrides', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS, 120)
    const enduranceKit = stepDrone(
      { ...drone, missionState: 'navigate' },
      { throttle: 1, targetHeadingDeg: 0, targetAltitudeFt: 100, batteryDrainRatePerSec: 0.018 },
      1,
    )

    expect(enduranceKit.batteryPct).toBeCloseTo(99.982, 3)
  })

  it('battery never goes below 0', () => {
    let drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS, 120)
    drone = { ...drone, batteryPct: 0 }
    for (let i = 0; i < 50; i++) {
      drone = stepDrone(drone, { throttle: 1 }, 0.05)
    }
    expect(drone.batteryPct).toBeGreaterThanOrEqual(0)
  })

  it('is deterministic — same inputs same output', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS, 120)
    const a = stepDrone(drone, { targetHeadingDeg: 45, throttle: 0.7 }, 0.05)
    const b = stepDrone(drone, { targetHeadingDeg: 45, throttle: 0.7 }, 0.05)
    expect(a.position.lat).toEqual(b.position.lat)
    expect(a.position.lng).toEqual(b.position.lng)
    expect(a.batteryPct).toEqual(b.batteryPct)
  })

  it('altitude clamps to 400ft', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS, 399)
    const next = stepDrone(drone, { targetAltitudeFt: 600, throttle: 0 }, 10)
    expect(next.altitudeFt).toBeLessThanOrEqual(400)
  })

  it('heading turns toward target at bounded rate', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#00d4ff', BASE_POS)
    // 0 → 90° in 1 step with 50ms dt: max turn = 90 * 0.05 = 4.5°
    const next = stepDrone(drone, { targetHeadingDeg: 90 }, 0.05)
    expect(next.headingDeg).toBeCloseTo(4.5, 1)
  })
})
