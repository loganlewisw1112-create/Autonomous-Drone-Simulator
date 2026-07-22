import { describe, it, expect } from 'vitest'
import {
  buildWeatherState,
  getDefaultWeatherState,
  applyWeatherToCommsSignal,
  weatherSummaryLabel,
} from '@/sim/weather/weatherEngine'
import type { ScenarioWeatherProfile, ScenarioVariantConfig } from '@/types'

const COASTAL_PROFILE: ScenarioWeatherProfile = {
  locationTag: 'coastal',
  baseConditions: { windKts: 12, gustKts: 18, visibilityMi: 8, ceilingFt: 3000, tempF: 60 },
  possibleHazards: ['fog', 'marine_layer', 'rf_shadow'],
}

const WILDFIRE_PROFILE: ScenarioWeatherProfile = {
  locationTag: 'wildfire',
  baseConditions: { windKts: 15, gustKts: 25, visibilityMi: 2, ceilingFt: 1500, tempF: 90 },
  possibleHazards: ['smoke', 'heat', 'thermal_updraft'],
}

const BASE_VARIANT: ScenarioVariantConfig = {
  seed: 42,
  timeOfDay: 'day',
  season: 'spring',
  weatherSeverity: 0,
  commsDegradation: 0,
  thermalDensity: 1,
  batteryPressure: 0,
  terrainDifficulty: 0,
}

describe('weatherEngine', () => {
  it('getDefaultWeatherState returns all multipliers at 1.0', () => {
    const ws = getDefaultWeatherState(1337)
    expect(ws.batteryDrainMultiplier).toBe(1.0)
    expect(ws.speedCapMultiplier).toBe(1.0)
    expect(ws.sensorConfidenceFactor).toBe(1.0)
    expect(ws.commsReliabilityFactor).toBe(1.0)
    expect(ws.groundUnitEtaMultiplier).toBe(1.0)
    expect(ws.activeHazards).toHaveLength(0)
  })

  it('buildWeatherState is deterministic for the same seed', () => {
    const a = buildWeatherState(COASTAL_PROFILE, BASE_VARIANT)
    const b = buildWeatherState(COASTAL_PROFILE, BASE_VARIANT)
    expect(a.windKts).toBe(b.windKts)
    expect(a.activeHazards).toEqual(b.activeHazards)
    expect(a.batteryDrainMultiplier).toBe(b.batteryDrainMultiplier)
  })

  it('observed weather (WP-2) drives the baseline; omitting it is bit-identical', () => {
    const observed = { windKts: 59.2, gustKts: 110.8, tempF: 77 } // real Hurricane Ian ERA5 peak
    const withObs = buildWeatherState(COASTAL_PROFILE, BASE_VARIANT, observed)
    const without = buildWeatherState(COASTAL_PROFILE, BASE_VARIANT)
    // severity 0 → no perturbation → the observed baseline shows through
    expect(withObs.windKts).toBeCloseTo(59.2, 1)
    expect(withObs.gustKts).toBeCloseTo(110.8, 1)
    expect(withObs.tempF).toBe(77)
    // no fixture → the profile baseline, unchanged from prior behaviour
    expect(without.windKts).toBe(12)
    expect(without).toEqual(buildWeatherState(COASTAL_PROFILE, BASE_VARIANT))
  })

  it('different seeds produce different states across a range', () => {
    const results = new Set<string>()
    for (let seed = 1; seed <= 20; seed++) {
      const ws = buildWeatherState(WILDFIRE_PROFILE, { ...BASE_VARIANT, seed, weatherSeverity: 2 })
      results.add(`${ws.windKts}:${ws.gustKts}:${JSON.stringify(ws.activeHazards)}`)
    }
    expect(results.size).toBeGreaterThanOrEqual(2)
  })

  it('severity 0 produces lower batteryDrainMultiplier than severity 3', () => {
    const clear  = buildWeatherState(COASTAL_PROFILE, { ...BASE_VARIANT, weatherSeverity: 0 })
    const severe = buildWeatherState(COASTAL_PROFILE, { ...BASE_VARIANT, weatherSeverity: 3 })
    expect(clear.batteryDrainMultiplier).toBeLessThanOrEqual(severe.batteryDrainMultiplier)
    expect(clear.speedCapMultiplier).toBeGreaterThanOrEqual(severe.speedCapMultiplier)
    expect(clear.sensorConfidenceFactor).toBeGreaterThanOrEqual(severe.sensorConfidenceFactor)
  })

  it('severity 3 (severe) degrades all multipliers', () => {
    const ws = buildWeatherState(WILDFIRE_PROFILE, { ...BASE_VARIANT, weatherSeverity: 3, seed: 1 })
    expect(ws.batteryDrainMultiplier).toBeGreaterThan(1.0)
    expect(ws.speedCapMultiplier).toBeLessThan(1.0)
    expect(ws.sensorConfidenceFactor).toBeLessThan(1.0)
    expect(ws.commsReliabilityFactor).toBeLessThanOrEqual(1.0)
  })

  it('all multipliers stay within valid bounds', () => {
    for (const sev of [0, 1, 2, 3] as const) {
      const ws = buildWeatherState(COASTAL_PROFILE, { ...BASE_VARIANT, weatherSeverity: sev })
      expect(ws.batteryDrainMultiplier).toBeGreaterThanOrEqual(1.0)
      expect(ws.batteryDrainMultiplier).toBeLessThanOrEqual(2.5)
      expect(ws.speedCapMultiplier).toBeGreaterThan(0)
      expect(ws.speedCapMultiplier).toBeLessThanOrEqual(1.0)
      expect(ws.sensorConfidenceFactor).toBeGreaterThan(0)
      expect(ws.sensorConfidenceFactor).toBeLessThanOrEqual(1.0)
      expect(ws.commsReliabilityFactor).toBeGreaterThan(0)
      expect(ws.commsReliabilityFactor).toBeLessThanOrEqual(1.0)
      expect(ws.groundUnitEtaMultiplier).toBeGreaterThanOrEqual(1.0)
    }
  })

  it('wildfire profile hazards include smoke or heat at high severity', () => {
    let foundHazard = false
    for (let seed = 1; seed <= 20; seed++) {
      const ws = buildWeatherState(WILDFIRE_PROFILE, { ...BASE_VARIANT, seed, weatherSeverity: 2 })
      if (ws.activeHazards.some((h) => h === 'smoke' || h === 'heat' || h === 'thermal_updraft')) {
        foundHazard = true
        break
      }
    }
    expect(foundHazard).toBe(true)
  })

  it('applyWeatherToCommsSignal degrades signal when commsReliabilityFactor < 1', () => {
    const ws = buildWeatherState(COASTAL_PROFILE, { ...BASE_VARIANT, weatherSeverity: 3, seed: 5 })
    ws.commsReliabilityFactor = 0.7
    const base = -70
    const degraded = applyWeatherToCommsSignal(base, ws)
    expect(degraded).toBeLessThan(base)
  })

  it('applyWeatherToCommsSignal is a no-op when commsReliabilityFactor is 1.0', () => {
    const ws = getDefaultWeatherState(1)
    const base = -70
    expect(applyWeatherToCommsSignal(base, ws)).toBe(base)
  })

  it('weatherSummaryLabel returns a non-empty string for any state', () => {
    const ws = buildWeatherState(COASTAL_PROFILE, BASE_VARIANT)
    const label = weatherSummaryLabel(ws)
    expect(typeof label).toBe('string')
    expect(label.length).toBeGreaterThan(0)
  })

  it('launchBayAvailability is a record (may be empty for clear weather)', () => {
    const ws = buildWeatherState(COASTAL_PROFILE, { ...BASE_VARIANT, weatherSeverity: 0 })
    expect(typeof ws.launchBayAvailability).toBe('object')
  })
})
