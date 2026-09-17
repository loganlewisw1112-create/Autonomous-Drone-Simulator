import type { ObservedWeather } from '@/types'
import dixie from './fixtures/extreme_cal_fire_dixie/weather.json'
import oceanBeach from './fixtures/demo_sar_coastal/weather.json'
import capeCod from './fixtures/extreme_uscg_cape_cod_sar/weather.json'
import skidRow from './fixtures/extreme_lapd_skid_row_welfare/weather.json'
import portLa from './fixtures/extreme_dhs_port_la_chemical/weather.json'
import oceanBeachManifest from './fixtures/demo_sar_coastal/manifest.json'
import capeCodManifest from './fixtures/extreme_uscg_cape_cod_sar/manifest.json'
import skidRowManifest from './fixtures/extreme_lapd_skid_row_welfare/manifest.json'
import dixieManifest from './fixtures/extreme_cal_fire_dixie/manifest.json'
import portLaManifest from './fixtures/extreme_dhs_port_la_chemical/manifest.json'
// Dedicated real-weather baselines fetched per historical AO (REALISM_ROADMAP WP-2 "Phase 6").
// Each replaces an earlier proxy that borrowed an unrelated city's weather.
import harvey from './fixtures/hist_harvey_houston_2017/weather.json'
import harveyManifest from './fixtures/hist_harvey_houston_2017/manifest.json'
import marshall from './fixtures/hist_marshall_fire_2021/weather.json'
import marshallManifest from './fixtures/hist_marshall_fire_2021/manifest.json'
import campFire from './fixtures/hist_camp_fire_paradise_2018/weather.json'
import campFireManifest from './fixtures/hist_camp_fire_paradise_2018/manifest.json'
import kilauea from './fixtures/hist_kilauea_leilani_2018/weather.json'
import kilaueaManifest from './fixtures/hist_kilauea_leilani_2018/manifest.json'
import oso from './fixtures/hist_oso_sr530_2014/weather.json'
import osoManifest from './fixtures/hist_oso_sr530_2014/manifest.json'
import surfside from './fixtures/hist_surfside_cts_2021/weather.json'
import surfsideManifest from './fixtures/hist_surfside_cts_2021/manifest.json'
import helene from './fixtures/hist_helene_asheville_2024/weather.json'
import heleneManifest from './fixtures/hist_helene_asheville_2024/manifest.json'
import katrina from './fixtures/hist_katrina_lower_ninth_2005/weather.json'
import katrinaManifest from './fixtures/hist_katrina_lower_ninth_2005/manifest.json'
import joplin from './fixtures/hist_joplin_ef5_2011/weather.json'
import joplinManifest from './fixtures/hist_joplin_ef5_2011/manifest.json'
import eastPalestine from './fixtures/hist_east_palestine_2023/weather.json'
import eastPalestineManifest from './fixtures/hist_east_palestine_2023/manifest.json'
// WP-2 coverage pass: dedicated representative ERA5 baselines for the training incident
// scenarios that were still weather-less (seasonally appropriate real day at the real location).
import mountainSar from './fixtures/train_mountain_sar/weather.json'
import mountainSarManifest from './fixtures/train_mountain_sar/manifest.json'
import floodCorridor from './fixtures/train_flood_corridor/weather.json'
import floodCorridorManifest from './fixtures/train_flood_corridor/manifest.json'
import urbanUsar from './fixtures/train_urban_usar/weather.json'
import urbanUsarManifest from './fixtures/train_urban_usar/manifest.json'
import tornadoSector from './fixtures/train_tornado_sector/weather.json'
import tornadoSectorManifest from './fixtures/train_tornado_sector/manifest.json'
import nightRelay from './fixtures/train_night_relay_sar/weather.json'
import nightRelayManifest from './fixtures/train_night_relay_sar/manifest.json'
import infraInspection from './fixtures/train_infra_inspection/weather.json'
import infraInspectionManifest from './fixtures/train_infra_inspection/manifest.json'

// Real observed-weather baselines frozen by tools/fixtures/ (REALISM_ROADMAP WP-0/WP-2).
// Every historical AO now carries its own dedicated ERA5 baseline fetched for that place and
// date (WP-2 "Phase 6"); the earlier proxies that borrowed an unrelated city's weather are gone.
// The proxy mechanism (withProvenance's optional third arg) is retained for any future entry
// that must temporarily alias a committed fixture before its own is fetched.
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
  hist_harvey_houston_2017: withProvenance(harvey, harveyManifest),
  hist_marshall_fire_2021: withProvenance(marshall, marshallManifest),
  hist_camp_fire_paradise_2018: withProvenance(campFire, campFireManifest),
  hist_kilauea_leilani_2018: withProvenance(kilauea, kilaueaManifest),
  hist_oso_sr530_2014: withProvenance(oso, osoManifest),
  hist_surfside_cts_2021: withProvenance(surfside, surfsideManifest),
  hist_helene_asheville_2024: withProvenance(helene, heleneManifest),
  hist_katrina_lower_ninth_2005: withProvenance(katrina, katrinaManifest),
  hist_joplin_ef5_2011: withProvenance(joplin, joplinManifest),
  hist_east_palestine_2023: withProvenance(eastPalestine, eastPalestineManifest),
  train_mountain_sar: withProvenance(mountainSar, mountainSarManifest),
  train_flood_corridor: withProvenance(floodCorridor, floodCorridorManifest),
  train_urban_usar: withProvenance(urbanUsar, urbanUsarManifest),
  train_tornado_sector: withProvenance(tornadoSector, tornadoSectorManifest),
  train_night_relay_sar: withProvenance(nightRelay, nightRelayManifest),
  train_infra_inspection: withProvenance(infraInspection, infraInspectionManifest),
}

/** The frozen observed-weather baseline for a scenario, or undefined when none is sourced. */
export function observedWeatherFor(scenarioId: string): ObservedWeather | undefined {
  return OBSERVED[scenarioId]
}
