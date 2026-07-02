import type { DroneState, Waypoint } from '@/types'

type LngLatCoord = [number, number]

export interface NextWaypointFeature {
  type: 'Feature'
  geometry: {
    type: 'LineString'
    coordinates: [LngLatCoord, LngLatCoord]
  }
  properties: {
    color: string
  }
}

export interface ConflictFeature {
  type: 'Feature'
  geometry: {
    type: 'Point'
    coordinates: LngLatCoord
  }
  properties: {
    id: string
  }
}

const NEXT_WAYPOINT_STATES = new Set<DroneState['missionState']>(['navigate', 'sar_grid', 'hover'])

export function buildNextWpFeatures(
  drones: DroneState[],
  droneWaypoints: Record<string, Waypoint[]>,
  scenarioWaypoints: Waypoint[] = [],
): NextWaypointFeature[] {
  return drones.flatMap((drone) => {
    if (!NEXT_WAYPOINT_STATES.has(drone.missionState)) return []

    const waypoints = droneWaypoints[drone.id] ?? scenarioWaypoints
    const nextWaypoint = waypoints[drone.currentWaypointIndex]
    if (!nextWaypoint) return []

    return [{
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [drone.position.lng, drone.position.lat],
          [nextWaypoint.position.lng, nextWaypoint.position.lat],
        ],
      },
      properties: { color: drone.color },
    }]
  })
}

export function buildConflictFeatures(drones: DroneState[]): ConflictFeature[] {
  return drones
    .filter((drone) => drone.conflictFlag)
    .map((drone) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [drone.position.lng, drone.position.lat] },
      properties: { id: drone.id },
    }))
}
