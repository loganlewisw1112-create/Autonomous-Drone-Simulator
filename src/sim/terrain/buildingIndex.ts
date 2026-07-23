import type { LatLng } from '@/types'
import type { Point3D } from './terrainRaster'

// WP-4 building geometry is deliberately independent of rendering. GeoJSON footprints are
// projected once into a local metre plane, bucketed into 100 m cells, then queried by a
// supercover DDA. This object also satisfies OcclusionService's StructureLayer seam.

export type BuildingId = string | number
export type BuildingHeightSource = 'measured' | 'inferred'
export type GeoJsonPosition = readonly number[]

export interface BuildingProperties {
  h: number
  hSrc: BuildingHeightSource
  base: number
}

export interface BuildingPolygonGeometry {
  type: 'Polygon'
  coordinates: readonly (readonly GeoJsonPosition[])[]
}

export interface BuildingMultiPolygonGeometry {
  type: 'MultiPolygon'
  coordinates: readonly (readonly (readonly GeoJsonPosition[])[])[]
}

export interface BuildingFeature {
  type: 'Feature'
  id?: BuildingId
  properties: BuildingProperties
  geometry: BuildingPolygonGeometry | BuildingMultiPolygonGeometry
}

export interface BuildingFeatureCollection {
  type: 'FeatureCollection'
  features: readonly BuildingFeature[]
}

export interface BuildingSummary extends BuildingProperties {
  id: BuildingId
  index: number
  topMslM: number
}

export interface BuildingSurfaceHit extends BuildingSummary {
  at: LatLng
}

export interface BuildingBlocker extends BuildingSummary {
  blockedAt: LatLng
  rayHeightMslM: number
  /** Ray height minus roof height. Negative means blocked. */
  clearanceM: number
}

export interface BuildingLosResult {
  clear: boolean
  blocker: BuildingBlocker | null
  /** Minimum roof clearance over crossed footprints; Infinity when none are crossed. */
  clearanceM: number
}

export interface BuildingIndex {
  readonly cellSizeM: number
  readonly buildingCount: number
  readonly cellCount: number
  readonly maxTopM: number
  /** StructureLayer-compatible roof lookup in metres MSL. */
  topAt(lat: number, lng: number): number | null
  surfaceAt(lat: number, lng: number): BuildingSurfaceHit | null
  intersectRay(a: Point3D, b: Point3D): BuildingLosResult
  candidateIndicesForRay(a: LatLng, b: LatLng): readonly number[]
}

interface XY { x: number; y: number }
interface Bounds { minX: number; minY: number; maxX: number; maxY: number }
type Ring = readonly XY[]
type Polygon = readonly Ring[]
interface Prepared extends BuildingSummary {
  polygons: readonly Polygon[]
  bounds: Bounds
}
interface Projector {
  project(lat: number, lng: number): XY
  unproject(point: XY): LatLng
}

const EARTH_RADIUS_M = 6_371_008.8
const DEG_TO_RAD = Math.PI / 180
const DEFAULT_CELL_M = 100
const XY_EPS = 1e-8
const T_EPS = 1e-10

export function createBuildingIndex(
  collection: BuildingFeatureCollection,
  options: { cellSizeM?: number } = {},
): BuildingIndex {
  if (collection.type !== 'FeatureCollection') {
    throw new Error('building fixture must be a GeoJSON FeatureCollection')
  }
  const cellSizeM = options.cellSizeM ?? DEFAULT_CELL_M
  if (!Number.isFinite(cellSizeM) || cellSizeM <= 0) {
    throw new Error('building grid cellSizeM must be positive')
  }

  const projector = makeProjector(collection.features)
  const buildings = collection.features.map((feature, index) => prepare(feature, index, projector))
  const buckets = new Map<string, number[]>()
  for (const building of buildings) {
    const minX = Math.floor(building.bounds.minX / cellSizeM)
    const maxX = Math.floor(building.bounds.maxX / cellSizeM)
    const minY = Math.floor(building.bounds.minY / cellSizeM)
    const maxY = Math.floor(building.bounds.maxY / cellSizeM)
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const key = cellKey(x, y)
        const bucket = buckets.get(key)
        if (bucket) bucket.push(building.index)
        else buckets.set(key, [building.index])
      }
    }
  }

  const candidateIndicesForRay = (a: LatLng, b: LatLng): readonly number[] => {
    const found = new Set<number>()
    const start = projector.project(a.lat, a.lng)
    const end = projector.project(b.lat, b.lng)
    for (const cell of ddaCells(start, end, cellSizeM)) {
      for (const index of buckets.get(cellKey(cell.x, cell.y)) ?? []) found.add(index)
    }
    return [...found].sort((left, right) => left - right)
  }

  const surfaceAt = (lat: number, lng: number): BuildingSurfaceHit | null => {
    const point = projector.project(lat, lng)
    const key = cellKey(Math.floor(point.x / cellSizeM), Math.floor(point.y / cellSizeM))
    let hit: Prepared | null = null
    for (const index of buckets.get(key) ?? []) {
      const building = buildings[index]
      if (!boundsContain(building.bounds, point) || !multiContains(building.polygons, point)) continue
      if (
        hit === null
        || building.topMslM > hit.topMslM
        || (building.topMslM === hit.topMslM && building.index < hit.index)
      ) hit = building
    }
    return hit === null ? null : { ...summary(hit), at: { lat, lng } }
  }

  const intersectRay = (a: Point3D, b: Point3D): BuildingLosResult => {
    // Canonical order makes a-to-b exactly equal to b-to-a, including blockedAt.
    const [start, end] = canonical(a, b)
    const projectedStart = projector.project(start.lat, start.lng)
    const projectedEnd = projector.project(end.lat, end.lng)
    let clearanceM = Infinity
    let blocker: BuildingBlocker | null = null
    for (const index of candidateIndicesForRay(start, end)) {
      const building = buildings[index]
      const sample = lowestInside(
        projectedStart,
        projectedEnd,
        start.altMslM,
        end.altMslM,
        building.polygons,
      )
      if (sample === null) continue
      const clearance = sample.altMslM - building.topMslM
      clearanceM = Math.min(clearanceM, clearance)
      if (clearance >= 0) continue // exact roof grazing is clear
      if (
        blocker !== null
        && (clearance > blocker.clearanceM
          || (clearance === blocker.clearanceM && building.index > blocker.index))
      ) continue
      blocker = {
        ...summary(building),
        blockedAt: projector.unproject(sample.point),
        rayHeightMslM: sample.altMslM,
        clearanceM: clearance,
      }
    }
    return { clear: blocker === null, blocker, clearanceM }
  }

  return {
    cellSizeM,
    buildingCount: buildings.length,
    cellCount: buckets.size,
    maxTopM: buildings.length
      ? Math.max(...buildings.map((building) => building.topMslM))
      : 0,
    topAt: (lat, lng) => surfaceAt(lat, lng)?.topMslM ?? null,
    surfaceAt,
    intersectRay,
    candidateIndicesForRay,
  }
}

function makeProjector(features: readonly BuildingFeature[]): Projector {
  const positions: GeoJsonPosition[] = []
  for (const feature of features) {
    const polygons: readonly (readonly (readonly GeoJsonPosition[])[])[] =
      feature.geometry.type === 'Polygon'
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates
    for (const polygon of polygons) {
      if (polygon.length === 0) throw new Error('building polygon must have an exterior ring')
      for (const ring of polygon) {
        if (ring.length < 4) throw new Error('building ring must have at least four positions')
        for (const position of ring) {
          coordinate(position, 0)
          coordinate(position, 1)
          positions.push(position)
        }
      }
    }
  }
  const lngs = positions.map((position) => coordinate(position, 0))
  const lats = positions.map((position) => coordinate(position, 1))
  const originLng = lngs.length ? (Math.min(...lngs) + Math.max(...lngs)) / 2 : 0
  const originLat = lats.length ? (Math.min(...lats) + Math.max(...lats)) / 2 : 0
  const lngScale = EARTH_RADIUS_M * Math.cos(originLat * DEG_TO_RAD)
  return {
    project: (lat, lng) => ({
      x: (lng - originLng) * DEG_TO_RAD * lngScale,
      y: (lat - originLat) * DEG_TO_RAD * EARTH_RADIUS_M,
    }),
    unproject: ({ x, y }) => ({
      lat: originLat + y / EARTH_RADIUS_M / DEG_TO_RAD,
      lng: originLng + x / lngScale / DEG_TO_RAD,
    }),
  }
}

function prepare(feature: BuildingFeature, index: number, projector: Projector): Prepared {
  const { h, hSrc, base } = feature.properties
  if (!Number.isFinite(h) || h < 0) throw new Error('building ' + index + ' has an invalid height')
  if (!Number.isFinite(base)) throw new Error('building ' + index + ' has an invalid base')
  if (hSrc !== 'measured' && hSrc !== 'inferred') {
    throw new Error('building ' + index + ' has an invalid height source')
  }
  const source: readonly (readonly (readonly GeoJsonPosition[])[])[] =
    feature.geometry.type === 'Polygon'
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates
  const polygons = source.map((polygon) => polygon.map((ring) => {
    const projected = ring.map((position) =>
      projector.project(coordinate(position, 1), coordinate(position, 0)))
    const last = projected[projected.length - 1]
    return projected.length > 1 && same(projected[0], last) ? projected.slice(0, -1) : projected
  }))
  const points = polygons.flat(2)
  return {
    id: feature.id ?? index,
    index,
    h,
    hSrc,
    base,
    topMslM: base + h,
    polygons,
    bounds: {
      minX: Math.min(...points.map((point) => point.x)),
      minY: Math.min(...points.map((point) => point.y)),
      maxX: Math.max(...points.map((point) => point.x)),
      maxY: Math.max(...points.map((point) => point.y)),
    },
  }
}

/** Supercover DDA includes both side cells when the ray crosses a grid corner. */
function ddaCells(start: XY, end: XY, size: number): readonly XY[] {
  let x = Math.floor(start.x / size)
  let y = Math.floor(start.y / size)
  const endX = Math.floor(end.x / size)
  const endY = Math.floor(end.y / size)
  const result: XY[] = []
  const seen = new Set<string>()
  const push = (cellX: number, cellY: number) => {
    const key = cellKey(cellX, cellY)
    if (!seen.has(key)) {
      seen.add(key)
      result.push({ x: cellX, y: cellY })
    }
  }
  push(x, y)
  const dx = end.x - start.x
  const dy = end.y - start.y
  const stepX = Math.sign(dx)
  const stepY = Math.sign(dy)
  const deltaX = stepX === 0 ? Infinity : size / Math.abs(dx)
  const deltaY = stepY === 0 ? Infinity : size / Math.abs(dy)
  let maxX = stepX === 0
    ? Infinity
    : ((stepX > 0 ? (x + 1) * size : x * size) - start.x) / dx
  let maxY = stepY === 0
    ? Infinity
    : ((stepY > 0 ? (y + 1) * size : y * size) - start.y) / dy
  while (x !== endX || y !== endY) {
    if (Math.abs(maxX - maxY) <= T_EPS) {
      if (stepX !== 0) push(x + stepX, y)
      if (stepY !== 0) push(x, y + stepY)
      x += stepX
      y += stepY
      maxX += deltaX
      maxY += deltaY
    } else if (maxX < maxY) {
      x += stepX
      maxX += deltaX
    } else {
      y += stepY
      maxY += deltaY
    }
    push(x, y)
  }
  return result
}

function lowestInside(
  start: XY,
  end: XY,
  startAlt: number,
  endAlt: number,
  polygons: readonly Polygon[],
): { point: XY; altMslM: number } | null {
  if (same(start, end)) {
    return multiContains(polygons, start) ? { point: start, altMslM: startAlt } : null
  }
  const parameters = [0, 1]
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let i = 0; i < ring.length; i++) {
        parameters.push(...intersectionTs(start, end, ring[i], ring[(i + 1) % ring.length]))
      }
    }
  }
  parameters.sort((left, right) => left - right)
  const unique = parameters.filter(
    (value, index) => index === 0 || Math.abs(value - parameters[index - 1]) > T_EPS,
  )
  const inside = unique.filter((t) => multiContains(polygons, lerp(start, end, t)))
  for (let i = 0; i < unique.length - 1; i++) {
    const mid = (unique[i] + unique[i + 1]) / 2
    if (multiContains(polygons, lerp(start, end, mid))) inside.push(unique[i], unique[i + 1])
  }
  if (inside.length === 0) return null
  const t = endAlt < startAlt ? Math.max(...inside) : Math.min(...inside)
  return { point: lerp(start, end, t), altMslM: startAlt + (endAlt - startAlt) * t }
}

function intersectionTs(a: XY, b: XY, c: XY, d: XY): number[] {
  const ray = subtract(b, a)
  const edge = subtract(d, c)
  const offset = subtract(c, a)
  const denominator = cross(ray, edge)
  if (Math.abs(denominator) <= XY_EPS) {
    if (Math.abs(cross(offset, ray)) > XY_EPS) return []
    const lengthSquared = dot(ray, ray)
    if (lengthSquared === 0) return []
    const t0 = dot(offset, ray) / lengthSquared
    const t1 = dot(subtract(d, a), ray) / lengthSquared
    const low = Math.max(0, Math.min(t0, t1))
    const high = Math.min(1, Math.max(t0, t1))
    return low <= high + T_EPS ? [clamp(low), clamp(high)] : []
  }
  const t = cross(offset, edge) / denominator
  const u = cross(offset, ray) / denominator
  return t >= -T_EPS && t <= 1 + T_EPS && u >= -T_EPS && u <= 1 + T_EPS
    ? [clamp(t)]
    : []
}

/** Returns -1 outside, 0 on boundary, 1 inside. */
function ringRelation(ring: Ring, point: XY): -1 | 0 | 1 {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]
    const b = ring[i]
    if (onSegment(point, a, b)) return 0
    if ((a.y > point.y) !== (b.y > point.y)) {
      const crossingX = a.x + (point.y - a.y) * (b.x - a.x) / (b.y - a.y)
      if (crossingX > point.x) inside = !inside
    }
  }
  return inside ? 1 : -1
}

function multiContains(polygons: readonly Polygon[], point: XY): boolean {
  return polygons.some((polygon) => {
    const exterior = ringRelation(polygon[0], point)
    if (exterior < 0) return false
    if (exterior === 0) return true
    for (const hole of polygon.slice(1)) {
      const relation = ringRelation(hole, point)
      if (relation === 0) return true // the hole boundary remains the structure wall
      if (relation > 0) return false
    }
    return true
  })
}

function onSegment(point: XY, a: XY, b: XY): boolean {
  const edge = subtract(b, a)
  const length = Math.hypot(edge.x, edge.y)
  if (length === 0) return same(point, a)
  if (Math.abs(cross(subtract(point, a), edge)) / length > XY_EPS) return false
  return dot(subtract(point, a), subtract(point, b)) <= XY_EPS
}

function canonical(a: Point3D, b: Point3D): [Point3D, Point3D] {
  if (a.lat !== b.lat) return a.lat < b.lat ? [a, b] : [b, a]
  if (a.lng !== b.lng) return a.lng < b.lng ? [a, b] : [b, a]
  return a.altMslM <= b.altMslM ? [a, b] : [b, a]
}

function summary(building: Prepared): BuildingSummary {
  const { id, index, h, hSrc, base, topMslM } = building
  return { id, index, h, hSrc, base, topMslM }
}

function coordinate(position: GeoJsonPosition, index: 0 | 1): number {
  const value = position[index]
  if (!Number.isFinite(value)) {
    throw new Error('building coordinates must contain finite longitude and latitude')
  }
  return value
}

function boundsContain(bounds: Bounds, point: XY): boolean {
  return point.x >= bounds.minX - XY_EPS && point.x <= bounds.maxX + XY_EPS
    && point.y >= bounds.minY - XY_EPS && point.y <= bounds.maxY + XY_EPS
}
function same(a: XY, b: XY): boolean {
  return Math.abs(a.x - b.x) <= XY_EPS && Math.abs(a.y - b.y) <= XY_EPS
}
function subtract(a: XY, b: XY): XY { return { x: a.x - b.x, y: a.y - b.y } }
function cross(a: XY, b: XY): number { return a.x * b.y - a.y * b.x }
function dot(a: XY, b: XY): number { return a.x * b.x + a.y * b.y }
function lerp(a: XY, b: XY, t: number): XY {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}
function clamp(value: number): number { return Math.max(0, Math.min(1, value)) }
function cellKey(x: number, y: number): string { return x + ',' + y }
