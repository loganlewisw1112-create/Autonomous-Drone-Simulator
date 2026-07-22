import type { ObservedAirspace } from '@/types'
import oakPursuit from './fixtures/demo_vehicle_pursuit/airspace.json'
import oakPort from './fixtures/demo_perimeter/airspace.json'
import hollywoodBowl from './fixtures/extreme_lapd_hollywood_bowl/airspace.json'
import fbiCompound from './fixtures/extreme_fbi_hrt_compound/airspace.json'
import capeCod from './fixtures/extreme_uscg_cape_cod_sar/airspace.json'
import oaklandStash from './fixtures/extreme_atf_oakland_stash/airspace.json'
import portLa from './fixtures/extreme_dhs_port_la_chemical/airspace.json'
import timesSquare from './fixtures/extreme_nypd_times_sq_mci/airspace.json'
import sfPursuit from './fixtures/extreme_multiagency_sf_pursuit/airspace.json'
import rioGrande from './fixtures/extreme_cbp_rio_grande_longrange/airspace.json'

// Real FAA UAS Facility Map ceiling grids frozen by tools/fixtures/ (REALISM_ROADMAP WP-0/WP-3).
// Imported statically — committed data, never a runtime fetch (§3, enforced by ESLint). Keyed by
// scenario id, exactly as observedWeather.ts is; extend this map as the fixture pipeline produces
// more `airspace.json` files.
//
// The 11 scenarios absent from this map are absent because the FAA publishes NO facility-map
// cells over their AO, not because nobody got round to them. UASFM coverage stops at charted
// facility-map boundaries: the San Francisco grid ends at 37.7333 N, which is south of Ocean
// Beach, and the Fort Myers grid sits inland of Estero Island. "No published ceiling" is a real
// answer, and those scenarios keep the plain Part 107 400 ft ceiling they had before WP-3.
const OBSERVED: Record<string, ObservedAirspace> = {
  demo_vehicle_pursuit: oakPursuit,
  demo_perimeter: oakPort,
  extreme_lapd_hollywood_bowl: hollywoodBowl,
  extreme_fbi_hrt_compound: fbiCompound,
  extreme_uscg_cape_cod_sar: capeCod,
  extreme_atf_oakland_stash: oaklandStash,
  extreme_dhs_port_la_chemical: portLa,
  extreme_nypd_times_sq_mci: timesSquare,
  extreme_multiagency_sf_pursuit: sfPursuit,
  extreme_cbp_rio_grande_longrange: rioGrande,
}

/** The frozen published ceiling grid for a scenario, or undefined when none is published. */
export function observedAirspaceFor(scenarioId: string): ObservedAirspace | undefined {
  return OBSERVED[scenarioId]
}
