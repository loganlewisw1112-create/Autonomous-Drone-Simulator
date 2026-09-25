import { platformForDrone, type DronePlatformSpec } from '@/sim/drone/platformCatalog'
import { PLATFORM_SOURCES, type SourcedField } from '@/sim/drone/platformSources'
import { droneIdForIndex } from '@/sim/mission/routeAudit'
import { lowAltitudeDryden } from '@/sim/weather/dryden'
import type { ScenarioConfig, WeatherVariantState } from '@/types'

/**
 * Preflight advisories: the forecast against each assigned airframe's limits.
 *
 * Advisory only — nothing here blocks a launch. The gust check is the comparison the live loop
 * aborts on (`exceedsGustLimit`: sustained wind + Dryden gust sample > gust tolerance), evaluated
 * at a 3σ gust, which a correlated gust series reaches many times over a sortie. The sustained-wind
 * and temperature checks cover limits the model does not enforce in flight. Each limit is labelled
 * as published or modelled from platformSources.ts; unpublished temperature envelopes are skipped.
 * (This module is only reached from the lazily loaded preflight modal, so the provenance table
 * stays off the startup bundle.)
 */

const KTS_TO_MS = 0.514444
/** Gusts are evaluated where the fleet tasks and returns (RTB legs fly at 120 ft). */
const GUST_ALTITUDE_FT = 120
const GUST_SIGMAS = 3

export type EnvelopeAdvisoryKind = 'wind' | 'gust' | 'temperature_high' | 'temperature_low'

export interface EnvelopeAdvisory {
  kind: EnvelopeAdvisoryKind
  platformId: DronePlatformSpec['id']
  shortName: string
  droneIds: string[]
  /** Forecast value compared and the airframe's limit, in the units of `unit`. */
  forecast: number
  limit: number
  unit: 'm/s' | '°C'
  /** Whether the manufacturer publishes the limit or the model supplies it. */
  limitSource: 'published' | 'modelled'
  message: string
}

type EnvelopeWeather = Pick<WeatherVariantState, 'windKts' | 'gustKts' | 'tempF'>

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function limitSource(platform: DronePlatformSpec, field: SourcedField): 'published' | 'modelled' {
  if (platform.id === 'legacy') return 'modelled'
  return PLATFORM_SOURCES[platform.id][field].kind === 'published' ? 'published' : 'modelled'
}

function limitLabel(source: 'published' | 'modelled', published: string, modelled: string): string {
  return source === 'published' ? published : modelled
}

export function airframeEnvelopeAdvisories(
  scenario: ScenarioConfig | null | undefined,
  weather: EnvelopeWeather | null | undefined,
): EnvelopeAdvisory[] {
  if (!scenario || !weather) return []
  const byPlatform = new Map<DronePlatformSpec['id'], { platform: DronePlatformSpec; ids: string[] }>()
  for (let index = 0; index < scenario.droneCount; index += 1) {
    const id = droneIdForIndex(index)
    const platform = platformForDrone(scenario, id)
    // The generic airframe has no manufacturer envelope to compare against.
    if (platform.id === 'legacy') continue
    const entry = byPlatform.get(platform.id) ?? { platform, ids: [] }
    entry.ids.push(id)
    byPlatform.set(platform.id, entry)
  }

  const windMs = weather.windKts * KTS_TO_MS
  const gustSigmaMs = lowAltitudeDryden(weather.gustKts * KTS_TO_MS, GUST_ALTITUDE_FT).sigmaMs
  const gustLoadMs = windMs + GUST_SIGMAS * gustSigmaMs
  const tempC = (weather.tempF - 32) * 5 / 9
  const advisories: EnvelopeAdvisory[] = []
  for (const { platform, ids } of byPlatform.values()) {
    const base = { platformId: platform.id, shortName: platform.shortName, droneIds: ids }
    if (windMs > platform.windToleranceMs) {
      const source = limitSource(platform, 'windToleranceMs')
      advisories.push({
        ...base, kind: 'wind', forecast: round1(windMs), limit: platform.windToleranceMs, unit: 'm/s', limitSource: source,
        message: `${platform.shortName}: forecast wind ${round1(windMs)} m/s exceeds its ${platform.windToleranceMs} m/s ${limitLabel(source, 'published wind rating', 'model wind limit (none published)')} — battery burn rises with the wind load.`,
      })
    }
    if (gustLoadMs > platform.gustToleranceMs) {
      const source = limitSource(platform, 'gustToleranceMs')
      advisories.push({
        ...base, kind: 'gust', forecast: round1(gustLoadMs), limit: platform.gustToleranceMs, unit: 'm/s', limitSource: source,
        message: `${platform.shortName}: wind ${round1(windMs)} m/s plus gusts (σ ${round1(gustSigmaMs)} m/s at ${GUST_ALTITUDE_FT} ft) can reach ${round1(gustLoadMs)} m/s, past its ${platform.gustToleranceMs} m/s ${limitLabel(source, 'published gust limit', 'model gust limit (none published)')} — the sortie aborts whenever wind plus gust passes it.`,
      })
    }
    const envelope = platform.operatingTempC
    if (envelope && tempC > envelope.max) {
      advisories.push({
        ...base, kind: 'temperature_high', forecast: round1(tempC), limit: envelope.max, unit: '°C', limitSource: 'published',
        message: `${platform.shortName}: forecast ${round1(tempC)} °C is above its published ${envelope.max} °C operating limit.`,
      })
    }
    if (envelope && tempC < envelope.min) {
      advisories.push({
        ...base, kind: 'temperature_low', forecast: round1(tempC), limit: envelope.min, unit: '°C', limitSource: 'published',
        message: `${platform.shortName}: forecast ${round1(tempC)} °C is below its published ${envelope.min} °C operating limit.`,
      })
    }
  }
  return advisories
}
