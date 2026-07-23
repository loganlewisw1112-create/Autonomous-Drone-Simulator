import { MAX_WAYPOINTS_PER_DRONE } from '@/sim/mission/routeLimits'
import type { Waypoint } from '@/types'

export type RouteApplicationMode = 'replace' | 'divert_resume'

export interface RouteCappedWarning {
  code: 'route_capped'
  limit: number
  droppedWaypointCount: number
  message: string
}

export interface TerrainRouteApplicationWarning {
  code: 'terrain_route'
  warningCount: number
  message: string
}

export type RouteApplicationWarning = RouteCappedWarning | TerrainRouteApplicationWarning

export interface RouteApplicationResult {
  mode: RouteApplicationMode
  route: Waypoint[]
  incomingWaypointCount: number
  resumedWaypointCount: number
  droppedWaypointCount: number
  capped: boolean
  warning: RouteApplicationWarning | null
}

export interface RouteApplicationInput {
  mode?: RouteApplicationMode
  incomingRoute: readonly Waypoint[]
  currentRoute?: readonly Waypoint[]
  currentWaypointIndex?: number
}

/**
 * Builds the route that the existing mission traversal will execute from index zero.
 * Divert-and-resume is intentionally only a splice: the incoming diversion runs first,
 * followed by the unfinished route beginning at the aircraft's current waypoint.
 */
export function applyRouteApplication(input: RouteApplicationInput): RouteApplicationResult {
  const mode = input.mode ?? 'replace'
  const resumeIndex = normalizeWaypointIndex(input.currentWaypointIndex)
  const resumed = mode === 'divert_resume'
    ? (input.currentRoute ?? []).slice(resumeIndex)
    : []
  const composed = [...input.incomingRoute, ...resumed]
  const droppedWaypointCount = Math.max(0, composed.length - MAX_WAYPOINTS_PER_DRONE)
  const route = composed
    .slice(0, MAX_WAYPOINTS_PER_DRONE)
    .map(cloneWaypoint)
  const warning = droppedWaypointCount > 0
    ? {
        code: 'route_capped' as const,
        limit: MAX_WAYPOINTS_PER_DRONE,
        droppedWaypointCount,
        message: `Route capped at ${MAX_WAYPOINTS_PER_DRONE} waypoints; ${droppedWaypointCount} omitted.`,
      }
    : null

  return {
    mode,
    route,
    incomingWaypointCount: input.incomingRoute.length,
    resumedWaypointCount: resumed.length,
    droppedWaypointCount,
    capped: droppedWaypointCount > 0,
    warning,
  }
}

function normalizeWaypointIndex(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function cloneWaypoint(waypoint: Waypoint): Waypoint {
  return { ...waypoint, position: { ...waypoint.position } }
}
