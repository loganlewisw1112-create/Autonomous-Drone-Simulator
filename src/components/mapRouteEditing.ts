import { makeId } from '@/account/crypto'
import { MAX_WAYPOINTS_PER_DRONE } from '@/components/designer/designerValidation'
import { MAX_OPERATOR_ALTITUDE_FT, MIN_OPERATOR_ALTITUDE_FT } from '@/sim/mission/operatorRoutes'
import type { LatLng, Waypoint } from '@/types'

// ─── Touch route editing (pure helpers) ──────────────────────────────────────
// The tap-to-place interaction lives in TacticalMap, but its route arithmetic is
// kept here so it can be tested without mounting a MapLibre canvas. These
// functions are pure: they never touch the store, and `makeId` is injectable so
// tests can assert on stable ids.

/** Default altitude for the first waypoint of an empty route. */
export const DEFAULT_APPEND_ALTITUDE_FT = 150

/** Dwell applied to operator-placed waypoints, matching the mission designer. */
export const APPEND_DWELL_SEC = 5

export function canAppend(route: Waypoint[]): boolean {
  return route.length < MAX_WAYPOINTS_PER_DRONE
}

export function clampOperatorAltitude(altitudeFt: number): number {
  if (!Number.isFinite(altitudeFt)) return DEFAULT_APPEND_ALTITUDE_FT
  return Math.min(MAX_OPERATOR_ALTITUDE_FT, Math.max(MIN_OPERATOR_ALTITUDE_FT, altitudeFt))
}

/**
 * Builds the waypoint a tap on empty map should append.
 *
 * Altitude inherits the current last waypoint (so a tapped extension continues at
 * the altitude the operator is already flying) and falls back to
 * DEFAULT_APPEND_ALTITUDE_FT for an empty route. Labels and dwell mirror the
 * mission designer's convention so operator-authored waypoints look identical
 * wherever they were created.
 */
export function buildAppendedWaypoint(
  route: Waypoint[],
  position: LatLng,
  idFactory: () => string = makeId,
): Waypoint {
  const previous = route[route.length - 1]
  return {
    id: idFactory(),
    label: `Waypoint ${route.length + 1}`,
    position,
    altitudeFt: clampOperatorAltitude(previous?.altitudeFt ?? DEFAULT_APPEND_ALTITUDE_FT),
    dwellTimeSec: APPEND_DWELL_SEC,
  }
}

/**
 * Returns the route with `waypointId` removed. Remaining waypoints keep their ids
 * (so in-flight targeting stays stable) but default `Waypoint N` labels are
 * renumbered to stay contiguous; operator-renamed labels are left alone.
 */
export function routeWithoutWaypoint(route: Waypoint[], waypointId: string): Waypoint[] {
  return route
    .filter((waypoint) => waypoint.id !== waypointId)
    .map((waypoint, index) =>
      /^Waypoint \d+$/.test(waypoint.label ?? '')
        ? { ...waypoint, label: `Waypoint ${index + 1}` }
        : waypoint,
    )
}
