import { offsetLatLng } from '@/utils/geometry'
import type { DroneState, GnssFixQuality, ObservedAirspace, Waypoint } from '@/types'
import type { DeviceMode } from '@/hooks/useDeviceMode'

type LngLatCoord = [number, number]

export type BuildingRenderMode = 'fill-extrusion' | 'fill'

/**
 * WP-4 rendering cut line: desktop gets 2.5D prisms; both phone orientations get the same
 * 2D footprints. Physics continues to use the full building index in every device mode.
 */
export function buildingRenderMode(deviceMode: DeviceMode): BuildingRenderMode {
  return deviceMode === 'desktop' ? 'fill-extrusion' : 'fill'
}

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

export interface IrFootprintFeature {
  type: 'Feature'
  geometry: { type: 'Polygon'; coordinates: LngLatCoord[][] }
  properties: { id: string }
}

// Airborne states whose drones project a thermal sensor footprint on the ground.
const IR_FOOTPRINT_STATES = new Set<DroneState['missionState']>([
  'navigate', 'sar_grid', 'hover', 'launch', 'return_to_base', 'avoid', 'thermal_hold', 'inspect',
])

/**
 * Forward-looking thermal sensor footprint (gimbal FOV projected to ground) for
 * each airborne drone. Ground reach grows with altitude — a wider swath from
 * higher AGL — and a fixed half-angle gives the characteristic scanning cone in
 * the drone's heading direction. Rendered only in IR sensor mode.
 */
export function buildIrFootprintFeatures(drones: DroneState[]): IrFootprintFeature[] {
  return drones.flatMap((drone) => {
    if (!IR_FOOTPRINT_STATES.has(drone.missionState) || drone.altitudeFt < 5) return []
    const rangeM = Math.max(45, Math.min(140, 45 + drone.altitudeFt * 0.28))
    const halfAngle = 30
    const steps = 6
    const apex: LngLatCoord = [drone.position.lng, drone.position.lat]
    const arc: LngLatCoord[] = []
    for (let i = 0; i <= steps; i++) {
      const brg = drone.headingDeg - halfAngle + (2 * halfAngle * i) / steps
      const p = offsetLatLng(drone.position, brg, rangeM)
      arc.push([p.lng, p.lat])
    }
    return [{
      type: 'Feature' as const,
      geometry: { type: 'Polygon' as const, coordinates: [[apex, ...arc, apex]] },
      properties: { id: drone.id },
    }]
  })
}

export interface AirspaceCeilingFeature {
  type: 'Feature'
  geometry: { type: 'Polygon'; coordinates: LngLatCoord[][] }
  properties: {
    ceilingFt: number
    /** MAP_EFF, repeated per feature so a map click can answer "how old is this?" (§WP-3). */
    mapEffective: string
    label: string
  }
}

/**
 * The real FAA UAS Facility Map ceiling grid, as renderable polygons (REALISM_ROADMAP WP-3).
 *
 * The fixture stores each 30 x 30 arc-second cell as [west, south, east, north] rather than a
 * ring — lossless, because the UASFM grid is a lat/lng graticule, and it is what keeps the
 * 227-cell SF pursuit fixture inside §19's byte budget. The ring is rebuilt here, at the one
 * place that needs a polygon.
 *
 * `label` carries the edition date into the rendered feature so the layer can never show a
 * ceiling without also being able to show how old it is — WP-3's stated accept criterion is
 * that a stale fixture must be *visible*, not silently believed.
 */
export function buildAirspaceCeilingFeatures(
  airspace: ObservedAirspace | undefined,
): AirspaceCeilingFeature[] {
  if (!airspace) return []
  return airspace.cells.map((cell) => {
    const [west, south, east, north] = cell.bounds
    return {
      type: 'Feature' as const,
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[
          [west, south], [east, south], [east, north], [west, north], [west, south],
        ] as LngLatCoord[]],
      },
      properties: {
        ceilingFt: cell.ceilingFt,
        mapEffective: airspace.mapEffective,
        label: `${cell.ceilingFt}ft AGL · FAA UASFM eff ${airspace.mapEffective}`,
      },
    }
  })
}

export interface GnssUncertaintyFeature {
  type: 'Feature'
  geometry: { type: 'Polygon'; coordinates: LngLatCoord[][] }
  properties: {
    id: string
    color: string
    radiusM: number
    fixQuality: GnssFixQuality
  }
}

/** Circle resolution. 24 segments is smooth at any zoom the uncertainty ring is legible at. */
const UNCERTAINTY_STEPS = 24

/**
 * GNSS uncertainty ring around each drone's REPORTED position (REALISM_ROADMAP WP-7).
 *
 * Drawn at the 1σ horizontal error, σ_H = HDOP × σ_UERE, centred on where the aircraft says it
 * is — not on the truth the sim flies. That is the whole point of the visual: as the drone
 * descends between buildings the ring widens and the marker drifts off the real track, and the
 * operator has to decide whether the position is still trustworthy.
 *
 * A drone with no fix has no meaningful radius to draw — the receiver is not claiming a position
 * at all — so it is omitted here and surfaced as a GPS LOST state instead. An absent ring is
 * never "no error"; it means either no fix or no constellation fixture for the scenario.
 */
export function buildGnssUncertaintyFeatures(drones: DroneState[]): GnssUncertaintyFeature[] {
  return drones.flatMap((drone) => {
    if (drone.fixQuality === undefined || drone.fixQuality === 'no_fix') return []
    const radiusM = drone.gnssHorizontalErrorM ?? 0
    // Sub-metre rings are visual noise at any usable zoom and say nothing an operator can act on.
    if (!(radiusM > 1)) return []
    const centre = drone.reportedPosition ?? drone.position

    const ring: LngLatCoord[] = []
    for (let i = 0; i <= UNCERTAINTY_STEPS; i += 1) {
      const p = offsetLatLng(centre, (360 * i) / UNCERTAINTY_STEPS, radiusM)
      ring.push([p.lng, p.lat])
    }

    return [{
      type: 'Feature' as const,
      geometry: { type: 'Polygon' as const, coordinates: [ring] },
      properties: {
        id: drone.id,
        color: drone.fixQuality === 'degraded' ? '#ffaa00' : drone.color,
        radiusM,
        fixQuality: drone.fixQuality,
      },
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
