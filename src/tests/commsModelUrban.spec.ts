import { describe, expect, it } from 'vitest'

import { applyCommsModel } from '@/sim/safety/SafetyManager'
import { buildWeatherState, getWeatherProfile } from '@/sim/weather/weatherEngine'
import type { DroneState, ScenarioConfig, ScenarioVariantConfig } from '@/types'

const URBAN_VARIANT: ScenarioVariantConfig = {
  seed: 4401,
  timeOfDay: 'day',
  season: 'summer',
  weatherSeverity: 3,
  commsDegradation: 2,
  thermalDensity: 1,
  batteryPressure: 1,
  terrainDifficulty: 1,
}

const CLEAR_URBAN_VARIANT: ScenarioVariantConfig = {
  ...URBAN_VARIANT,
  weatherSeverity: 0,
  commsDegradation: 0,
}

function makeScenario(commsLossWindows: ScenarioConfig['commsLossWindows'] = []): ScenarioConfig {
  return {
    id: 'urban-comms-test',
    name: 'Urban Comms Test',
    description: 'Urban signal regression fixture',
    seed: 1,
    droneCount: 1,
    missionType: 'waypoint',
    startPosition: { lat: 34, lng: -118 },
    waypoints: [],
    geofences: [],
    heatSources: [],
    batteryStartPct: 90,
    batteryDrainRatePerSec: 0.01,
    commsLossWindows,
  }
}

function makeDrone(signalDbm: number): DroneState {
  return {
    id: 'drone-1',
    label: 'Drone 1',
    color: '#00bcd4',
    position: { lat: 34, lng: -118 },
    altitudeFt: 120,
    headingDeg: 0,
    speedMs: 8,
    batteryPct: 88,
    signalDbm,
    missionState: 'navigate',
    currentWaypointIndex: 0,
    conflictFlag: false,
    geofenceBreachFlag: false,
    bvlosFlag: false,
    sortieCount: 1,
  }
}

describe('urban comms regression', () => {
  it('keeps urban weather out of rf_shadow and applies the stronger urban comms floor and ceiling', () => {
    const profile = getWeatherProfile('urban')
    const weather = buildWeatherState(profile, URBAN_VARIANT)

    expect(profile.possibleHazards).not.toContain('rf_shadow')
    expect(weather.activeHazards).not.toContain('rf_shadow')
    expect(weather.commsReliabilityFactor).toBeGreaterThanOrEqual(0.95)
    expect(weather.commsSignalCeilingDbm).toBe(-45)
  })

  // WP-8 rewrote these two against the physical link budget. They previously asserted the
  // behaviour of a per-tick ramp toward a weather "recovery ceiling" — a construct that no
  // longer exists, because signal is now computed from geometry rather than integrated over
  // time. What they were really protecting is preserved: weather still degrades the urban link,
  // and it still does so by a bounded amount rather than compounding every tick.

  it('signal is a function of geometry, not of how many ticks have elapsed', () => {
    const weather = { ...buildWeatherState(getWeatherProfile('urban'), CLEAR_URBAN_VARIANT), commsReliabilityFactor: 1 }
    const scenario = makeScenario()
    const first = applyCommsModel([makeDrone(-55)], 0, scenario, weather)[0]

    // Re-running for 40 s from an absurd starting signal must land on the same value: there is
    // no integrator left to wind up or settle.
    let drones = [makeDrone(-99)]
    for (let elapsedSec = 0; elapsedSec < 40; elapsedSec++) {
      drones = applyCommsModel(drones, elapsedSec, scenario, weather)
    }
    expect(drones[0].signalDbm).toBe(first.signalDbm)
    expect(drones[0].bvlosFlag).toBe(false)
    // Parked on top of the ground station, the link is as good as the scale allows.
    expect(drones[0].signalDbm).toBeGreaterThan(-60)
  })

  it('caps urban weather degradation instead of compounding it every tick', () => {
    const clear = { ...buildWeatherState(getWeatherProfile('urban'), CLEAR_URBAN_VARIANT), commsReliabilityFactor: 1 }
    const severe = buildWeatherState(getWeatherProfile('urban'), URBAN_VARIANT)
    const scenario = makeScenario()

    let drones = [makeDrone(-55)]
    for (let elapsedSec = 0; elapsedSec < 80; elapsedSec++) {
      drones = applyCommsModel(drones, elapsedSec, scenario, severe)
    }
    const afterEighty = applyCommsModel([makeDrone(-55)], 0, scenario, severe)[0]

    // Bounded: 80 ticks of severe weather is the same attenuation as one tick of it.
    expect(drones[0].signalDbm).toBe(afterEighty.signalDbm)
    // And weather is still a real penalty — never a no-op.
    const clearSignal = applyCommsModel([makeDrone(-55)], 0, scenario, clear)[0].signalDbm
    expect(afterEighty.signalDbm).toBeLessThanOrEqual(clearSignal)
  })

  it('a blackout window is an impairment, not an override', () => {
    const weather = buildWeatherState(getWeatherProfile('urban'), CLEAR_URBAN_VARIANT)
    const scenario = makeScenario([{ startSec: 8, durationSec: 15 }])
    const during = applyCommsModel([makeDrone(-55)], 10, scenario, weather)[0]
    const outside = applyCommsModel([makeDrone(-55)], 40, scenario, weather)[0]

    // It costs real dB...
    expect(during.linkMarginDb!).toBeLessThan(outside.linkMarginDb!)
    // ...but an aircraft sitting on the operator's head rides it out rather than being forced
    // down by a timer. That is the WP-8 change: placement decides, not the script.
    expect(during.bvlosFlag).toBe(false)
  })

})
