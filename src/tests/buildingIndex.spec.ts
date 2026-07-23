import { describe, expect, it } from 'vitest'
import {
  createBuildingIndex,
  type BuildingFeature,
  type BuildingFeatureCollection,
  type GeoJsonPosition,
} from '@/sim/terrain/buildingIndex'
import type { Point3D } from '@/sim/terrain/terrainRaster'

const EARTH_RADIUS_M = 6_371_008.8
const DEG_TO_RAD = Math.PI / 180
const degrees = (metres: number) => metres / EARTH_RADIUS_M / DEG_TO_RAD
const position = (xM: number, yM: number): GeoJsonPosition => [degrees(xM), degrees(yM)]
const ring = (minX: number, minY: number, maxX: number, maxY: number): GeoJsonPosition[] => [
  position(minX, minY),
  position(maxX, minY),
  position(maxX, maxY),
  position(minX, maxY),
  position(minX, minY),
]

function polygon(
  id: string,
  bounds: [number, number, number, number],
  topMslM: number,
  hSrc: 'measured' | 'inferred' = 'measured',
  holes: GeoJsonPosition[][] = [],
): BuildingFeature {
  const base = 10
  return {
    type: 'Feature',
    id,
    properties: { h: topMslM - base, hSrc, base },
    geometry: { type: 'Polygon', coordinates: [ring(...bounds), ...holes] },
  }
}

function fixture(...features: BuildingFeature[]): BuildingFeatureCollection {
  return { type: 'FeatureCollection', features }
}

function point(xM: number, yM: number, altMslM: number): Point3D {
  return { lat: degrees(yM), lng: degrees(xM), altMslM }
}

describe('buildingIndex GeoJSON and surface lookup', () => {
  it('indexes a Polygon and preserves inferred height provenance', () => {
    const index = createBuildingIndex(fixture(
      polygon('station', [20, 20, 80, 80], 45, 'inferred'),
    ))

    expect(index.cellSizeM).toBe(100)
    expect(index.buildingCount).toBe(1)
    expect(index.maxTopM).toBe(45)
    expect(index.topAt(degrees(50), degrees(50))).toBe(45)
    expect(index.surfaceAt(degrees(50), degrees(50))).toMatchObject({
      id: 'station',
      index: 0,
      base: 10,
      h: 35,
      hSrc: 'inferred',
      topMslM: 45,
    })
    expect(index.topAt(degrees(5), degrees(5))).toBeNull()
  })

  it('supports Polygon holes and keeps the hole boundary as a structure wall', () => {
    const index = createBuildingIndex(fixture(
      polygon('courtyard', [0, 0, 100, 100], 40, 'measured', [ring(35, 35, 65, 65)]),
    ))

    expect(index.topAt(degrees(20), degrees(20))).toBe(40)
    expect(index.topAt(degrees(50), degrees(50))).toBeNull()
    expect(index.topAt(degrees(50), degrees(35))).toBe(40)
  })

  it('supports both lobes of a MultiPolygon and leaves the gap open', () => {
    const campus: BuildingFeature = {
      type: 'Feature',
      id: 'campus',
      properties: { h: 25, hSrc: 'measured', base: 5 },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [ring(-180, 0, -130, 50)],
          [ring(130, 0, 180, 50)],
        ],
      },
    }
    const index = createBuildingIndex(fixture(campus))

    expect(index.topAt(degrees(25), degrees(-150))).toBe(30)
    expect(index.topAt(degrees(25), degrees(150))).toBe(30)
    expect(index.topAt(degrees(25), degrees(0))).toBeNull()
  })

  it('selects the highest overlapping roof and breaks equal-height ties by input order', () => {
    const index = createBuildingIndex(fixture(
      polygon('low', [0, 0, 100, 100], 30),
      polygon('high-first', [25, 25, 75, 75], 60),
      polygon('high-later', [25, 25, 75, 75], 60),
    ))

    expect(index.surfaceAt(degrees(50), degrees(50))).toMatchObject({
      id: 'high-first',
      index: 1,
      topMslM: 60,
    })
  })
})

describe('buildingIndex 100 m grid and DDA', () => {
  it('reduces ray candidates to buildings bucketed in traversed cells', () => {
    const index = createBuildingIndex(fixture(
      polygon('near', [10, -20, 190, 20], 50),
      polygon('far-north', [10, 280, 60, 330], 50),
      polygon('far-east', [510, -20, 560, 20], 50),
    ))

    const candidates = index.candidateIndicesForRay(point(-50, 0, 0), point(250, 0, 0))
    expect(candidates).toEqual([0])
    expect(index.cellCount).toBeGreaterThan(3)
  })

  it('supercovers both side cells when a diagonal crosses an exact grid corner', () => {
    // Symmetric extents pin the local projection origin to (0,0). Neither footprint lies on
    // y=x; each sits in one of the two side cells touched only at the origin grid corner.
    const index = createBuildingIndex(fixture(
      polygon('north-west', [-95, 5, -55, 45], 50),
      polygon('south-east', [55, -45, 95, -5], 50),
    ))

    expect(index.candidateIndicesForRay(point(-150, -150, 0), point(150, 150, 0)))
      .toEqual([0, 1])
  })
})

describe('buildingIndex deterministic LOS', () => {
  const tower = polygon('tower-7', [40, -20, 80, 20], 70, 'measured')
  const index = createBuildingIndex(fixture(tower))

  it('returns measured blocker metadata for a ray below the roof', () => {
    const result = index.intersectRay(point(0, 0, 50), point(120, 0, 50))

    expect(result.clear).toBe(false)
    expect(result.clearanceM).toBeCloseTo(-20, 6)
    expect(result.blocker).toMatchObject({
      id: 'tower-7',
      index: 0,
      base: 10,
      h: 60,
      hSrc: 'measured',
      topMslM: 70,
      rayHeightMslM: 50,
      clearanceM: -20,
    })
    expect(result.blocker!.blockedAt.lng).toBeCloseTo(degrees(40), 8)
  })

  it('reports clear above the roof, at exact grazing, and when no footprint is crossed', () => {
    expect(index.intersectRay(point(0, 0, 75), point(120, 0, 75))).toEqual({
      clear: true,
      blocker: null,
      clearanceM: 5,
    })
    expect(index.intersectRay(point(0, 0, 70), point(120, 0, 70))).toEqual({
      clear: true,
      blocker: null,
      clearanceM: 0,
    })
    expect(index.intersectRay(point(0, 100, 50), point(120, 100, 50))).toEqual({
      clear: true,
      blocker: null,
      clearanceM: Infinity,
    })
  })

  it('tests the lowest ray height inside the footprint rather than only its entry', () => {
    const result = index.intersectRay(point(0, 0, 100), point(120, 0, 40))

    expect(result.blocker!.rayHeightMslM).toBeCloseTo(60, 6)
    expect(result.blocker!.clearanceM).toBeCloseTo(-10, 6)
    expect(result.blocker!.blockedAt.lng).toBeCloseTo(degrees(80), 8)
  })

  it('leaves a ray clear when it stays within a Polygon hole', () => {
    const courtyard = createBuildingIndex(fixture(
      polygon('courtyard', [0, 0, 100, 100], 80, 'measured', [ring(30, 30, 70, 70)]),
    ))

    expect(courtyard.intersectRay(point(40, 50, 20), point(60, 50, 20))).toEqual({
      clear: true,
      blocker: null,
      clearanceM: Infinity,
    })
  })

  it('selects the deepest blocker and breaks exact ties by feature order', () => {
    const buildings = createBuildingIndex(fixture(
      polygon('first', [20, -20, 40, 20], 80),
      polygon('deepest', [60, -20, 80, 20], 100, 'inferred'),
      polygon('same-depth-later', [60, -20, 80, 20], 100),
    ))

    expect(buildings.intersectRay(point(0, 0, 50), point(100, 0, 50)).blocker)
      .toMatchObject({ id: 'deepest', index: 1, hSrc: 'inferred', clearanceM: -50 })
  })

  it('returns exactly reciprocal blocked and clear results', () => {
    const lowA = point(0, 0, 100)
    const lowB = point(120, 0, 40)
    expect(index.intersectRay(lowA, lowB)).toEqual(index.intersectRay(lowB, lowA))

    const highA = point(0, 0, 100)
    const highB = point(120, 0, 100)
    expect(index.intersectRay(highA, highB)).toEqual(index.intersectRay(highB, highA))
  })

  it('is deterministic across independent indexes and handles zero-length rays', () => {
    const a = point(0, 0, 100)
    const b = point(120, 0, 40)
    expect(createBuildingIndex(fixture(tower)).intersectRay(a, b)).toEqual(index.intersectRay(a, b))

    const inside = point(50, 0, 50)
    expect(index.intersectRay(inside, inside).blocker)
      .toMatchObject({ id: 'tower-7', clearanceM: -20 })
    const outside = point(0, 0, 50)
    expect(index.intersectRay(outside, outside)).toEqual({
      clear: true,
      blocker: null,
      clearanceM: Infinity,
    })
  })
})
