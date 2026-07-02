import { describe, it, expect } from 'vitest'
import { buildWeatherState } from '@/sim/weather/weatherEngine'
import { SCENARIO_OPTIONS } from '@/scenarios/catalog'
import type { ScenarioVariantConfig } from '@/types'

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

describe('scenarioVariant', () => {
  it('every scenario config has a weatherProfile after catalog enhancement', () => {
    for (const opt of SCENARIO_OPTIONS) {
      expect(opt.config.weatherProfile).toBeDefined()
      expect(opt.config.weatherProfile!.locationTag).toBeTruthy()
    }
  })

  it('buildWeatherState is deterministic for the same scenario + seed', () => {
    const opt = SCENARIO_OPTIONS[0]
    const profile = opt.config.weatherProfile!
    const a = buildWeatherState(profile, BASE_VARIANT)
    const b = buildWeatherState(profile, BASE_VARIANT)
    expect(a.windKts).toBe(b.windKts)
    expect(a.gustKts).toBe(b.gustKts)
    expect(a.batteryDrainMultiplier).toBe(b.batteryDrainMultiplier)
    expect(a.activeHazards).toEqual(b.activeHazards)
  })

  it('different seeds produce different weather states across a seed range', () => {
    const opt = SCENARIO_OPTIONS[0]
    const profile = opt.config.weatherProfile!
    const results = new Set<string>()
    for (let seed = 1; seed <= 15; seed++) {
      const ws = buildWeatherState(profile, { ...BASE_VARIANT, seed, weatherSeverity: 2 })
      results.add(`${ws.windKts}:${ws.batteryDrainMultiplier}`)
    }
    expect(results.size).toBeGreaterThanOrEqual(2)
  })

  it('coastal scenario profiles have marine_layer or fog in possibleHazards', () => {
    const coastal = SCENARIO_OPTIONS.find(
      (s) => s.config.weatherProfile?.locationTag === 'coastal'
    )
    expect(coastal).toBeDefined()
    const hazards = coastal!.config.weatherProfile!.possibleHazards
    expect(hazards.some((h) => h === 'marine_layer' || h === 'fog')).toBe(true)
  })

  it('wildfire scenario profile has smoke in possibleHazards', () => {
    const wildfire = SCENARIO_OPTIONS.find(
      (s) => s.config.weatherProfile?.locationTag === 'wildfire'
    )
    if (!wildfire) return // scenario may not be present in all builds
    const hazards = wildfire.config.weatherProfile!.possibleHazards
    expect(hazards).toContain('smoke')
  })

  it('weatherSeverity 3 produces worse multipliers than 0 for any scenario', () => {
    for (const opt of SCENARIO_OPTIONS.slice(0, 3)) {
      const profile = opt.config.weatherProfile!
      const clear   = buildWeatherState(profile, { ...BASE_VARIANT, weatherSeverity: 0 })
      const severe  = buildWeatherState(profile, { ...BASE_VARIANT, weatherSeverity: 3 })
      // batteryDrain should be >= for severe, speedCap should be <=
      expect(severe.batteryDrainMultiplier).toBeGreaterThanOrEqual(clear.batteryDrainMultiplier)
      expect(severe.speedCapMultiplier).toBeLessThanOrEqual(clear.speedCapMultiplier)
    }
  })

  it('ScenarioVariantConfig seed range 0..0xFFFFFF is valid', () => {
    const opt = SCENARIO_OPTIONS[0]
    const profile = opt.config.weatherProfile!
    for (const seed of [0, 1, 0x7fffff, 0xffffff]) {
      const ws = buildWeatherState(profile, { ...BASE_VARIANT, seed })
      expect(ws.batteryDrainMultiplier).toBeGreaterThanOrEqual(1.0)
    }
  })
})
