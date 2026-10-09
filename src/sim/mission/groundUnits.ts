import { haversineDistanceM } from '@/utils/geometry'
import type { GroundUnitState, LatLng, WeatherVariantState } from '@/types'
import { headingAtDistance, pointAtDistance, remainingNominalSec, speedAt } from '@/sim/mission/roadRouter'
import type { RoadRoute } from '@/sim/mission/roadRouter'

const VEHICLE_SPEED_MPS = 8.0  // ~30 km/h urban response speed

/** Advance a ground unit one physics tick toward its target position. */
export function tickGroundUnit(
  unit: GroundUnitState,
  targetPos: LatLng,
  weather: WeatherVariantState,
  dt: number,
): GroundUnitState {
  if (unit.status !== 'enroute') return unit

  const speed = VEHICLE_SPEED_MPS / weather.groundUnitEtaMultiplier
  const dist = haversineDistanceM(unit.position, targetPos)

  if (dist < 15) {
    return { ...unit, status: 'on_scene', etaSec: 0 }
  }

  const stepM = speed * dt
  const frac = Math.min(1, stepM / dist)
  const newPos: LatLng = {
    lat: unit.position.lat + (targetPos.lat - unit.position.lat) * frac,
    lng: unit.position.lng + (targetPos.lng - unit.position.lng) * frac,
  }
  const remaining = Math.max(0, dist - stepM)
  return { ...unit, position: newPos, etaSec: Math.round(remaining / speed) }
}

/** Compute initial ETA in seconds for a unit dispatched from `from` to `to`. */
export function computeGroundUnitEta(
  from: LatLng,
  to: LatLng,
  weather: WeatherVariantState,
): number {
  const dist = haversineDistanceM(from, to)
  const speed = VEHICLE_SPEED_MPS / weather.groundUnitEtaMultiplier
  return Math.round(dist / speed)
}

// ── Road-routed movement (c12b) ─────────────────────────────────────────────────
// The functions above stay as the retained straight-line model. A unit drawn on the map is driven
// by the route functions below: progress along the road polyline, never a straight line.

/** Seconds of driving left from `distM`, with the weather divide applied. */
export function etaAlongRoute(route: RoadRoute, distM: number, weather: WeatherVariantState): number {
  return Math.round(remainingNominalSec(route, distM) * weather.groundUnitEtaMultiplier)
}

/**
 * Advance a routed unit one step: `routeDistM += speedAt / multiplier * dt`, clamped to the route
 * length; the position is always the point at `routeDistM` on the polyline. Arrives when the route
 * end is reached (a route of length 0 arrives on the first step).
 */
export function tickRoutedGroundUnit(
  unit: GroundUnitState,
  route: RoadRoute,
  weather: WeatherVariantState,
  dt: number,
): GroundUnitState {
  if (unit.status !== 'enroute' || route.status !== 'ok') return unit
  const from = unit.routeDistM ?? 0
  const next = Math.min(route.lengthM, from + (speedAt(route, from) / weather.groundUnitEtaMultiplier) * dt)
  const p = pointAtDistance(route, next)
  const heading = route.lengthM > 0 ? Math.round(headingAtDistance(route, next) * 10) / 10 : (unit.headingDeg ?? 0)
  const moved = { ...unit, position: { lat: p.lat, lng: p.lng }, routeDistM: next, headingDeg: heading }
  if (next >= route.lengthM) return { ...moved, status: 'on_scene', etaSec: 0 }
  return { ...moved, etaSec: etaAlongRoute(route, next, weather) }
}
