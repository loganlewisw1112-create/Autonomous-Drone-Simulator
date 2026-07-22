import { describe, expect, it } from 'vitest'
import { applyRouteApplication } from '@/sim/mission/routeApplication'
import { MAX_WAYPOINTS_PER_DRONE } from '@/sim/mission/routeLimits'
import type { Waypoint } from '@/types'

describe('route application', () => {
  it('defaults to replacing the current route', () => {
    const incoming = [waypoint('new-1')]
    const current = [waypoint('old-1'), waypoint('old-2')]

    const result = applyRouteApplication({ incomingRoute: incoming, currentRoute: current, currentWaypointIndex: 1 })

    expect(result.mode).toBe('replace')
    expect(result.route.map((item) => item.id)).toEqual(['new-1'])
    expect(result.resumedWaypointCount).toBe(0)
    expect(result.warning).toBeNull()
  })

  it('splices the incoming diversion before the unfinished route at the current index', () => {
    const result = applyRouteApplication({
      mode: 'divert_resume',
      incomingRoute: [waypoint('divert-a'), waypoint('divert-b')],
      currentRoute: [waypoint('old-0'), waypoint('old-1'), waypoint('old-2')],
      currentWaypointIndex: 1,
    })

    expect(result.route.map((item) => item.id)).toEqual(['divert-a', 'divert-b', 'old-1', 'old-2'])
    expect(result.incomingWaypointCount).toBe(2)
    expect(result.resumedWaypointCount).toBe(2)
  })

  it('caps the composed route and surfaces the exact omitted count', () => {
    const incoming = Array.from({ length: 4 }, (_, index) => waypoint(`divert-${index}`))
    const current = Array.from({ length: MAX_WAYPOINTS_PER_DRONE }, (_, index) => waypoint(`old-${index}`))

    const result = applyRouteApplication({
      mode: 'divert_resume',
      incomingRoute: incoming,
      currentRoute: current,
      currentWaypointIndex: 1,
    })

    expect(result.route).toHaveLength(MAX_WAYPOINTS_PER_DRONE)
    expect(result.droppedWaypointCount).toBe(3)
    expect(result.warning).toEqual({
      code: 'route_capped',
      limit: MAX_WAYPOINTS_PER_DRONE,
      droppedWaypointCount: 3,
      message: `Route capped at ${MAX_WAYPOINTS_PER_DRONE} waypoints; 3 omitted.`,
    })
  })

  it('returns a deep-cloned route without mutating either input', () => {
    const incoming = [waypoint('new-1')]
    const current = [waypoint('old-1')]
    const result = applyRouteApplication({ mode: 'divert_resume', incomingRoute: incoming, currentRoute: current })

    result.route[0].position.lat += 1

    expect(incoming[0].position.lat).toBe(37.78)
    expect(current[0].position.lat).toBe(37.78)
  })
})

function waypoint(id: string): Waypoint {
  return { id, label: id, position: { lat: 37.78, lng: -122.4 }, altitudeFt: 120 }
}
