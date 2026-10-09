import type { GroundUnitState, RecoveryTeamState, ScenarioConfig } from '@/types'
import type { ReportSource } from '@/sim/demo/reportViewModel'

/**
 * The ONE place the report adapters build ground-unit / recovery-team tracks.
 *
 * Contract (DEMO_BLOCKERS_PLAN c5a): for each unit or team, if the road network for the scenario is
 * ALREADY loaded and the unit was road-routed, points = the route prefix up to the final routeDistM,
 * and onFootTo = the target when accessGapM > 15. If the network is not loaded (or the unit was not
 * road-routed) return no track for it. This function must never trigger an async load.
 *
 * TODO c12b: wire getUnitRoute / getTeamRoute (src/sim/mission/routeMemo.ts) once road routing lands.
 * Until then it returns undefined, so the report draws no vehicle tracks.
 */
export function buildVehicleTracks(
  finalGroundUnits: readonly GroundUnitState[],
  finalRecoveryTeams: readonly RecoveryTeamState[],
  scenario: ScenarioConfig,
): ReportSource['vehicleTracks'] {
  void finalGroundUnits
  void finalRecoveryTeams
  void scenario
  return undefined
}
