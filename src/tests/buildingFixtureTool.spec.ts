import { describe, expect, it } from 'vitest'
// Authoring tools are intentionally plain Node ESM and are not part of the app TS build.
// @ts-expect-error no declaration file is shipped for the authoring-only module
import { normalizeOvertureBuildings, OVERTURE_CLIENT_VERSION, OVERTURE_DATA_RELEASE, OVERTURE_SCHEMA_VERSION, OVERTURE_STAC_COLLECTION, simplifyClosedRing } from '../../tools/fixtures/buildings.mjs'

describe('Overture building fixture authoring tool', () => {
  it('pins the exact source catalog and authoring client', () => {
    expect(OVERTURE_DATA_RELEASE).toBe('2026-06-17.0')
    expect(OVERTURE_SCHEMA_VERSION).toBe('v1.17.0')
    expect(OVERTURE_CLIENT_VERSION).toBe('1.0.1')
    expect(OVERTURE_STAC_COLLECTION).toBe(
      'https://stac.overturemaps.org/2026-06-17.0/buildings/building/collection.json',
    )
  })

  it('keeps measured and floor-inferred heights while rejecting unknown heights', () => {
    const raw = {
      type: 'FeatureCollection',
      features: [
        feature('measured', { height: 18.4 }, square(-122.24, 37.9)),
        feature('floors', { num_floors: 4 }, square(-122.241, 37.901)),
        feature('unknown', {}, square(-122.242, 37.902)),
      ],
    }

    const result = normalizeOvertureBuildings(raw, { groundElevation: () => 123.456 })

    expect(result.stats).toEqual({ input: 3, output: 2, noHeight: 1, noTerrain: 0, invalidGeometry: 0 })
    expect(result.collection.features.map((item: { properties: unknown }) => item.properties)).toEqual([
      { h: 12, hSrc: 'inferred', base: 123.5 },
      { h: 18.4, hSrc: 'measured', base: 123.5 },
    ])
  })

  it('supports MultiPolygon and excludes footprints outside sourced terrain', () => {
    const raw = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'multi',
          properties: { height: 9 },
          geometry: { type: 'MultiPolygon', coordinates: [[square(-122.24, 37.9)], [square(-122.23, 37.91)]] },
        },
        feature('outside', { height: 8 }, square(-130, 40)),
      ],
    }

    const result = normalizeOvertureBuildings(raw, {
      groundElevation: (lat: number, lng: number) => lng < -125 ? undefined : lat * 2,
    })

    expect(result.stats.output).toBe(1)
    expect(result.stats.noTerrain).toBe(1)
    expect(result.collection.features[0].geometry.type).toBe('MultiPolygon')
  })

  it('simplifies closed rings to at most ten coordinates deterministically', () => {
    const ring = Array.from({ length: 30 }, (_, i) => [i, i * i])
    ring.push([...ring[0]])
    const first = simplifyClosedRing(ring)
    const second = simplifyClosedRing(ring)

    expect(first).toEqual(second)
    expect(first).toHaveLength(10)
    expect(first?.[0]).toEqual(first?.at(-1))
  })
})

function feature(id: string, properties: Record<string, number>, ring: number[][]) {
  return { type: 'Feature', id, properties, geometry: { type: 'Polygon', coordinates: [ring] } }
}

function square(lng: number, lat: number): number[][] {
  return [[lng, lat], [lng + 0.0001, lat], [lng + 0.0001, lat + 0.0001], [lng, lat + 0.0001], [lng, lat]]
}
