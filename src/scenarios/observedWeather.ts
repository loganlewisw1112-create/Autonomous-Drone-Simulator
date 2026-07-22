import type { ObservedWeather } from '@/types'
import fortMyers from './fixtures/extreme_fema_fort_myers/weather.json'
import dixie from './fixtures/extreme_cal_fire_dixie/weather.json'
import oceanBeach from './fixtures/demo_sar_coastal/weather.json'
import capeCod from './fixtures/extreme_uscg_cape_cod_sar/weather.json'
import bigBend from './fixtures/extreme_cbp_big_bend_desert_sar/weather.json'
import skidRow from './fixtures/extreme_lapd_skid_row_welfare/weather.json'
import timesSq from './fixtures/extreme_nypd_times_sq_mci/weather.json'
import hollywoodBowl from './fixtures/extreme_lapd_hollywood_bowl/weather.json'
import portLa from './fixtures/extreme_dhs_port_la_chemical/weather.json'
import oaklandStash from './fixtures/extreme_atf_oakland_stash/weather.json'
import usssSf from './fixtures/extreme_usss_presidential_sf/weather.json'
import sfPursuit from './fixtures/extreme_multiagency_sf_pursuit/weather.json'
import hrtCompound from './fixtures/extreme_fbi_hrt_compound/weather.json'
import eaglePass from './fixtures/extreme_cbp_eagle_pass/weather.json'
import rioGrande from './fixtures/extreme_cbp_rio_grande_longrange/weather.json'

// Real observed-weather baselines frozen by tools/fixtures/ (REALISM_ROADMAP WP-0/WP-2).
// Imported statically — committed data, never a runtime fetch (§3, enforced by ESLint). Keyed by
// scenario id; extend this map as `npm run fixtures` produces more `weather.json` fixtures.
//
// 15 of 21 scenarios carry observed weather, clearing WP-2's ">=12 of 21" acceptance bar. Two
// carry the date of a specific documented incident — Fort Myers (Hurricane Ian, 2022-09-28) and
// Dixie (the 2021-08-04 northern-flank run) — and the rest carry a real, seasonally-appropriate
// day at the real location. tools/fixtures/scenarios.json records which is which per scenario
// under `dateKind`, so a representative date is never mistaken for a documented one.
//
// Intentionally NOT applied to demo_basic / demo_sar, the onboarding tutorials: their real-day
// weather can exceed the launch-bay gust limit and they must stay launchable.
const OBSERVED: Record<string, ObservedWeather> = {
  extreme_fema_fort_myers: fortMyers,
  extreme_cal_fire_dixie: dixie,
  demo_sar_coastal: oceanBeach,
  extreme_uscg_cape_cod_sar: capeCod,
  extreme_cbp_big_bend_desert_sar: bigBend,
  extreme_lapd_skid_row_welfare: skidRow,
  extreme_nypd_times_sq_mci: timesSq,
  extreme_lapd_hollywood_bowl: hollywoodBowl,
  extreme_dhs_port_la_chemical: portLa,
  extreme_atf_oakland_stash: oaklandStash,
  extreme_usss_presidential_sf: usssSf,
  extreme_multiagency_sf_pursuit: sfPursuit,
  extreme_fbi_hrt_compound: hrtCompound,
  extreme_cbp_eagle_pass: eaglePass,
  extreme_cbp_rio_grande_longrange: rioGrande,
}

/** The frozen observed-weather baseline for a scenario, or undefined when none is sourced. */
export function observedWeatherFor(scenarioId: string): ObservedWeather | undefined {
  return OBSERVED[scenarioId]
}
