import { describe, expect, it } from 'vitest'
import { PLATFORM_CATALOG, LEGACY_PLATFORM, type PlatformId } from '@/sim/drone/platformCatalog'
import { PLATFORM_SOURCES, type SourcedField } from '@/sim/drone/platformSources'
import {
  batteryAlert,
  createDroneState,
  modelledDrainRatePerSec,
  stepDrone,
} from '@/sim/drone/DroneEntity'
import {
  planningEnvironment,
  plannedDrainRatePerSec,
  plannedLegEnergyPct,
  plannedSpeedMs,
} from '@/sim/mission/plannedEnergy'
import { airframeEnvelopeAdvisories } from '@/sim/mission/airframeEnvelope'
import { buildWeatherState, getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import type { DroneState, ScenarioConfig, ScenarioVariantConfig, ScenarioWeatherProfile } from '@/types'

const POS = { lat: 37.7695, lng: -122.4862 }
const FIELDS: SourcedField[] = [
  'massKg', 'maxSpeedMs', 'airframeMaxSpeedMs', 'climbRateFtS', 'descentRateFtS', 'turnRateDegS',
  'accelMs2', 'windToleranceMs', 'gustToleranceMs', 'enduranceMin', 'operatingTempC', 'ipRating', 'battery',
]

function scenarioWith(platforms: Record<string, PlatformId>, extra: Partial<ScenarioConfig> = {}): ScenarioConfig {
  return { droneCount: Object.keys(platforms).length, dronePlatforms: platforms, ...extra } as unknown as ScenarioConfig
}

describe('airframe figures are traceable', () => {
  it('every catalog figure has a provenance entry, and published ones carry a URL and quote', () => {
    for (const id of Object.keys(PLATFORM_CATALOG) as PlatformId[]) {
      for (const field of FIELDS) {
        const source = PLATFORM_SOURCES[id][field]
        expect(source, `${id}.${field}`).toBeDefined()
        if (source.kind === 'published') {
          expect(source.url, `${id}.${field}`).toMatch(/^https:\/\//)
          expect(source.quote.length, `${id}.${field}`).toBeGreaterThan(0)
        } else {
          expect(source.note.length, `${id}.${field}`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('a null figure is marked unpublished, never modelled or published', () => {
    for (const id of Object.keys(PLATFORM_CATALOG) as PlatformId[]) {
      const spec = PLATFORM_CATALOG[id]
      for (const field of ['descentRateFtS', 'operatingTempC', 'ipRating'] as const) {
        if (spec[field] === null) expect(PLATFORM_SOURCES[id][field].kind, `${id}.${field}`).toBe('unpublished')
        else expect(PLATFORM_SOURCES[id][field].kind, `${id}.${field}`).not.toBe('unpublished')
      }
    }
  })
})

describe('one energy model for flying and planning', () => {
  const scenario = scenarioWith({ 'uav-01': 'skydio_x10' })
  const weather = { tempF: 41, windKts: 14, gustKts: 22, batteryDrainMultiplier: 1.1, speedCapMultiplier: 0.8 }

  it('the planner prices a leg with exactly the rate the live model burns', () => {
    const speed = plannedSpeedMs(scenario, 'uav-01', weather)
    const live = modelledDrainRatePerSec(speed, PLATFORM_CATALOG.skydio_x10, planningEnvironment(scenario, 'uav-01', weather))
    expect(plannedDrainRatePerSec(scenario, 'uav-01', weather)).toBe(live)
    expect(plannedLegEnergyPct(scenario, 'uav-01', 1_000, weather)).toBeCloseTo(1_000 / speed * live, 10)
  })

  it('a cruise-throttle X10 leg now costs its modelled burn, not the flat scenario rate', () => {
    // 40 min rated → at cruise throttle in still 20 °C air the model gives ~29 min to empty.
    const still = scenarioWith({ 'uav-01': 'skydio_x10' })
    const minutesToEmpty = 100 / plannedDrainRatePerSec(still, 'uav-01') / 60
    expect(minutesToEmpty).toBeGreaterThan(25)
    expect(minutesToEmpty).toBeLessThan(40)
  })

  it('a battery kit scales rated endurance in both the planner and live drain', () => {
    const kit = scenarioWith({ 'uav-01': 'skydio_x10' }, {
      batteryProfile: { id: 'kit', label: 'Kit', capacityWh: 300, enduranceMultiplier: 2, reservePct: 25, notes: '' },
    } as Partial<ScenarioConfig>)
    const plain = scenarioWith({ 'uav-01': 'skydio_x10' })
    expect(plannedDrainRatePerSec(kit, 'uav-01')).toBeCloseTo(plannedDrainRatePerSec(plain, 'uav-01') / 2, 10)
    const drone = { ...createDroneState('uav-01', 'UAV-01', '#fff', POS, 120), missionState: 'navigate' as const }
    const env = { tempC: 20 }
    const plainStep = stepDrone(drone, { throttle: 0 }, 10, PLATFORM_CATALOG.skydio_x10, env)
    const kitStep = stepDrone(drone, { throttle: 0 }, 10, PLATFORM_CATALOG.skydio_x10, { ...env, enduranceScale: 2 })
    expect(100 - kitStep.batteryPct).toBeCloseTo((100 - plainStep.batteryPct) / 2, 10)
  })
})

describe('weather is charged to the pack once', () => {
  const PROFILE: ScenarioWeatherProfile = {
    locationTag: 'coastal',
    baseConditions: { windKts: 20, gustKts: 30, visibilityMi: 8, ceilingFt: 3000, tempF: 50 },
    possibleHazards: ['cold'],
  }
  const VARIANT: ScenarioVariantConfig = {
    seed: 3, timeOfDay: 'day', season: 'winter', weatherSeverity: 3,
    commsDegradation: 0, thermalDensity: 1, batteryPressure: 0, terrainDifficulty: 0,
  }

  it('the residual multiplier carries only the battery-pressure dial', () => {
    expect(buildWeatherState(PROFILE, VARIANT).batteryDrainMultiplier).toBe(1)
    expect(buildWeatherState(PROFILE, { ...VARIANT, batteryPressure: 2 }).batteryDrainMultiplier).toBe(1.2)
  })

  it('wind and cold still raise the modelled burn through the airframe', () => {
    const scenario = scenarioWith({ 'uav-01': 'skydio_x10d' })
    const harsh = buildWeatherState(PROFILE, VARIANT)
    expect(plannedDrainRatePerSec(scenario, 'uav-01', harsh))
      .toBeGreaterThan(plannedDrainRatePerSec(scenario, 'uav-01', getDefaultWeatherState(3)))
  })
})

describe('preflight airframe envelope advisories', () => {
  it('flags forecast heat above a published operating limit', () => {
    const scenario = scenarioWith({ 'uav-01': 'teal_2', 'uav-02': 'skydio_x10' })
    const advisories = airframeEnvelopeAdvisories(scenario, { windKts: 5, gustKts: 8, tempF: 113 }) // 45 °C
    const hot = advisories.filter((advisory) => advisory.kind === 'temperature_high')
    expect(hot.map((advisory) => advisory.platformId)).toEqual(['teal_2']) // 43.3 °C limit; X10 is rated to 45 °C
    expect(hot[0].droneIds).toEqual(['uav-01'])
  })

  it('flags wind above a wind limit and labels a modelled limit as modelled', () => {
    const scenario = scenarioWith({ 'uav-01': 'freefly_astro_max' })
    const advisories = airframeEnvelopeAdvisories(scenario, { windKts: 20, gustKts: 24, tempF: 60 })
    expect(advisories.map((a) => a.kind)).toEqual(['wind', 'gust'])
    // Freefly publishes no wind or gust figure for the Astro Max.
    expect(advisories.every((a) => a.limitSource === 'modelled')).toBe(true)
    expect(advisories[0].message).toContain('model wind limit (none published)')
  })

  it('checks gusts the way the live abort does: sustained wind plus the gust', () => {
    // X10 in 21 kt wind gusting 24 kt: both under their own limits taken alone (10.8 < 11.2 m/s
    // modelled wind, 12.3 < 12.8 m/s gust), but wind + a 3σ Dryden gust passes 12.8 — which is
    // the comparison exceedsGustLimit aborts on in flight.
    const scenario = scenarioWith({ 'uav-01': 'skydio_x10' })
    const gust = airframeEnvelopeAdvisories(scenario, { windKts: 21, gustKts: 24, tempF: 60 })
      .find((a) => a.kind === 'gust')
    expect(gust?.limitSource).toBe('published')
    expect(gust!.forecast).toBeGreaterThan(12.8)
  })

  it('is silent inside the envelope and for the generic airframe', () => {
    expect(airframeEnvelopeAdvisories(scenarioWith({ 'uav-01': 'skydio_x10' }), { windKts: 8, gustKts: 12, tempF: 68 })).toEqual([])
    expect(airframeEnvelopeAdvisories({ droneCount: 2 } as ScenarioConfig, { windKts: 60, gustKts: 80, tempF: 140 })).toEqual([])
  })
})

describe('battery warnings follow the autopilot gates', () => {
  const base = { ...createDroneState('uav-01', 'UAV-01', '#fff', POS, 120), missionState: 'navigate' } as DroneState

  it('a modelled pack warns at its voltage reserve, before the old 25% line', () => {
    expect(batteryAlert({ ...base, batteryPct: 45, cellVoltageV: 3.72 })).toBe('ok')
    expect(batteryAlert({ ...base, batteryPct: 33, cellVoltageV: 3.58 })).toBe('reserve')
    expect(batteryAlert({ ...base, batteryPct: 12, cellVoltageV: 3.25 })).toBe('critical')
  })

  it('a battery RTB flagged by the loop warns even above the voltage reserve', () => {
    // e.g. the energy-to-home gate sending a distant aircraft home at 45%.
    expect(batteryAlert({ ...base, batteryPct: 45, cellVoltageV: 3.72, batteryRtb: true })).toBe('reserve')
  })

  it('an unmodelled pack keeps the linear gates', () => {
    expect(batteryAlert({ ...base, batteryPct: 30 })).toBe('ok')
    expect(batteryAlert({ ...base, batteryPct: 20 })).toBe('reserve')
    expect(batteryAlert({ ...base, batteryPct: 5 })).toBe('critical')
  })

  it('leaves the legacy airframe free of published envelope data', () => {
    expect(LEGACY_PLATFORM.descentRateFtS).toBeNull()
    expect(LEGACY_PLATFORM.operatingTempC).toBeNull()
  })
})
