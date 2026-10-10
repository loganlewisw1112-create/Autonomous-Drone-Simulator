import type { LatLng } from '@/types'

/**
 * Pure helpers for the on-map vehicle avatars (ground units sent to thermal
 * contacts, and drone-recovery pickups). No DOM, no maplibre, no store: every
 * function here is a deterministic function of its arguments, so marker
 * placement stays identical under sub-stepping and replay scrub.
 */

export type VehicleKind = 'ground' | 'recovery'
export type VehicleVariant = 'truck' | 'suv' | 'pickup'

/** Width / length of each owner-supplied avatar, measured from the final art. */
export const VEHICLE_ASPECT: Readonly<Record<VehicleVariant, number>> = {
  truck: 0.534,
  suv: 0.512,
  pickup: 0.523,
}

/** Real-world body length in metres. */
export const VEHICLE_LENGTH_M: Readonly<Record<VehicleVariant, number>> = {
  truck: 5.6,
  suv: 5.6,
  pickup: 5.9,
}

export const MARKER_MIN_PX = 36
export const MARKER_MAX_PX = 112
/** Heading lookahead along the route so a marker turns smoothly through a vertex. */
export const LOOKAHEAD_M = 6

const EARTH_CIRCUMFERENCE_M = 40075016.686
const MAP_TILE_PX = 512
const NO_TARGET_KEY = '\u0000no-target'

// ─── Variant selection ──────────────────────────────────────────────────────────

/**
 * Ground units alternate truck / suv by `(firstIdx + k) % 2`; the recovery team
 * always drives the white pickup and its index arguments are ignored.
 */
export function avatarFor(kind: VehicleKind, firstIdx: number, k: number): VehicleVariant {
  if (kind === 'recovery') return 'pickup'
  return (((firstIdx + k) % 2) + 2) % 2 === 0 ? 'truck' : 'suv'
}

export interface VariantUnitLike {
  id: string
  role?: string
  targetThermalId?: string
}

export interface GroundUnitSlot {
  /** Index, in the append-only unfiltered `groundUnits` array, of the first unit on the same contact. */
  firstIdx: number
  /** 0-based position of this unit among the units sharing its `targetThermalId`. */
  k: number
}

/**
 * (firstIdx, k) for every ground unit, keyed by unit id. Entries whose role is
 * 'recovery' are skipped: they take no slot and do not advance `k`. Units with
 * no `targetThermalId` form one group of their own.
 */
export function groundUnitSlots(units: readonly VariantUnitLike[]): Map<string, GroundUnitSlot> {
  const groups = new Map<string, { firstIdx: number; count: number }>()
  const slots = new Map<string, GroundUnitSlot>()
  units.forEach((unit, idx) => {
    if (unit.role === 'recovery') return
    const key = unit.targetThermalId ?? NO_TARGET_KEY
    let group = groups.get(key)
    if (!group) {
      group = { firstIdx: idx, count: 0 }
      groups.set(key, group)
    }
    slots.set(unit.id, { firstIdx: group.firstIdx, k: group.count })
    group.count += 1
  })
  return slots
}

/** Variant for every entry of `groundUnits`, keyed by unit id (see `groundUnitSlots`). */
export function groundUnitVariants(units: readonly VariantUnitLike[]): Map<string, VehicleVariant> {
  const slots = groundUnitSlots(units)
  const variants = new Map<string, VehicleVariant>()
  for (const unit of units) {
    if (unit.role === 'recovery') {
      variants.set(unit.id, avatarFor('recovery', 0, 0))
      continue
    }
    const slot = slots.get(unit.id)
    if (slot) variants.set(unit.id, avatarFor('ground', slot.firstIdx, slot.k))
  }
  return variants
}

// ─── Assets ─────────────────────────────────────────────────────────────────────

const ASSET_STEM: Readonly<Record<VehicleVariant, string>> = {
  truck: 'ground-unit-truck',
  suv: 'ground-unit-suv',
  pickup: 'recovery-unit-pickup',
}

export interface VehicleImageUrls {
  /** The 128 px file. */
  src: string
  /** The 256 px file, for 2x displays. */
  src2x: string
  /** `src 1x, src2x 2x` */
  srcSet: string
}

export function vehicleImageUrls(variant: VehicleVariant, baseUrl: string = import.meta.env.BASE_URL): VehicleImageUrls {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const stem = ASSET_STEM[variant]
  const src = `${base}ground-units/${stem}-128.png`
  const src2x = `${base}ground-units/${stem}-256.png`
  return { src, src2x, srcSet: `${src} 1x, ${src2x} 2x` }
}

// ─── Scale ──────────────────────────────────────────────────────────────────────

/** Ground resolution in metres per CSS pixel on a 512 px tile pyramid. */
export function mpp(zoom: number, latDeg: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((latDeg * Math.PI) / 180)) / (MAP_TILE_PX * 2 ** zoom)
}

export interface MarkerSizePx {
  /** Vehicle length (the image height: art is front-up). */
  lengthPx: number
  /** Vehicle width (the image width). */
  widthPx: number
}

/** True-scale marker size, clamped to 36..112 px long. Exact at pitch 0, approximate when pitched. */
export function markerSizePx(zoom: number, latDeg: number, lengthM: number, aspect: number): MarkerSizePx {
  const raw = lengthM / mpp(zoom, latDeg)
  const lengthPx = Number.isNaN(raw) ? MARKER_MIN_PX : Math.min(MARKER_MAX_PX, Math.max(MARKER_MIN_PX, raw))
  return { lengthPx, widthPx: lengthPx * aspect }
}

/** MapLibre marker offset that puts the chip just above a vehicle of `lengthPx`. */
export function recoveryChipOffset(lengthPx: number): [number, number] {
  return [0, -(lengthPx / 2 + 10)]
}

// ─── Route geometry ─────────────────────────────────────────────────────────────

/**
 * The minimum a road route must expose for avatar placement. `cumDistM[i]` is
 * the distance along the polyline, in metres, at `points[i]` (so `cumDistM[0]`
 * is 0). `hiddenRanges` are `[fromM, toM]` spans along the route (tunnels and
 * covered edges) inside which the marker is hidden.
 */
export interface RouteLike {
  points: readonly LatLng[]
  cumDistM: readonly number[]
  hiddenRanges?: readonly (readonly [number, number])[]
}

export function routeLengthM(route: RouteLike): number {
  const n = Math.min(route.points.length, route.cumDistM.length)
  return n > 0 ? route.cumDistM[n - 1] : 0
}

/**
 * Position `s` metres along the route, by binary search on `cumDistM`. `s` is
 * clamped to the route, so there is never extrapolation. Null only for a route
 * with no points.
 */
export function pointAtDistance(route: RouteLike, s: number): LatLng | null {
  const n = Math.min(route.points.length, route.cumDistM.length)
  if (n === 0) return null
  const first = route.points[0]
  if (n === 1 || !(s > 0)) return first
  const total = route.cumDistM[n - 1]
  if (s >= total) return route.points[n - 1]

  // Highest i in [0, n - 2] with cumDistM[i] <= s.
  let lo = 0
  let hi = n - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (route.cumDistM[mid] <= s) lo = mid
    else hi = mid - 1
  }
  const a = route.points[lo]
  const b = route.points[lo + 1]
  const span = route.cumDistM[lo + 1] - route.cumDistM[lo]
  const t = span > 0 ? (s - route.cumDistM[lo]) / span : 0
  if (t <= 0) return a
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }
}

/** Degrees clockwise from north, in [0, 360), of the straight line from -> to. */
export function bearingDeg(from: LatLng, to: LatLng): number {
  const meanLat = (((from.lat + to.lat) / 2) * Math.PI) / 180
  let dLngDeg = to.lng - from.lng
  if (dLngDeg > 180) dLngDeg -= 360
  else if (dLngDeg < -180) dLngDeg += 360
  const deg = (Math.atan2(dLngDeg * Math.cos(meanLat), to.lat - from.lat) * 180) / Math.PI
  let normalised = deg % 360
  if (normalised < 0) normalised += 360
  return normalised >= 360 ? 0 : normalised
}

function lastSegmentBearing(route: RouteLike): number {
  for (let i = route.points.length - 1; i > 0; i -= 1) {
    const a = route.points[i - 1]
    const b = route.points[i]
    if (a.lat !== b.lat || a.lng !== b.lng) return bearingDeg(a, b)
  }
  return 0
}

/**
 * Heading in degrees clockwise from north at `s` metres along the route: the
 * bearing from the position at `s` to the position `LOOKAHEAD_M` further on,
 * so the marker does not snap at a vertex. At (or past) the route end it keeps
 * the last segment's bearing. 0 for a route with fewer than two points.
 */
export function headingAt(route: RouteLike, s: number): number {
  if (Math.min(route.points.length, route.cumDistM.length) < 2) return 0
  const total = routeLengthM(route)
  if (!(s < total)) return lastSegmentBearing(route)
  const here = Math.max(0, s)
  const a = pointAtDistance(route, here)
  const b = pointAtDistance(route, Math.min(here + LOOKAHEAD_M, total))
  if (!a || !b || (a.lat === b.lat && a.lng === b.lng)) return lastSegmentBearing(route)
  return bearingDeg(a, b)
}

/** True when `s` is strictly inside a `hiddenRanges` span (the portals themselves stay visible). */
export function isHidden(route: RouteLike, s: number): boolean {
  const ranges = route.hiddenRanges
  if (!ranges) return false
  for (const [from, to] of ranges) {
    if (s > from && s < to) return true
  }
  return false
}
