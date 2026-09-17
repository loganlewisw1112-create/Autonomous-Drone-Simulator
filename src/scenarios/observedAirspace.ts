import type { ObservedAirspace } from '@/types'
import oakPort from './fixtures/demo_perimeter/airspace.json'
import capeCod from './fixtures/extreme_uscg_cape_cod_sar/airspace.json'
import portLa from './fixtures/extreme_dhs_port_la_chemical/airspace.json'
// WP-3 coverage extension: the historical disaster AOs that fall under a published FAA UASFM
// facility map now carry their real gridded ceilings (tools/fixtures/airspace.mjs). The AOs
// with no charted facility map — Oso, the Camp Fire flank, Kīlauea, Ocean Beach — correctly have
// no fixture and keep the "real data / simulated authorisation" posture with no ceiling layer.
import harvey from './fixtures/hist_harvey_houston_2017/airspace.json'
import joplin from './fixtures/hist_joplin_ef5_2011/airspace.json'
import katrina from './fixtures/hist_katrina_lower_ninth_2005/airspace.json'
import marshall from './fixtures/hist_marshall_fire_2021/airspace.json'

// Real FAA UAS Facility Map ceiling grids frozen by tools/fixtures/ (REALISM_ROADMAP WP-0/WP-3).
// Phase 5 remaps refreshed training scenario ids to committed fixtures; culled LE/pursuit ids removed.
const OBSERVED: Record<string, ObservedAirspace> = {
  demo_perimeter: oakPort,
  train_uscg_maritime_sar: capeCod,
  train_hazmat_plume: portLa,
  hist_harvey_houston_2017: harvey,
  hist_joplin_ef5_2011: joplin,
  hist_katrina_lower_ninth_2005: katrina,
  hist_marshall_fire_2021: marshall,
}

/** The frozen published ceiling grid for a scenario, or undefined when none is published. */
export function observedAirspaceFor(scenarioId: string): ObservedAirspace | undefined {
  return OBSERVED[scenarioId]
}

export function scenariosWithObservedAirspace(): string[] {
  return Object.keys(OBSERVED)
}
