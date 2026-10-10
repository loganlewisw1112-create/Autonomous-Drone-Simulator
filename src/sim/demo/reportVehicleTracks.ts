import type { GroundUnitState, LatLng, RecoveryTeamState, ScenarioConfig } from '@/types'
import type { ReportSource } from '@/sim/demo/reportViewModel'
import { getRoadNetwork } from '@/scenarios/roadFixtures'
import { pointAtDistance } from '@/sim/mission/roadRouter'
import type { RoadRoute } from '@/sim/mission/roadRouter'
import { getTeamRoute, getUnitRoute } from '@/sim/mission/routeMemo'

type VehicleTrack = NonNullable<ReportSource['vehicleTracks']>[number]

/** A walk-in shorter than this is not drawn (same threshold the live map uses for the foot line). */
const WALK_IN_MIN_M = 15
/** A vehicle counts as having reached the end of its route within this many metres. */
const ARRIVED_TOLERANCE_M = 0.5

function isFinitePoint(p: LatLng | undefined): p is LatLng {
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng)
}

/**
 * The route from its start up to distance `s` along it: every vertex before `s`, then the exact
 * point at `s`. Nothing past `s` is included, so the line ends where the vehicle ended.
 */
function routePrefix(route: RoadRoute, s: number): LatLng[] {
  const end = Math.min(Math.max(s, 0), route.lengthM)
  const out: LatLng[] = []
  for (let i = 0; i < route.points.length; i++) {
    if (route.cumDistM[i] >= end) break
    out.push(route.points[i])
  }
  out.push(pointAtDistance(route, end))
  return out
}

function track(
  id: string,
  kind: VehicleTrack['kind'],
  route: RoadRoute,
  routeDistM: number | undefined,
  accessGapM: number | undefined,
  target: LatLng | undefined,
): VehicleTrack | null {
  if (route.status !== 'ok') return null
  const driven = routeDistM ?? 0
  const points = routePrefix(route, driven)
  // A vehicle that never left its staging point has no line to draw; the view already marks its position.
  if (points.length < 2) return null
  // The walk-in is the vehicle's OWN gap (routes are cached per snap point and shared between targets,
  // so route.accessGapM belongs to whichever caller built it first), and only starts once it has parked.
  const parked = driven >= route.lengthM - ARRIVED_TOLERANCE_M
  const walksIn = parked && (accessGapM ?? 0) > WALK_IN_MIN_M && isFinitePoint(target)
  return { id, kind, points, ...(walksIn ? { onFootTo: target } : {}) }
}

/**
 * The ONE place the report adapters build ground-unit / recovery-team tracks.
 *
 * Contract (DEMO_BLOCKERS_PLAN c5a): for each unit or team, if the road network for the scenario is
 * ALREADY loaded and the vehicle was road-routed, points = the route prefix up to its final routeDistM,
 * and onFootTo = the target (contact / aircraft position) when the vehicle's own accessGapM > 15 and it
 * has parked at the end of the route. If the network is not loaded, the team was not road-routed, or
 * the route cannot be rebuilt, that vehicle gets no track and the report draws only its final position.
 * Returns undefined when there are no tracks. This function never triggers an async road load:
 * getRoadNetwork only reads the session cache, and the router calls below are synchronous and pure.
 */
export function buildVehicleTracks(
  finalGroundUnits: readonly GroundUnitState[],
  finalRecoveryTeams: readonly RecoveryTeamState[],
  scenario: ScenarioConfig,
): ReportSource['vehicleTracks'] {
  if (!getRoadNetwork(scenario)) return undefined
  const tracks: VehicleTrack[] = []

  for (const unit of finalGroundUnits) {
    const contactPos = scenario.heatSources?.find((h) => h.id === unit.targetThermalId)?.position
    const route = getUnitRoute(unit, scenario, contactPos)
    if (!route) continue
    const built = track(unit.id, 'ground', route, unit.routeDistM, unit.accessGapM, contactPos)
    if (built) tracks.push(built)
  }

  for (const team of finalRecoveryTeams) {
    if (team.roadRouted !== true) continue
    const route = getTeamRoute(team, scenario)
    if (!route) continue
    const built = track(team.id, 'recovery', route, team.routeDistM, team.accessGapM, team.targetPosition)
    if (built) tracks.push(built)
  }

  return tracks.length > 0 ? tracks : undefined
}
