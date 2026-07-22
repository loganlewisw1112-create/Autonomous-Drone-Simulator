/**
 * OcclusionService — terrain LOS geometry (REALISM_ROADMAP WP-4 / §4.1, §4.5).
 *
 * WP-4's accept criterion 2 asks for 12 hand-authored geometry cases. They are hand-authored
 * against a SYNTHETIC raster rather than the real fixture on purpose: a case whose expected
 * answer is "blocked by a 200 m plateau, clearance exactly -0.5 m" is only a real test if the
 * terrain is exactly what the test says it is. The committed Grizzly Peak DEM is then used
 * separately, at the bottom, to prove the same code path works on real data.
 *
 * The building half of WP-4 (§4.4) is a separate track. Its seam — `StructureLayer` — is
 * exercised here so the interface is proved to work before the Overture pipeline lands.
 */
import { describe, it, expect } from 'vitest'
import {
  createTerrainOcclusionService,
  occlusionEpoch,
  OCCLUSION_UPDATE_HZ,
  type StructureLayer,
} from '@/sim/terrain/OcclusionService'
import { sampleCenterLatLng, type Point3D, type TerrainRaster } from '@/sim/terrain/terrainRaster'
import { occlusionServiceFor, terrainRasterFor } from '@/scenarios/terrainFixtures'

// ---------------------------------------------------------------------------------------
// Synthetic terrain: a flat 100 m plain with a 200 m plateau ridge running north–south.
//
// A plateau rather than a knife-edge peak because the ray is sampled at a fixed step: with a
// one-pixel summit, whether a sample lands exactly on the crest depends on the endpoint spacing,
// and the test would be asserting sampling luck. The plateau is ~88 m of uniform 200 m ground,
// wide enough that several samples always land inside it, and (given the exact-lerp bilinear)
// each of those samples reads exactly 200.000 m — which is what makes the grazing cases exact.
// Elevation is a function of column only, so the Mercator row mapping cannot affect the result.
// ---------------------------------------------------------------------------------------

const WIDTH = 201
const HEIGHT = 21
const BOUNDS = { west: -122.3, south: 37.899, east: -122.28, north: 37.901 }
const PLAIN_M = 100
const RIDGE_M = 200
const RIDGE_COL_MIN = 95
const RIDGE_COL_MAX = 105

function syntheticRaster(): TerrainRaster {
  const elevations = new Float32Array(WIDTH * HEIGHT)
  for (let row = 0; row < HEIGHT; row++) {
    for (let col = 0; col < WIDTH; col++) {
      elevations[row * WIDTH + col] = col >= RIDGE_COL_MIN && col <= RIDGE_COL_MAX ? RIDGE_M : PLAIN_M
    }
  }
  return {
    width: WIDTH,
    height: HEIGHT,
    bounds: BOUNDS,
    // 0.02° of longitude at 37.9°N ≈ 1757 m over 201 samples.
    metersPerPixel: 8.74,
    surface: 'dtm-approx',
    minElevationM: PLAIN_M,
    maxElevationM: RIDGE_M,
    elevations,
  }
}

const raster = syntheticRaster()
const svc = createTerrainOcclusionService(raster)

const MID_ROW = Math.floor(HEIGHT / 2)
const at = (col: number, altMslM: number): Point3D => {
  const c = sampleCenterLatLng(raster, col, MID_ROW)
  return { lat: c.lat, lng: c.lng, altMslM }
}

// West of the ridge, east of the ridge, and a point on the ridge itself.
const WEST = 10
const EAST = 190
const ON_RIDGE = 100

describe('OcclusionService — elevation and surface', () => {
  it('returns bare-earth ground on the plain and on the ridge', () => {
    expect(svc.groundElevation(at(WEST, 0).lat, at(WEST, 0).lng)).toBe(PLAIN_M)
    expect(svc.groundElevation(at(ON_RIDGE, 0).lat, at(ON_RIDGE, 0).lng)).toBe(RIDGE_M)
  })

  it('surfaceHeight equals groundElevation while there is no structure layer (§4.4 pending)', () => {
    for (const col of [WEST, ON_RIDGE, EAST]) {
      const p = at(col, 0)
      expect(svc.surfaceHeight(p.lat, p.lng)).toBe(svc.groundElevation(p.lat, p.lng))
    }
  })

  it('reports height above ground for AGL consumers', () => {
    expect(svc.heightAboveGround(at(WEST, 130))).toBe(30)
    expect(svc.heightAboveGround(at(ON_RIDGE, 130))).toBe(-70) // 130 m MSL is *inside* the ridge
  })
})

describe('WP-4 accept criterion 2 — hand-authored LOS geometry', () => {
  // 1
  it('flat plain, both endpoints airborne → clear', () => {
    const r = svc.hasLineOfSight(at(WEST, 150), at(WEST + 40, 150))
    expect(r.clear).toBe(true)
    expect(r.blockedBy).toBeNull()
    expect(r.blockHeight).toBeNull()
    expect(r.clearanceM).toBeCloseTo(50, 6)
  })

  // 2
  it('ridge between the endpoints, ray below the crest → blocked by terrain', () => {
    const r = svc.hasLineOfSight(at(WEST, 150), at(EAST, 150))
    expect(r.clear).toBe(false)
    expect(r.blockedBy).toBe('terrain')
    expect(r.clearanceM).toBeCloseTo(-50, 6)
  })

  // 3
  it('same ridge, ray well above the crest → clear', () => {
    const r = svc.hasLineOfSight(at(WEST, 250), at(EAST, 250))
    expect(r.clear).toBe(true)
    expect(r.clearanceM).toBeCloseTo(50, 6)
  })

  // 4
  it('ray grazing the summit exactly → clear at zero margin', () => {
    const r = svc.hasLineOfSight(at(WEST, RIDGE_M), at(EAST, RIDGE_M))
    expect(r.clear).toBe(true)
    expect(r.clearanceM).toBe(0)
  })

  // 5
  it('ray half a metre below the summit → blocked', () => {
    const r = svc.hasLineOfSight(at(WEST, RIDGE_M - 0.5), at(EAST, RIDGE_M - 0.5))
    expect(r.clear).toBe(false)
    expect(r.clearanceM).toBeCloseTo(-0.5, 6)
  })

  // 6
  it('ray half a metre above the summit → clear', () => {
    const r = svc.hasLineOfSight(at(WEST, RIDGE_M + 0.5), at(EAST, RIDGE_M + 0.5))
    expect(r.clear).toBe(true)
    expect(r.clearanceM).toBeCloseTo(0.5, 6)
  })

  // 7
  it('both endpoints underground → blocked', () => {
    const r = svc.hasLineOfSight(at(WEST, 50), at(WEST + 30, 50))
    expect(r.clear).toBe(false)
    expect(r.blockedBy).toBe('terrain')
    expect(r.clearanceM).toBeCloseTo(-50, 6)
  })

  // 8
  it('one endpoint underground → blocked', () => {
    const r = svc.hasLineOfSight(at(WEST, 150), at(WEST + 30, 50))
    expect(r.clear).toBe(false)
    expect(r.clearanceM).toBeLessThan(0)
  })

  // 9
  it('zero-length ray above ground → clear', () => {
    const p = at(WEST, 150)
    const r = svc.hasLineOfSight(p, { ...p })
    expect(r.clear).toBe(true)
    expect(r.clearanceM).toBeCloseTo(50, 6)
  })

  // 10
  it('zero-length ray underground → blocked', () => {
    const p = at(WEST, 50)
    const r = svc.hasLineOfSight(p, { ...p })
    expect(r.clear).toBe(false)
    expect(r.clearanceM).toBeCloseTo(-50, 6)
  })

  // 11 — reciprocity is a correctness requirement: RF and thermal ask from either end.
  it('reciprocity: a→b is identical to b→a when blocked', () => {
    const a = at(WEST, 150)
    const b = at(EAST, 150)
    expect(svc.hasLineOfSight(a, b)).toEqual(svc.hasLineOfSight(b, a))
  })

  // 12
  it('reciprocity: a→b is identical to b→a when clear', () => {
    const a = at(WEST, 250)
    const b = at(EAST, 250)
    expect(svc.hasLineOfSight(a, b)).toEqual(svc.hasLineOfSight(b, a))
  })

  // 13
  it('reports the blocking surface height and where it is', () => {
    const r = svc.hasLineOfSight(at(WEST, 150), at(EAST, 150))
    expect(r.blockHeight).toBe(RIDGE_M)
    expect(r.blockedAt).not.toBeNull()
    const ridgeWest = sampleCenterLatLng(raster, RIDGE_COL_MIN, MID_ROW).lng
    const ridgeEast = sampleCenterLatLng(raster, RIDGE_COL_MAX, MID_ROW).lng
    expect(r.blockedAt!.lng).toBeGreaterThanOrEqual(ridgeWest)
    expect(r.blockedAt!.lng).toBeLessThanOrEqual(ridgeEast)
  })

  // 14
  it('a target resting exactly on the ground reads clear at zero margin', () => {
    // The pattern consumers must use: place ground contacts at groundElevation + target height.
    const observer = at(WEST, 160)
    const contact = at(WEST + 25, PLAIN_M)
    const r = svc.hasLineOfSight(observer, contact)
    expect(r.clear).toBe(true)
    expect(r.clearanceM).toBe(0)
  })

  // 15
  it('a descending ray that runs into rising ground is blocked', () => {
    const r = svc.hasLineOfSight(at(WEST, 260), at(ON_RIDGE, 150))
    expect(r.clear).toBe(false)
    expect(r.blockedBy).toBe('terrain')
  })

  // 16
  it('clearance is the minimum along the ray, not the margin at the endpoints', () => {
    // Both endpoints sit 50 m over the plain, but the ridge in between leaves only -50 m.
    const r = svc.hasLineOfSight(at(WEST, 150), at(EAST, 150))
    expect(svc.heightAboveGround(at(WEST, 150))).toBe(50)
    expect(svc.heightAboveGround(at(EAST, 150))).toBe(50)
    expect(r.clearanceM).toBeCloseTo(-50, 6)
  })
})

describe('building seam (§4.4 plugs in here)', () => {
  // A 60 m tower on the plain, three samples wide, well clear of the ridge.
  const towerCols = [40, 41, 42]
  const towerLngs = towerCols.map((c) => sampleCenterLatLng(raster, c, MID_ROW).lng)
  const structures: StructureLayer = {
    topAt: (_lat, lng) =>
      lng >= Math.min(...towerLngs) - 1e-5 && lng <= Math.max(...towerLngs) + 1e-5
        ? PLAIN_M + 60
        : null,
    maxTopM: PLAIN_M + 60,
  }
  const withBuildings = createTerrainOcclusionService(raster, { structures })

  it('surfaceHeight rises to the structure top while groundElevation stays bare earth (§4.2)', () => {
    const p = at(41, 0)
    expect(withBuildings.groundElevation(p.lat, p.lng)).toBe(PLAIN_M)
    expect(withBuildings.surfaceHeight(p.lat, p.lng)).toBe(PLAIN_M + 60)
    // The DTM is untouched — this is exactly what stops AGL becoming height-above-roof.
    expect(svc.surfaceHeight(p.lat, p.lng)).toBe(PLAIN_M)
  })

  it('attributes the block to the structure, not the terrain', () => {
    const r = withBuildings.hasLineOfSight(at(WEST, 140), at(70, 140))
    expect(r.clear).toBe(false)
    expect(r.blockedBy).toBe('building')
    expect(r.blockHeight).toBe(PLAIN_M + 60)
  })

  it('leaves the same ray clear once it is flown over the structure', () => {
    expect(withBuildings.hasLineOfSight(at(WEST, 175), at(70, 175)).clear).toBe(true)
  })

  it('can only report terrain when no structure layer is supplied', () => {
    expect(svc.hasLineOfSight(at(WEST, 140), at(70, 140)).blockedBy).toBeNull()
    expect(svc.hasLineOfSight(at(WEST, 150), at(EAST, 150)).blockedBy).toBe('terrain')
  })
})

describe('skyVisibility — the WP-7 satellite primitive', () => {
  it('sees straight up from open ground', () => {
    expect(svc.skyVisibility(at(WEST, 150), 0, 90)).toBe(true)
  })

  it('is blocked by the ridge at a shallow elevation angle', () => {
    // Looking east from the plain: the ridge is ~740 m away and 100 m above, so ~7.7°.
    expect(svc.skyVisibility(at(WEST, 110), 90, 3)).toBe(false)
  })

  it('clears the same ridge at a steep elevation angle', () => {
    expect(svc.skyVisibility(at(WEST, 110), 90, 45)).toBe(true)
  })

  it('sees nothing from underground', () => {
    expect(svc.skyVisibility(at(WEST, 50), 0, 80)).toBe(false)
  })

  it('rejects elevations at or below the local horizontal', () => {
    expect(svc.skyVisibility(at(WEST, 150), 90, 0)).toBe(false)
    expect(svc.skyVisibility(at(WEST, 150), 90, -10)).toBe(false)
  })

  it('is unblocked looking away from the ridge', () => {
    expect(svc.skyVisibility(at(EAST, 110), 90, 3)).toBe(true)
  })
})

describe('1 Hz cache (§4.5) — must be transparent', () => {
  it('derives the epoch from sim time, never the wall clock', () => {
    expect(OCCLUSION_UPDATE_HZ).toBe(1)
    expect(occlusionEpoch(0)).toBe(0)
    expect(occlusionEpoch(0.95)).toBe(0)
    expect(occlusionEpoch(1)).toBe(1)
    expect(occlusionEpoch(41.7)).toBe(41)
    // Pure: same sim time, same epoch, forever.
    expect(occlusionEpoch(41.7)).toBe(occlusionEpoch(41.7))
  })

  /**
   * The determinism guard. A cache that returns anything other than the cold result is a
   * determinism bug, not an optimisation — §3's whole property is that identical inputs give
   * byte-identical outputs whether a run is fresh, replayed or caught up after a stall.
   */
  it('a cache-warm result equals a cache-cold result', () => {
    const cold = createTerrainOcclusionService(raster)
    const warm = createTerrainOcclusionService(raster)
    const pairs: Array<[Point3D, Point3D]> = [
      [at(WEST, 150), at(EAST, 150)],
      [at(WEST, 250), at(EAST, 250)],
      [at(WEST, RIDGE_M), at(EAST, RIDGE_M)],
      [at(30, 120), at(170, 400)],
      [at(WEST, 50), at(EAST, 50)],
    ]
    // Warm the second service by asking everything twice, in a different order.
    for (let pass = 0; pass < 2; pass++) {
      for (const [a, b] of [...pairs].reverse()) warm.hasLineOfSight(a, b)
    }
    for (const [a, b] of pairs) {
      cold.clearCache()
      expect(warm.hasLineOfSight(a, b)).toEqual(cold.hasLineOfSight(a, b))
    }
    expect(warm.cacheStats().hits).toBeGreaterThan(0)
  })

  it('serves a reciprocal query from the same cache entry', () => {
    const s = createTerrainOcclusionService(raster)
    const a = at(WEST, 150)
    const b = at(EAST, 150)
    s.hasLineOfSight(a, b)
    const before = s.cacheStats()
    const reciprocal = s.hasLineOfSight(b, a)
    const after = s.cacheStats()
    expect(after.hits).toBe(before.hits + 1)
    expect(after.size).toBe(before.size)
    expect(reciprocal).toEqual(s.hasLineOfSight(a, b))
  })

  it('drops the cache when the epoch advances, without changing any answer', () => {
    const s = createTerrainOcclusionService(raster)
    const a = at(WEST, 150)
    const b = at(EAST, 150)
    const first = s.hasLineOfSight(a, b)
    s.setEpoch(occlusionEpoch(3.2))
    expect(s.epoch).toBe(3)
    expect(s.cacheStats().size).toBe(0)
    expect(s.hasLineOfSight(a, b)).toEqual(first)
    // Re-setting the same epoch is a no-op, so it must not evict.
    s.hasLineOfSight(a, b)
    const size = s.cacheStats().size
    s.setEpoch(3)
    expect(s.cacheStats().size).toBe(size)
  })

  it('evicting under a tiny cache limit cannot change a result', () => {
    const unbounded = createTerrainOcclusionService(raster)
    const tiny = createTerrainOcclusionService(raster, { cacheLimit: 1 })
    for (let i = 0; i < 25; i++) {
      const a = at(WEST + i, 150 + i)
      const b = at(EAST - i, 150 + i)
      expect(tiny.hasLineOfSight(a, b)).toEqual(unbounded.hasLineOfSight(a, b))
    }
    expect(tiny.cacheStats().size).toBeLessThanOrEqual(1)
  })

  it('two independently constructed services agree exactly', () => {
    const a = createTerrainOcclusionService(raster)
    const b = createTerrainOcclusionService(raster)
    for (let i = 0; i < 10; i++) {
      const p = at(WEST + i * 3, 120 + i * 7)
      const q = at(EAST - i * 5, 300 - i * 11)
      expect(a.hasLineOfSight(p, q)).toEqual(b.hasLineOfSight(p, q))
      expect(a.skyVisibility(p, i * 36, 5 + i)).toBe(b.skyVisibility(p, i * 36, 5 + i))
    }
  })
})

describe('the committed Grizzly Peak DEM (§4.6)', () => {
  const real = occlusionServiceFor('demo_wildfire')!
  const dem = terrainRasterFor('demo_wildfire')!

  // CAL FIRE staging in Tilden Park and the relay point from the demo_wildfire scenario.
  const STAGING = { lat: 37.8992, lng: -122.2432 }
  const SPOTFIRE_NE = { lat: 37.9005, lng: -122.2335 }

  it('reads plausible East Bay Hills elevations', () => {
    // Independently confirmed against USGS 3DEP in terrainRaster.spec.ts; this pins the AO's
    // relief, which is what makes §4.6's "terrain masking" claim true for this scenario.
    expect(real.groundElevation(STAGING.lat, STAGING.lng)).toBeGreaterThan(340)
    expect(real.groundElevation(STAGING.lat, STAGING.lng)).toBeLessThan(370)
    expect(dem.maxElevationM - dem.minElevationM).toBeGreaterThan(400)
  })

  it('finds real terrain masking between staging and the north-east spotfire', () => {
    const ground = real.groundElevation(STAGING.lat, STAGING.lng)
    const low: Point3D = { ...STAGING, altMslM: ground + 5 }
    const target: Point3D = {
      ...SPOTFIRE_NE,
      altMslM: real.groundElevation(SPOTFIRE_NE.lat, SPOTFIRE_NE.lng) + 5,
    }
    const blocked = real.hasLineOfSight(low, target)
    expect(blocked.clear).toBe(false)
    expect(blocked.blockedBy).toBe('terrain')
    expect(blocked.blockHeight).toBeGreaterThan(ground)

    // Climb both ends above the intervening high ground and the same link comes back — which is
    // precisely the relay-placement decision §4.6 says this AO should force on the operator.
    const high: Point3D = { ...STAGING, altMslM: blocked.blockHeight! + 60 }
    const highTarget: Point3D = { ...SPOTFIRE_NE, altMslM: blocked.blockHeight! + 60 }
    expect(real.hasLineOfSight(high, highTarget).clear).toBe(true)
  })

  /**
   * The cache-transparency test with teeth.
   *
   * The obvious version of "warm equals cold" — ask a handful of well-separated pairs twice —
   * passes even if the cache key is lossy, because well-separated pairs do not collide. And a
   * run-to-run determinism test does not catch it either: a quantised key collides *identically*
   * in both runs, so the two traces still match while both are wrong. (Verified by mutation:
   * rounding the key to 4 decimal places leaves every other test in this file green.)
   *
   * So this fires a dense cluster of near-identical queries — ~1 m apart, the scale at which a
   * lossy key would fold them together — over real terrain whose elevation genuinely varies at
   * that scale, and demands the cached answers match freshly computed ones exactly.
   */
  it('a cache-warm result equals a cache-cold result for near-identical queries', () => {
    const warm = createTerrainOcclusionService(dem)
    const cold = createTerrainOcclusionService(dem, { cacheLimit: 1 })
    const queries: Array<[Point3D, Point3D]> = []
    for (let i = 0; i < 24; i++) {
      // ~1e-5 degrees ≈ 1.1 m: well below one 7.54 m pixel, so these all fold together under
      // any rounded key, yet bilinear sampling gives each a distinct clearance.
      const d = i * 1e-5
      queries.push([
        { lat: STAGING.lat + d, lng: STAGING.lng + d, altMslM: 430 + d },
        { lat: SPOTFIRE_NE.lat - d, lng: SPOTFIRE_NE.lng - d, altMslM: 415 + d },
      ])
    }
    // Warm the cache with every query, then re-ask in a different order.
    for (const [a, b] of queries) warm.hasLineOfSight(a, b)
    for (const [a, b] of [...queries].reverse()) {
      expect(warm.hasLineOfSight(a, b)).toEqual(cold.hasLineOfSight(a, b))
    }
    expect(warm.cacheStats().hits).toBe(queries.length)
    expect(warm.cacheStats().size).toBe(queries.length)

    // And the queries must actually be distinguishable, or the assertion above proves nothing.
    const clearances = new Set(queries.map(([a, b]) => cold.hasLineOfSight(a, b).clearanceM))
    expect(clearances.size).toBe(queries.length)
  })

  it('stays reciprocal on real terrain', () => {
    const a: Point3D = { ...STAGING, altMslM: 420 }
    const b: Point3D = { ...SPOTFIRE_NE, altMslM: 380 }
    expect(real.hasLineOfSight(a, b)).toEqual(real.hasLineOfSight(b, a))
  })

  it('treats a query outside the AO as unobstructed sky rather than inventing terrain', () => {
    const b = dem.bounds
    const outside: Point3D = { lat: b.north - 0.0002, lng: b.east - 0.0002, altMslM: 600 }
    expect(real.skyVisibility(outside, 45, 30)).toBe(true)
  })
})
