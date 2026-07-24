import type { ObservedWeather } from '@/types'
import dixie from './fixtures/extreme_cal_fire_dixie/weather.json'
import oceanBeach from './fixtures/demo_sar_coastal/weather.json'
import capeCod from './fixtures/extreme_uscg_cape_cod_sar/weather.json'
import skidRow from './fixtures/extreme_lapd_skid_row_welfare/weather.json'
import portLa from './fixtures/extreme_dhs_port_la_chemical/weather.json'
import fortMyers from './fixtures/extreme_fema_fort_myers/weather.json'

// Real observed-weather baselines frozen by tools/fixtures/ (REALISM_ROADMAP WP-0/WP-2).
// Phase 5 remaps renamed/refreshed scenario ids to existing fixture files; new historical
// entries alias to the closest committed fixture until Phase 6 fetches dedicated AO weather.
const OBSERVED: Record<string, ObservedWeather> = {
  demo_sar_coastal: oceanBeach,
  train_uscg_maritime_sar: capeCod,
  train_hazmat_plume: portLa,
  train_welfare_grid: skidRow,
  train_wildfire_flank: dixie,
  hist_harvey_houston_2017: oceanBeach,
  hist_marshall_fire_2021: fortMyers,
  hist_camp_fire_paradise_2018: dixie,
  hist_kilauea_leilani_2018: oceanBeach,
  hist_oso_sr530_2014: oceanBeach,
  hist_surfside_cts_2021: oceanBeach,
  hist_helene_asheville_2024: dixie,
  hist_katrina_lower_ninth_2005: oceanBeach,
  hist_joplin_ef5_2011: dixie,
  hist_east_palestine_2023: portLa,
}

/** The frozen observed-weather baseline for a scenario, or undefined when none is sourced. */
export function observedWeatherFor(scenarioId: string): ObservedWeather | undefined {
  return OBSERVED[scenarioId]
}
