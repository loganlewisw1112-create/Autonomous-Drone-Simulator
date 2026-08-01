import type { ObservedWeather } from '@/types'
import dixie from './fixtures/extreme_cal_fire_dixie/weather.json'
import oceanBeach from './fixtures/demo_sar_coastal/weather.json'
import capeCod from './fixtures/extreme_uscg_cape_cod_sar/weather.json'
import skidRow from './fixtures/extreme_lapd_skid_row_welfare/weather.json'
import portLa from './fixtures/extreme_dhs_port_la_chemical/weather.json'
import fortMyers from './fixtures/extreme_fema_fort_myers/weather.json'
import oceanBeachManifest from './fixtures/demo_sar_coastal/manifest.json'
import capeCodManifest from './fixtures/extreme_uscg_cape_cod_sar/manifest.json'
import skidRowManifest from './fixtures/extreme_lapd_skid_row_welfare/manifest.json'
import dixieManifest from './fixtures/extreme_cal_fire_dixie/manifest.json'
import portLaManifest from './fixtures/extreme_dhs_port_la_chemical/manifest.json'
import fortMyersManifest from './fixtures/extreme_fema_fort_myers/manifest.json'

// Real observed-weather baselines frozen by tools/fixtures/ (REALISM_ROADMAP WP-0/WP-2).
// Phase 5 remaps renamed/refreshed scenario ids to existing fixture files; new historical
// entries alias to the closest committed fixture until Phase 6 fetches dedicated AO weather.
type WeatherFixture = Omit<ObservedWeather, 'provenance'>
type WeatherManifest = { scenarioId: string; realDate: string; area: { lat: number; lng: number }; sources: Array<{ source: string }> }

function withProvenance(
  weather: WeatherFixture,
  manifest: WeatherManifest,
  proxyForScenarioId?: string,
): ObservedWeather {
  return {
    ...weather,
    provenance: {
      source: manifest.sources.find((entry) => entry.source.includes('ERA5'))?.source ?? 'Recorded weather fixture',
      sourceScenarioId: manifest.scenarioId,
      observedDate: manifest.realDate,
      sourceLocation: { lat: manifest.area.lat, lng: manifest.area.lng },
      ...(proxyForScenarioId ? { proxyForScenarioId } : {}),
      isProxy: Boolean(proxyForScenarioId),
    },
  }
}

const OBSERVED: Record<string, ObservedWeather> = {
  demo_sar_coastal: withProvenance(oceanBeach, oceanBeachManifest),
  train_uscg_maritime_sar: withProvenance(capeCod, capeCodManifest),
  train_hazmat_plume: withProvenance(portLa, portLaManifest),
  train_welfare_grid: withProvenance(skidRow, skidRowManifest),
  train_wildfire_flank: withProvenance(dixie, dixieManifest),
  hist_harvey_houston_2017: withProvenance(oceanBeach, oceanBeachManifest, 'hist_harvey_houston_2017'),
  hist_marshall_fire_2021: withProvenance(fortMyers, fortMyersManifest, 'hist_marshall_fire_2021'),
  hist_camp_fire_paradise_2018: withProvenance(dixie, dixieManifest, 'hist_camp_fire_paradise_2018'),
  hist_kilauea_leilani_2018: withProvenance(oceanBeach, oceanBeachManifest, 'hist_kilauea_leilani_2018'),
  hist_oso_sr530_2014: withProvenance(oceanBeach, oceanBeachManifest, 'hist_oso_sr530_2014'),
  hist_surfside_cts_2021: withProvenance(oceanBeach, oceanBeachManifest, 'hist_surfside_cts_2021'),
  hist_helene_asheville_2024: withProvenance(dixie, dixieManifest, 'hist_helene_asheville_2024'),
  hist_katrina_lower_ninth_2005: withProvenance(oceanBeach, oceanBeachManifest, 'hist_katrina_lower_ninth_2005'),
  hist_joplin_ef5_2011: withProvenance(dixie, dixieManifest, 'hist_joplin_ef5_2011'),
  hist_east_palestine_2023: withProvenance(portLa, portLaManifest, 'hist_east_palestine_2023'),
}

/** The frozen observed-weather baseline for a scenario, or undefined when none is sourced. */
export function observedWeatherFor(scenarioId: string): ObservedWeather | undefined {
  return OBSERVED[scenarioId]
}
