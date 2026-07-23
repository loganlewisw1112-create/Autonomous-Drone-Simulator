import type { LatLng } from '@/types'
import { haversineDistanceM, offsetLatLng } from '@/utils/geometry'
import {
  containsLatLng,
  elevationAt,
  type Point3D,
  type TerrainRaster,
} from './terrainRaster'

// Occlusion geometry service (REALISM_ROADMAP WP-4 / §4.1, §4.5).
//
// §4.1's argument is that this is a *service*, not a rendering feature: build the geometry once
// and four scripted subsystems — thermal (WP-5), GNSS (WP-7), RF (WP-8) and flight safety —
// stop being scripted. So the interface below is the one §4.1 specifies, verbatim, and the
// terrain implementation is only one way to satisfy it.
//
// SCOPE OF THIS FILE: terrain only. Buildings (§4.4, Overture footprints + the §4.5 uniform
// 100 m grid with DDA ray marching) are a separate track. They are not stubbed out with fake
// numbers here — they plug in through `StructureLayer`, and until one is supplied
// `surfaceHeight()` is exactly `groundElevation()` and `blockedBy` can only ever be 'terrain'.
// That is honest: the service reports what it actually knows about.
//
// DETERMINISM (§3). Every function here is pure. No wall clock, no Math.random, no module state
// that varies with call order. This matters more here than almost anywhere else in the sim,
// because WP-4 puts an elevation lookup inside every altitude computation, geofence check and
// route audit — the blast radius of a non-deterministic elevation lookup is the whole kernel.
// The cache below is a memo keyed on its exact inputs, so a warm result is bit-identical to a
// cold one; `src/tests/occlusionService.spec.ts` asserts that directly rather than trusting it.

/** What stopped the ray. 'building' becomes reachable once a `StructureLayer` is supplied. */
export type BlockerKind = 'terrain' | 'building'

/** §4.1's `LosResult`, with two fields the downstream packages need (see below). */
export interface LosResult {
  clear: boolean
  blockedBy: BlockerKind | null
  /** Height (m MSL) of the blocking surface at the dominant obstruction; null when clear. */
  blockHeight: number | null
  /** Where the dominant obstruction is; null when clear. Lets the UI point at the ridge. */
  blockedAt: LatLng | null
  /**
   * Minimum (ray height − surface height) over the sampled ray, in metres. Negative exactly
   * when blocked, and its magnitude is the depth of the obstruction. WP-8 (§18.4) needs this
   * directly: the NLOS penalty is "scaled by blocker height above the ray", which is −clearanceM.
   * WP-5 wants the positive side of it — a link that clears a ridge by 2 m is not a link you
   * should present as comfortably clear.
   */
  clearanceM: number
}

/** The interface from §4.1, exactly. */
export interface OcclusionService {
  /** Bare-earth ground, m MSL (§4.2 — a DTM, never a DSM). */
  groundElevation(lat: number, lng: number): number
  /** Ground plus any structure on it, m MSL. */
  surfaceHeight(lat: number, lng: number): number
  hasLineOfSight(a: Point3D, b: Point3D): LosResult
  skyVisibility(from: Point3D, azDeg: number, elDeg: number): boolean
}

/**
 * The seam buildings plug into (§4.4/§4.5).
 *
 * Deliberately tiny: everything the occlusion maths needs from the building layer is "how high
 * is the top of the structure here, if any". The spatial index (uniform 100 m grid + DDA ray
 * march) lives entirely behind this, so it can be added, optimised or swapped without touching
 * a line of the LOS geometry — and the terrain tests below stay valid when it lands.
 */
export interface StructureLayer {
  /** Top of the structure at this position in m MSL, or null for open ground. */
  topAt(lat: number, lng: number): number | null
  /** Highest structure top anywhere in the layer, m MSL — bounds the sky-visibility march. */
  maxTopM: number
  /** Exact footprint/ray intersection. Prevents narrow structures falling between terrain samples. */
  intersectRay?(a: Point3D, b: Point3D): {
    clear: boolean
    blocker: { blockedAt: LatLng; topMslM: number; clearanceM: number } | null
    clearanceM: number
  }
}

export interface OcclusionOptions {
  /** Buildings, when they exist. Omitted ⇒ bare terrain (§4.4 lands separately). */
  structures?: StructureLayer
  /**
   * Ray sampling step in metres. Defaults to the raster's own resolution, which is §4.5's rule:
   * "sample the ray at terrain resolution" — finer buys nothing because the DEM has no detail
   * between samples, and coarser can step straight over a ridge crest.
   */
  stepM?: number
  /** Guard against a pathological ray consuming unbounded time; see MAX_RAY_SAMPLES. */
  maxSamples?: number
  /** Cap on cached LOS results before the cache is dropped wholesale. */
  cacheLimit?: number
}

/**
 * §4.5's key performance decision: occlusion runs at 1 Hz, not on the 50 ms sim tick. Satellite
 * geometry, building shadows and RF paths all change slowly relative to 20 Hz, so this is a 20×
 * saving for zero fidelity loss. Consumers advance the epoch from *sim* time and interpolate
 * between epochs themselves.
 */
export const OCCLUSION_UPDATE_HZ = 1

/**
 * Epoch index for a simulation time. Pure and derived from sim time — which is tick × dt, never
 * the wall clock — so a replay lands on exactly the same epochs as the original run.
 */
export function occlusionEpoch(simTimeSec: number): number {
  return Math.floor(simTimeSec * OCCLUSION_UPDATE_HZ)
}

/** ~30 km of ray at the default 7.5 m step. Beyond this the step stretches instead. */
const MAX_RAY_SAMPLES = 4096
const DEFAULT_CACHE_LIMIT = 4096
const DEG = Math.PI / 180

export interface TerrainOcclusionService extends OcclusionService {
  readonly raster: TerrainRaster
  /** Height above bare ground, m. The primary input to AGL floors (§4.1, flight-safety row). */
  heightAboveGround(point: Point3D): number
  /**
   * Advance the 1 Hz occlusion epoch. Results computed under a previous epoch are dropped, so a
   * moving world is never answered from a stale cache. A no-op when the epoch is unchanged.
   */
  setEpoch(epoch: number): void
  readonly epoch: number
  /** Observability only — never an input to any result. */
  cacheStats(): { size: number; hits: number; misses: number }
  clearCache(): void
}

/**
 * Build the terrain-backed occlusion service over a decoded DEM.
 *
 * `hasLineOfSight` is O(distance / stepM) per §4.5. At the §4.5 budget — 8 drones, ~350 LOS
 * tests/sec across GNSS, thermal and RF — a 5 km ray is ~660 samples, so ~230 k sampled points
 * per second of sim time. That is trivial in JS, and it is only reached because the rate is
 * 1 Hz rather than 20 Hz.
 */
export function createTerrainOcclusionService(
  raster: TerrainRaster,
  options: OcclusionOptions = {},
): TerrainOcclusionService {
  const structures = options.structures
  const stepM = Math.max(1, options.stepM ?? raster.metersPerPixel)
  const maxSamples = Math.max(2, options.maxSamples ?? MAX_RAY_SAMPLES)
  const cacheLimit = Math.max(1, options.cacheLimit ?? DEFAULT_CACHE_LIMIT)

  const losCache = new Map<string, LosResult>()
  let epoch = 0
  let hits = 0
  let misses = 0

  const groundElevation = (lat: number, lng: number): number => elevationAt(raster, lat, lng)

  const surfaceHeight = (lat: number, lng: number): number => {
    const ground = groundElevation(lat, lng)
    if (!structures) return ground
    const top = structures.topAt(lat, lng)
    return top === null || top < ground ? ground : top
  }

  /** Highest surface anywhere — bounds the sky march and lets an obviously-clear ray exit early. */
  const ceilingM = () => (structures ? Math.max(raster.maxElevationM, structures.maxTopM) : raster.maxElevationM)

  /**
   * Order-independent endpoint ordering.
   *
   * Reciprocity (a→b must equal b→a) is a correctness requirement, not a nicety: RF and thermal
   * both ask the question from whichever end is convenient, and an asymmetric answer would show
   * up as a link that exists in one direction only. Sampling from each end would *nearly* agree
   * — the sample set {i/n} is symmetric — but `a + (b−a)·t` and `b + (a−b)·(1−t)` are not
   * bit-identical in floating point. Canonicalising the pair first makes the arithmetic literally
   * the same computation, so reciprocity is exact rather than approximate.
   */
  const canonical = (a: Point3D, b: Point3D): [Point3D, Point3D] => {
    if (a.lat !== b.lat) return a.lat < b.lat ? [a, b] : [b, a]
    if (a.lng !== b.lng) return a.lng < b.lng ? [a, b] : [b, a]
    return a.altMslM <= b.altMslM ? [a, b] : [b, a]
  }

  const computeLos = (p: Point3D, q: Point3D): LosResult => {
    const distM = haversineDistanceM({ lat: p.lat, lng: p.lng }, { lat: q.lat, lng: q.lng })
    // Endpoints are included in the sample set (i = 0…n). That is what makes "both endpoints
    // underground" report blocked, and what lets a contact sitting exactly on the ground read as
    // clear at zero margin rather than as a 1-pixel obstruction.
    const n = Math.min(maxSamples - 1, Math.max(1, Math.ceil(distM / stepM)))

    let minClearance = Infinity
    let worstLat = p.lat
    let worstLng = p.lng
    let worstSurface = 0
    let worstIsStructure = false

    for (let i = 0; i <= n; i++) {
      const t = i / n
      const lat = p.lat + (q.lat - p.lat) * t
      const lng = p.lng + (q.lng - p.lng) * t
      const rayAlt = p.altMslM + (q.altMslM - p.altMslM) * t
      const ground = groundElevation(lat, lng)
      const top = structures ? structures.topAt(lat, lng) : null
      const isStructure = top !== null && top > ground
      const surface = isStructure ? (top as number) : ground
      const clearance = rayAlt - surface
      if (clearance < minClearance) {
        minClearance = clearance
        worstLat = lat
        worstLng = lng
        worstSurface = surface
        worstIsStructure = isStructure
      }
    }

    // Terrain is sampled at DEM resolution, but buildings use exact footprint crossings.
    // A narrow footprint can lie wholly between two DEM samples, so topAt sampling alone is
    // insufficient even though it remains useful for endpoint and surface-height queries.
    const structureRay = structures?.intersectRay?.(p, q)
    if (structureRay && structureRay.clearanceM < minClearance) {
      minClearance = structureRay.clearanceM
      if (structureRay.blocker) {
        worstLat = structureRay.blocker.blockedAt.lat
        worstLng = structureRay.blocker.blockedAt.lng
        worstSurface = structureRay.blocker.topMslM
        worstIsStructure = true
      }
    }

    if (minClearance >= 0) {
      return { clear: true, blockedBy: null, blockHeight: null, blockedAt: null, clearanceM: minClearance }
    }
    return {
      clear: false,
      // The reported blocker is the *deepest* obstruction rather than the first one along the
      // ray. That is order-independent (so it survives canonicalisation), and it is the one
      // §18.4's NLOS penalty actually wants — the ridge that dominates the loss, not whichever
      // hummock the ray happened to clip first.
      blockedBy: worstIsStructure ? 'building' : 'terrain',
      blockHeight: worstSurface,
      blockedAt: { lat: worstLat, lng: worstLng },
      clearanceM: minClearance,
    }
  }

  /**
   * The cache key is the FULL precision of every input, never a rounded or quantised form.
   * Quantising here would be the classic "harmless" optimisation that silently answers one query
   * with another query's result — and because both runs of a replay would collide identically,
   * a run-to-run determinism test would still pass while the answers were wrong. The
   * cache-transparency test in `occlusionService.spec.ts` fires near-identical queries over real
   * terrain precisely to catch that.
   */
  const keyOf = (p: Point3D, q: Point3D) =>
    `${p.lat},${p.lng},${p.altMslM}|${q.lat},${q.lng},${q.altMslM}`

  const hasLineOfSight = (a: Point3D, b: Point3D): LosResult => {
    const [p, q] = canonical(a, b)
    const key = keyOf(p, q)
    const cached = losCache.get(key)
    if (cached) {
      hits++
      return cached
    }
    misses++
    const result = computeLos(p, q)
    // Whole-cache drop rather than an LRU: the entries are already scoped to a 1 Hz epoch, so
    // the cap is a safety valve, not a working-set policy. Because every entry is a pure memo,
    // eviction can only ever cost a recomputation — it can never change an answer.
    if (losCache.size >= cacheLimit) losCache.clear()
    losCache.set(key, result)
    return result
  }

  /**
   * Is the sky visible from `from` along a bearing and elevation angle?
   *
   * This is WP-7's satellite-visibility primitive. It marches outward until the ray is above
   * everything the fixture knows about, or leaves the AO. Leaving the AO returns *visible*: the
   * fixture simply has no evidence of an obstruction out there, and inventing one would be
   * exactly the kind of scripted behaviour WP-4 exists to remove. Consumers that care should
   * size the AO to contain the terrain that matters (§4.3).
   */
  const skyVisibility = (from: Point3D, azDeg: number, elDeg: number): boolean => {
    if (from.altMslM < surfaceHeight(from.lat, from.lng)) return false
    if (elDeg <= 0) return false // at or below the local horizontal — never a usable sky path
    if (elDeg >= 90) return true // straight up, and we already know we are above the surface

    const tanEl = Math.tan(elDeg * DEG)
    const ceiling = ceilingM()
    const b = raster.bounds
    // Diagonal of the AO — no ray can stay inside the raster for longer than this.
    const maxRangeM = haversineDistanceM({ lat: b.south, lng: b.west }, { lat: b.north, lng: b.east })
    const steps = Math.min(maxSamples, Math.max(1, Math.ceil(maxRangeM / stepM)))

    for (let i = 1; i <= steps; i++) {
      const rangeM = i * stepM
      const rayAlt = from.altMslM + rangeM * tanEl
      if (rayAlt > ceiling) return true // above every surface in the fixture; nothing can block it
      const at = offsetLatLng({ lat: from.lat, lng: from.lng }, azDeg, rangeM)
      if (!containsLatLng(raster, at.lat, at.lng)) return true
      if (surfaceHeight(at.lat, at.lng) > rayAlt) return false
    }
    return true
  }

  return {
    raster,
    groundElevation,
    surfaceHeight,
    hasLineOfSight,
    skyVisibility,
    heightAboveGround: (point) => point.altMslM - groundElevation(point.lat, point.lng),
    setEpoch(next) {
      if (next === epoch) return
      epoch = next
      losCache.clear()
    },
    get epoch() {
      return epoch
    },
    cacheStats: () => ({ size: losCache.size, hits, misses }),
    clearCache: () => losCache.clear(),
  }
}
