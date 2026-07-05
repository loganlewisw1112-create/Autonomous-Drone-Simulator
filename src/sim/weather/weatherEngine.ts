import { mulberry32 } from '@/utils/rng'
import type {
  ScenarioWeatherProfile,
  WeatherVariantState,
  ScenarioVariantConfig,
  WeatherHazard,
  WeatherLocationTag,
} from '@/types'

// ─── Default profiles per location tag ────────────────────────────────────────

const PROFILES: Record<WeatherLocationTag, ScenarioWeatherProfile> = {
  coastal: {
    locationTag: 'coastal',
    baseConditions: { windKts: 12, gustKts: 20, visibilityMi: 8, ceilingFt: 2500, tempF: 62 },
    possibleHazards: ['fog', 'marine_layer', 'rain', 'cold'],
  },
  urban: {
    locationTag: 'urban',
    baseConditions: { windKts: 8, gustKts: 14, visibilityMi: 10, ceilingFt: 3000, tempF: 68 },
    // rf_shadow omitted — dense 4G/5G/LTE infrastructure in cities means redundant signal paths;
    // individual building shadows don't cause comms loss the way remote terrain does.
    possibleHazards: ['canyon_gusts', 'rain', 'fog'],
  },
  wildfire: {
    locationTag: 'wildfire',
    baseConditions: { windKts: 15, gustKts: 28, visibilityMi: 3, ceilingFt: 1500, tempF: 88 },
    possibleHazards: ['smoke', 'heat', 'thermal_updraft', 'dust'],
  },
  mountain: {
    locationTag: 'mountain',
    baseConditions: { windKts: 18, gustKts: 32, visibilityMi: 6, ceilingFt: 2000, tempF: 45 },
    possibleHazards: ['cold', 'snow_ice', 'fog', 'thermal_updraft'],
  },
  desert_border: {
    locationTag: 'desert_border',
    baseConditions: { windKts: 10, gustKts: 22, visibilityMi: 12, ceilingFt: 5000, tempF: 95 },
    possibleHazards: ['heat', 'dust', 'thermal_updraft', 'rf_shadow'],
  },
  generic: {
    locationTag: 'generic',
    baseConditions: { windKts: 5, gustKts: 10, visibilityMi: 10, ceilingFt: 3000, tempF: 68 },
    possibleHazards: ['rain', 'fog'],
  },
}

export function getWeatherProfile(locationTag: WeatherLocationTag): ScenarioWeatherProfile {
  return PROFILES[locationTag]
}

/** Build a deterministic WeatherVariantState from a profile + variant config. */
export function buildWeatherState(
  profile: ScenarioWeatherProfile,
  variant: ScenarioVariantConfig,
): WeatherVariantState {
  const rng = mulberry32(variant.seed ^ 0xdeadbeef)

  // Select hazards based on severity. Seeded Fisher–Yates — sort(() => rng() - 0.5) is a
  // well-known biased-shuffle antipattern (comparator isn't a valid total order).
  const pool = profile.possibleHazards
  const hazardCount = Math.min(pool.length, variant.weatherSeverity)
  const shuffled = [...pool]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  const activeHazards: WeatherHazard[] = shuffled.slice(0, hazardCount)

  const base = profile.baseConditions
  const sev = variant.weatherSeverity / 3  // 0–1 normalised

  const windKts    = base.windKts    * (1 + sev * 0.8 * rng())
  const gustKts    = base.gustKts    * (1 + sev * 1.0 * rng())
  const visibilityMi = Math.max(0.25, base.visibilityMi - sev * 4 * rng())
  const ceilingFt  = Math.max(100, base.ceilingFt - sev * 800 * rng())

  let tempF = base.tempF
  if (variant.season === 'winter') tempF -= 20 + rng() * 10
  if (variant.season === 'summer') tempF += 10 + rng() * 10
  if (activeHazards.includes('heat'))  tempF += 20
  if (activeHazards.includes('cold'))  tempF -= 15

  const windFactor = Math.min(1, windKts / 25)
  const visFactor  = Math.min(1, visibilityMi / 3)

  const batteryDrainMultiplier = round2(
    1
    + windFactor * 0.4
    + (activeHazards.includes('cold') ? 0.15 : 0)
    + variant.batteryPressure * 0.1
  )

  const speedCapMultiplier = round2(Math.max(0.4, 1 - windFactor * 0.5))

  const hoverStabilityFactor = round2(
    Math.max(0.3,
      1
      - windFactor * 0.6
      - (activeHazards.includes('thermal_updraft') ? 0.2 : 0)
    )
  )

  const smokeFactor = activeHazards.includes('smoke') ? 0.4 : 0
  const fogFactor   = (activeHazards.includes('fog') || activeHazards.includes('marine_layer'))
    ? (1 - visFactor) * 0.5
    : 0
  const sensorConfidenceFactor = round2(Math.max(0.2, 1 - smokeFactor - fogFactor))

  const rfPenalty  = activeHazards.includes('rf_shadow') ? 0.2 : 0
  const isUrban    = profile.locationTag === 'urban'
  // Urban environments have dense LTE/5G infrastructure — reliability floor is higher
  // and rf_shadow is not in the urban hazard pool, but clamp just in case variant knobs push it down.
  const commsReliabilityFloor = isUrban ? 0.95 : 0.3
  const commsReliabilityFactor = round2(
    Math.max(commsReliabilityFloor,
      1
      - rfPenalty
      - windFactor * 0.1
      - variant.commsDegradation * 0.15
    )
  )
  // Signal ceiling: urban infrastructure keeps drones at stronger baseline (-45 dBm vs -55 dBm)
  const commsSignalCeilingDbm = isUrban ? -45 : -55

  const weatherEta = (activeHazards.includes('snow_ice') ? 0.5 : 0)
    + (activeHazards.includes('rain') ? 0.2 : 0)
  const groundUnitEtaMultiplier = round2(1 + variant.terrainDifficulty * 0.25 + weatherEta)

  // Close launch bays if gusts severe or ceiling too low
  const baysClosed = gustKts > 30 || ceilingFt < 200 || activeHazards.includes('snow_ice')
  const launchBayAvailability: Record<string, boolean> = {}
  for (let i = 0; i < 8; i++) launchBayAvailability[`bay-${i}`] = !baysClosed

  return {
    seed: variant.seed,
    activeHazards,
    windKts:    round1(windKts),
    gustKts:    round1(gustKts),
    visibilityMi: round2(visibilityMi),
    ceilingFt:  Math.round(ceilingFt),
    tempF:      Math.round(tempF),
    batteryDrainMultiplier,
    speedCapMultiplier,
    hoverStabilityFactor,
    sensorConfidenceFactor,
    commsReliabilityFactor,
    commsSignalCeilingDbm,
    launchBayAvailability,
    groundUnitEtaMultiplier,
  }
}

/** Clear-sky baseline weather — used before a variant is applied. */
export function getDefaultWeatherState(seed: number): WeatherVariantState {
  return {
    seed,
    activeHazards: [],
    windKts: 5,
    gustKts: 8,
    visibilityMi: 10,
    ceilingFt: 3000,
    tempF: 68,
    batteryDrainMultiplier: 1.0,
    speedCapMultiplier: 1.0,
    hoverStabilityFactor: 1.0,
    sensorConfidenceFactor: 1.0,
    commsReliabilityFactor: 1.0,
    commsSignalCeilingDbm: -55,
    launchBayAvailability: {},
    groundUnitEtaMultiplier: 1.0,
  }
}

/** Weather severity forces drones to divert to safe zone. */
export function isWeatherForceRtb(weather: WeatherVariantState): boolean {
  if (weather.gustKts >= 28) return true
  if (weather.visibilityMi < 1) return true
  if (weather.activeHazards.includes('snow_ice')) return true
  if (weather.activeHazards.includes('thermal_updraft') && weather.gustKts >= 20) return true
  return false
}

/** Additional signal penalty from weather comms degradation (dBm). */
export function applyWeatherToCommsSignal(signalDbm: number, weather: WeatherVariantState): number {
  const penalty = (1 - weather.commsReliabilityFactor) * 15
  return signalDbm - penalty
}

/** Summary label for display in UI. */
export function weatherSummaryLabel(weather: WeatherVariantState): string {
  if (weather.activeHazards.length === 0) return `Clear · ${weather.windKts}kt wind`
  const primary = weather.activeHazards[0].replace(/_/g, ' ')
  return `${primary.charAt(0).toUpperCase()}${primary.slice(1)} · ${weather.windKts}kt wind · vis ${weather.visibilityMi}mi`
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function round1(n: number): number { return Math.round(n * 10) / 10 }
function round2(n: number): number { return Math.round(n * 100) / 100 }
