import { haversineDistanceM } from '@/utils/geometry'
import type { GroundUnitState, LatLng, WeatherVariantState } from '@/types'

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
