import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { MAX_WAYPOINTS_PER_DRONE } from '@/sim/mission/routeLimits'
import type { MissionSituation } from '@/sim/mission/tacticalAdvisor'
import type { Waypoint } from '@/types'

export function hashMissionSituation(situation: MissionSituation): string {
  return bytesToHex(sha256(JSON.stringify(canonicalize(situation))))
}

export function clampAdvisorRoute(route: readonly Waypoint[]): Waypoint[] {
  return route.slice(0, MAX_WAYPOINTS_PER_DRONE).map(cloneWaypoint)
}

export function routesEqual(left: readonly Waypoint[] | undefined, right: readonly Waypoint[]): boolean {
  if (!left || left.length !== right.length) return false
  return left.every((waypoint, index) => {
    const candidate = right[index]
    return waypoint.id === candidate.id
      && waypoint.position.lat === candidate.position.lat
      && waypoint.position.lng === candidate.position.lng
      && waypoint.altitudeFt === candidate.altitudeFt
      && waypoint.label === candidate.label
      && waypoint.dwellTimeSec === candidate.dwellTimeSec
  })
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isObject(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  )
}

function cloneWaypoint(waypoint: Waypoint): Waypoint {
  return { ...waypoint, position: { ...waypoint.position } }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
