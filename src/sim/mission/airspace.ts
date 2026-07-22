import { observedAirspaceFor } from '@/scenarios/observedAirspace'
import type { AirspaceCeilingCell, LatLng, ObservedAirspace, ScenarioConfig, Waypoint } from '@/types'

/**
 * Published FAA UAS Facility Map ceilings, and the route checks that read them
 * (REALISM_ROADMAP WP-3).
 *
 * REAL DATA, SIMULATED AUTHORISATION. The ceilings are the FAA's own published figures, frozen
 * at authoring time by tools/fixtures/faaUasfm.mjs and never fetched at runtime (§3). What
 * remains simulated is the *authorisation* — the sim does not talk to LAANC, does not request
 * anything, and complianceEngine.ts keeps its disclaimer at full strength. The roadmap is
 * explicit that keeping those two claims apart is what makes the project credible (§WP-3, §17).
 *
 * Pure and deterministic: no clock, no RNG, no I/O. Same inputs, same answer, on every build.
 */

export interface CeilingBreach {
  position: LatLng
  altitudeFt: number
  /** The FAA-published Part 107 ceiling for the grid cell under `position`, feet AGL. */
  publishedCeilingFt: number
  /** MAP_EFF, carried through so the operator sees which edition the finding came from. */
  mapEffective: string
}

/** The frozen ceiling grid for a scenario, or undefined when the FAA publishes none for its AO. */
export function airspaceForScenario(scenarioId: string | undefined): ObservedAirspace | undefined {
  return scenarioId ? observedAirspaceFor(scenarioId) : undefined
}

function containsPoint(cell: AirspaceCeilingCell, point: LatLng): boolean {
  const [west, south, east, north] = cell.bounds
  return point.lng >= west && point.lng <= east && point.lat >= south && point.lat <= north
}

/**
 * The published Part 107 ceiling over a point, or undefined outside the published grid.
 *
 * Cell bounds are treated as inclusive on all four edges, so a point on a shared boundary
 * matches both neighbours; the LOWEST of the matching ceilings wins. Inclusive-plus-lowest is
 * chosen over a half-open interval because it is total (no point on the grid's outer edge falls
 * through) and because erring low is the defensible direction on a regulatory surface — the
 * same "conservative is the safe way to be wrong" posture §18.2 takes for POD.
 */
export function publishedCeilingFtAt(
  airspace: ObservedAirspace | undefined,
  point: LatLng,
): number | undefined {
  if (!airspace) return undefined
  let lowest: number | undefined
  for (const cell of airspace.cells) {
    if (!containsPoint(cell, point)) continue
    if (lowest === undefined || cell.ceilingFt < lowest) lowest = cell.ceilingFt
  }
  return lowest
}

/**
 * Every route/track point sitting above the ceiling published for the cell beneath it.
 *
 * Strictly above: a point exactly at the published ceiling is authorised, and a grounded
 * aircraft at 0 ft over a 0 ft cell is not a finding. Points outside the published grid are not
 * findings either — no published ceiling is not the same as a ceiling of zero.
 */
export function findCeilingBreaches(
  airspace: ObservedAirspace | undefined,
  points: Array<{ position: LatLng; altitudeFt: number }>,
): CeilingBreach[] {
  if (!airspace) return []
  const breaches: CeilingBreach[] = []
  for (const point of points) {
    const publishedCeilingFt = publishedCeilingFtAt(airspace, point.position)
    if (publishedCeilingFt === undefined || point.altitudeFt <= publishedCeilingFt) continue
    breaches.push({
      position: point.position,
      altitudeFt: point.altitudeFt,
      publishedCeilingFt,
      mapEffective: airspace.mapEffective,
    })
  }
  return breaches
}

/**
 * The single worst breach — the one with the largest exceedance over its published ceiling —
 * or undefined when the route is inside every published ceiling it crosses.
 *
 * Ties break on the lower ceiling, then on altitude, so the result never depends on the order
 * drones happen to arrive in the fleet array. Determinism is the claim being protected (§3).
 */
export function worstCeilingBreach(
  airspace: ObservedAirspace | undefined,
  points: Array<{ position: LatLng; altitudeFt: number }>,
): CeilingBreach | undefined {
  const breaches = findCeilingBreaches(airspace, points)
  if (breaches.length === 0) return undefined
  return breaches.reduce((worst, candidate) => {
    const dc = candidate.altitudeFt - candidate.publishedCeilingFt
    const dw = worst.altitudeFt - worst.publishedCeilingFt
    if (dc !== dw) return dc > dw ? candidate : worst
    if (candidate.publishedCeilingFt !== worst.publishedCeilingFt) {
      return candidate.publishedCeilingFt < worst.publishedCeilingFt ? candidate : worst
    }
    return candidate.altitudeFt > worst.altitudeFt ? candidate : worst
  })
}

/**
 * Every planned route point of a scenario, with its planned altitude.
 *
 * §WP-3's criterion is about a *route* exceeding a published ceiling, not about telemetry that
 * has already exceeded it — so the check runs against the plan as well as against where the
 * aircraft currently are. That is the difference between the READY tab warning an operator
 * before launch and confirming it afterwards, and the pre-launch warning is the trainable one.
 */
export function plannedRoutePoints(
  scenario: Pick<ScenarioConfig, 'waypoints' | 'perDroneWaypoints' | 'authoredRoutes'> | null | undefined,
): Array<{ position: LatLng; altitudeFt: number }> {
  if (!scenario) return []
  const routes: Waypoint[][] = [
    scenario.waypoints ?? [],
    ...Object.values(scenario.perDroneWaypoints ?? {}),
    ...Object.values(scenario.authoredRoutes ?? {}),
  ]
  return routes.flat().map((wp) => ({ position: wp.position, altitudeFt: wp.altitudeFt }))
}

/**
 * One-line provenance for the READY tab and the map legend.
 *
 * §WP-3's acceptance criterion names this explicitly: MAP_EFF has to be visible so a fixture
 * that has gone stale is *seen* rather than silently believed. The ceilings are real; how old
 * they are is part of reading them honestly.
 */
export function airspaceCeilingCaption(airspace: ObservedAirspace | undefined): string | undefined {
  if (!airspace) return undefined
  const span = airspace.minCeilingFt === airspace.maxCeilingFt
    ? `${airspace.maxCeilingFt}ft`
    : `${airspace.minCeilingFt}–${airspace.maxCeilingFt}ft`
  const facility = airspace.facilities[0] ?? 'FAA UASFM'
  return `${airspace.cells.length} cells ${span} AGL · ${facility} · eff ${airspace.mapEffective}`
}
