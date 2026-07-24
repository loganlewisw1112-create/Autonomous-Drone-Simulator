import type { ObservedAirspace } from '@/types'
import oakPort from './fixtures/demo_perimeter/airspace.json'
import capeCod from './fixtures/extreme_uscg_cape_cod_sar/airspace.json'
import portLa from './fixtures/extreme_dhs_port_la_chemical/airspace.json'

// Real FAA UAS Facility Map ceiling grids frozen by tools/fixtures/ (REALISM_ROADMAP WP-0/WP-3).
// Phase 5 remaps refreshed training scenario ids to committed fixtures; culled LE/pursuit ids removed.
const OBSERVED: Record<string, ObservedAirspace> = {
  demo_perimeter: oakPort,
  train_uscg_maritime_sar: capeCod,
  train_hazmat_plume: portLa,
}

/** The frozen published ceiling grid for a scenario, or undefined when none is published. */
export function observedAirspaceFor(scenarioId: string): ObservedAirspace | undefined {
  return OBSERVED[scenarioId]
}

export function scenariosWithObservedAirspace(): string[] {
  return Object.keys(OBSERVED)
}
