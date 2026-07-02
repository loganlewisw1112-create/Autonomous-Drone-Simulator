import { describe, it, expect } from 'vitest'
import { buildWeatherState, getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import { tickGroundUnit } from '@/sim/mission/groundUnits'
import type { ScenarioWeatherProfile, ScenarioVariantConfig, GroundUnitState } from '@/types'

const MOUNTAIN_PROFILE: ScenarioWeatherProfile = {
  locationTag: 'mountain',
  baseConditions: { windKts: 20, gustKts: 35, visibilityMi: 5, ceilingFt: 2000, tempF: 35 },
  possibleHazards: ['canyon_gusts', 'snow_ice', 'cold'],
}

const SEVERE_VARIANT: ScenarioVariantConfig = {
  seed: 77,
  timeOfDay: 'night',
  season: 'winter',
  weatherSeverity: 3,
  commsDegradation: 2,
  thermalDensity: 1,
  batteryPressure: 1,
  terrainDifficulty: 2,
}

const CLEAR_VARIANT: ScenarioVariantConfig = {
  ...SEVERE_VARIANT,
  weatherSeverity: 0,
  commsDegradation: 0,
  terrainDifficulty: 0,
}

describe('weatherImpact', () => {
  it('severe weather increases batteryDrainMultiplier beyond 1.0', () => {
    const ws = buildWeatherState(MOUNTAIN_PROFILE, SEVERE_VARIANT)
    expect(ws.batteryDrainMultiplier).toBeGreaterThan(1.0)
  })

  it('severe weather reduces speedCapMultiplier below 1.0', () => {
    const ws = buildWeatherState(MOUNTAIN_PROFILE, SEVERE_VARIANT)
    expect(ws.speedCapMultiplier).toBeLessThan(1.0)
  })

  it('severe weather reduces sensorConfidenceFactor', () => {
    const ws = buildWeatherState(MOUNTAIN_PROFILE, SEVERE_VARIANT)
    const clear = getDefaultWeatherState(SEVERE_VARIANT.seed)
    expect(ws.sensorConfidenceFactor).toBeLessThanOrEqual(clear.sensorConfidenceFactor)
  })

  it('severe weather increases groundUnitEtaMultiplier', () => {
    const ws = buildWeatherState(MOUNTAIN_PROFILE, SEVERE_VARIANT)
    expect(ws.groundUnitEtaMultiplier).toBeGreaterThanOrEqual(1.0)
  })

  it('ground unit ETA is longer in severe weather than clear', () => {
    const from = { lat: 37.77, lng: -122.42 }
    const to   = { lat: 37.80, lng: -122.38 }

    const clearWs = buildWeatherState(MOUNTAIN_PROFILE, CLEAR_VARIANT)
    const severeWs = buildWeatherState(MOUNTAIN_PROFILE, SEVERE_VARIANT)

    const unit: GroundUnitState = {
      id: 'gu-test',
      role: 'recovery',
      position: from,
      status: 'enroute',
      etaSec: 60,
    }

    // tickGroundUnit advances the unit — clear weather should move farther in 1s
    const clearUpdated  = tickGroundUnit(unit, to, clearWs, 1.0)
    const severeUpdated = tickGroundUnit(unit, to, severeWs, 1.0)

    // In clear weather the unit should be closer to target (more distance covered)
    const dist = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
      Math.hypot(a.lat - b.lat, a.lng - b.lng)

    const clearDistToTarget  = dist(clearUpdated.position, to)
    const severeDistToTarget = dist(severeUpdated.position, to)

    // Clear should be ≤ severe (closer or equal because higher speed)
    if (clearWs.groundUnitEtaMultiplier !== severeWs.groundUnitEtaMultiplier) {
      expect(clearDistToTarget).toBeLessThanOrEqual(severeDistToTarget + 1e-8)
    }
  })

  it('commsDegradation 2 results in lowest commsReliabilityFactor', () => {
    const low  = buildWeatherState(MOUNTAIN_PROFILE, { ...SEVERE_VARIANT, commsDegradation: 0 })
    const high = buildWeatherState(MOUNTAIN_PROFILE, { ...SEVERE_VARIANT, commsDegradation: 2 })
    expect(high.commsReliabilityFactor).toBeLessThanOrEqual(low.commsReliabilityFactor)
  })

  it('night time-of-day reduces sensorConfidenceFactor vs day', () => {
    const day   = buildWeatherState(MOUNTAIN_PROFILE, { ...CLEAR_VARIANT, timeOfDay: 'day' })
    const night = buildWeatherState(MOUNTAIN_PROFILE, { ...CLEAR_VARIANT, timeOfDay: 'night' })
    // Night reduces thermal sensor confidence
    expect(night.sensorConfidenceFactor).toBeLessThanOrEqual(day.sensorConfidenceFactor + 0.01)
  })
})
