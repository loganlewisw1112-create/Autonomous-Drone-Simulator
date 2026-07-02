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

  it('recovers urban signal to the weather ceiling outside blackout windows', () => {
    const weather = { ...buildWeatherState(getWeatherProfile('urban'), CLEAR_URBAN_VARIANT), commsReliabilityFactor: 1 }
    let drones = [makeDrone(-55)]

    for (let elapsedSec = 0; elapsedSec < 40; elapsedSec++) {
      drones = applyCommsModel(drones, elapsedSec, makeScenario(), weather)
    }

    expect(drones[0].signalDbm).toBe(-45)
    expect(drones[0].bvlosFlag).toBe(false)
  })

  it('caps urban weather degradation instead of compounding it every tick', () => {
    const weather = buildWeatherState(getWeatherProfile('urban'), URBAN_VARIANT)
    let drones = [makeDrone(-55)]

    for (let elapsedSec = 0; elapsedSec < 80; elapsedSec++) {
      drones = applyCommsModel(drones, elapsedSec, makeScenario(), weather)
    }

    expect(drones[0].signalDbm).toBeGreaterThanOrEqual(-45.75)
    expect(drones[0].signalDbm).toBeLessThanOrEqual(-45)
  })

  it('still honors configured urban blackout windows', () => {
    const weather = buildWeatherState(getWeatherProfile('urban'), CLEAR_URBAN_VARIANT)
    const drones = applyCommsModel(
      [makeDrone(-55)],
      10,
      makeScenario([{ startSec: 8, durationSec: 15 }]),
      weather,
    )

    expect(drones[0].signalDbm).toBeLessThan(-55)
  })
})
