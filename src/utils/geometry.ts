import type { LatLng } from '@/types'

const EARTH_RADIUS_M = 6_371_000

export function haversineDistanceM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const sinDLat = Math.sin(dLat / 2)
  const sinDLng = Math.sin(dLng / 2)
  const h =
    sinDLat * sinDLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDLng * sinDLng
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h))
}

// Bearing from a → b in degrees [0, 360)
export function bearingDeg(a: LatLng, b: LatLng): number {
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

// Move a point by distanceM in bearingDeg direction
export function offsetLatLng(origin: LatLng, bearingDegrees: number, distanceM: number): LatLng {
  const d = distanceM / EARTH_RADIUS_M
  const brng = toRad(bearingDegrees)
  const lat1 = toRad(origin.lat)
  const lng1 = toRad(origin.lng)
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng),
  )
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    )
  return { lat: toDeg(lat2), lng: toDeg(lng2) }
}

// Shortest signed angular difference: result ∈ (-180, 180]
export function angleDiffDeg(from: number, to: number): number {
  let diff = ((to - from + 180) % 360) - 180
  if (diff < -180) diff += 360
  return diff
}

// Clamp a value to [min, max]
export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val))
}

// Point-in-polygon (ray casting)
export function pointInPolygon(point: LatLng, polygon: LatLng[]): boolean {
  let inside = false
  const n = polygon.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].lng, yi = polygon[i].lat
    const xj = polygon[j].lng, yj = polygon[j].lat
    const intersect =
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function toRad(deg: number): number { return (deg * Math.PI) / 180 }
function toDeg(rad: number): number { return (rad * 180) / Math.PI }
