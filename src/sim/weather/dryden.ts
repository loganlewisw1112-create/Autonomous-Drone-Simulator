import { mulberry32 } from '@/utils/rng'

// Dryden atmospheric turbulence (REALISM_ROADMAP WP-10).
//
// A seeded, deterministic gust generator: band-limited white noise shaped by the Dryden
// longitudinal filter. Dryden (not von Kármán) is the choice with actual multirotor
// precedent and a rational filter that is trivial to realise. This module models the gust
// series only; the second-order couplings WP-10 cares about — battery burn, station-keeping
// failure, sensor stability, wind-limit aborts — are applied by whatever consumes the series.
// It changes no live sim behaviour on its own (the WP-5 pattern): same seed → identical gusts.

const FT_PER_M = 3.28084

export interface DrydenConfig {
  /** Turbulence intensity σ_u (RMS gust, m/s). */
  sigmaMs: number
  /** Dryden length scale L_u (m). */
  lengthScaleM: number
  /** Relative airspeed V over the airframe (m/s). */
  airspeedMs: number
  dtSec: number
}

/**
 * Discrete first-order (longitudinal) Dryden filter as an AR(1): gust[k] = a·gust[k-1] + b·η[k],
 * η ~ N(0,1). `a` sets the correlation time L/V; `b` is chosen so the steady-state variance is
 * exactly σ² ( Var = b²/(1−a²) ). Airspeed is floored so a hovering rotorcraft still sees gusts.
 */
export function drydenCoefficients(cfg: DrydenConfig): { a: number; b: number } {
  const V = Math.max(0.5, cfg.airspeedMs)
  const rho = (V * cfg.dtSec) / Math.max(1e-6, cfg.lengthScaleM)
  const a = Math.min(0.9999, Math.max(0, 1 - rho))
  const b = cfg.sigmaMs * Math.sqrt(Math.max(0, 1 - a * a))
  return { a, b }
}

/** Standard normal sampler from a uniform PRNG (Box–Muller, spare cached). Deterministic. */
function gaussianSampler(rand: () => number): () => number {
  let spare: number | null = null
  return () => {
    if (spare !== null) {
      const s = spare
      spare = null
      return s
    }
    let u = 0
    while (u === 0) u = rand()
    const v = rand()
    const mag = Math.sqrt(-2 * Math.log(u))
    spare = mag * Math.sin(2 * Math.PI * v)
    return mag * Math.cos(2 * Math.PI * v)
  }
}

/** Deterministic gust time-series (m/s), `steps` long. Same seed + config → identical output. */
export function drydenSeries(seed: number, cfg: DrydenConfig, steps: number): number[] {
  const { a, b } = drydenCoefficients(cfg)
  const gauss = gaussianSampler(mulberry32(seed))
  const out: number[] = new Array(steps)
  let g = 0
  for (let i = 0; i < steps; i++) {
    g = a * g + b * gauss()
    out[i] = g
  }
  return out
}

/**
 * MIL-F-8785C low-altitude turbulence (h ≲ 1000 ft): Dryden length scale (m) and along-wind
 * intensity σ_u (m/s) as functions of altitude and the wind at 20 ft. σ falls and the scale
 * length grows with altitude — the altitude dependence WP-10's acceptance checks. Vertical
 * intensity σ_w = 0.1·W20; σ_u = σ_w / (0.177 + 0.000823h)^0.4; L_u = h / (0.177 + 0.000823h)^1.2.
 */
export function lowAltitudeDryden(windAt20ftMs: number, altitudeFt: number): { lengthScaleM: number; sigmaMs: number } {
  const h = Math.max(10, Math.min(1000, altitudeFt))
  const k = 0.177 + 0.000823 * h
  const sigmaW = 0.1 * Math.max(0, windAt20ftMs)
  return {
    lengthScaleM: h / Math.pow(k, 1.2) / FT_PER_M,
    sigmaMs: sigmaW / Math.pow(k, 0.4),
  }
}

/**
 * Wind-limit abort trigger (couples WP-10 to the WP-1 per-airframe gust tolerance): the
 * instantaneous wind the airframe feels is the sustained wind plus the gust, and exceeding the
 * platform's published gust tolerance is a real abort condition.
 */
export function exceedsGustLimit(sustainedWindMs: number, gustMs: number, gustToleranceMs: number): boolean {
  return sustainedWindMs + Math.abs(gustMs) > gustToleranceMs
}

// ─── Live wiring (WP-10) ───────────────────────────────────────────────────────
//
// THE DETERMINISM PROBLEM, AND HOW IT IS SOLVED.
//
// `drydenSeries` is an AR(1) recursion driven by a stateful PRNG. Stepping it once per tick from
// inside the loop would put persistent RNG state in the simulation kernel — exactly what this
// project's determinism guarantee forbids, because sub-stepping and replay would consume draws in
// a different order and diverge. (See how WP-7's GNSS error and WP-8's shadow fading avoid the
// same trap.)
//
// The fix is to make the gust a pure function of tick index. A NORMALISED series (σ = 1, nominal
// correlation) is generated once per (seed, aircraft) and memoised, then scaled per tick by the
// live σ from `lowAltitudeDryden`. So:
//
//   • the SHAPE — the Dryden spectrum and its correlation structure — comes from the cached series
//   • the INTENSITY tracks altitude and wind live, tick by tick
//   • `gustAtTick` is pure: the same tick always yields the same gust, however it was reached
//
// STATED SIMPLIFICATION. The correlation time L/V varies with airspeed and altitude in the full
// model; the cached shape fixes it at a nominal cruise. Intensity — which is what the couplings
// WP-10 actually cares about (battery burn, wind-limit abort) respond to — remains fully live.
// Buying exact time-varying correlation would cost the determinism guarantee, which is a far more
// valuable property than the second-order spectral detail it would buy.

/** Nominal airspeed for the cached gust shape (m/s). */
const NOMINAL_AIRSPEED_MS = 10
/** Nominal Dryden length scale for the cached shape (m), mid-band for low-altitude flight. */
const NOMINAL_LENGTH_SCALE_M = 200
/** Series length: 30 min at 20 Hz, comfortably past any single sortie. */
const SERIES_STEPS = 30 * 60 * 20

/**
 * Memo of normalised gust series, keyed by seed + aircraft. A pure cache: the same key always
 * yields the same array, so a warm read is bit-identical to a cold one and eviction could only
 * ever cost a recomputation. `gustFieldCacheSize` exists for tests and observability only.
 */
const normalizedSeriesCache = new Map<string, readonly number[]>()

/** Unit-variance Dryden gust shape for one aircraft. Deterministic in (seed, droneId). */
export function normalizedGustSeries(seed: number, droneId: string): readonly number[] {
  const key = `${seed}|${droneId}`
  const cached = normalizedSeriesCache.get(key)
  if (cached) return cached
  const series = drydenSeries(hashSeed(key), {
    sigmaMs: 1,
    lengthScaleM: NOMINAL_LENGTH_SCALE_M,
    airspeedMs: NOMINAL_AIRSPEED_MS,
    dtSec: 0.05,
  }, SERIES_STEPS)
  normalizedSeriesCache.set(key, series)
  return series
}

/**
 * Gust (m/s) felt by one aircraft at one tick.
 *
 * Pure in every argument. Altitude and the 20 ft wind set σ through the MIL-F-8785C low-altitude
 * relation, so gust magnitude falls with altitude exactly as the standard specifies — which is
 * WP-10's stated acceptance check.
 */
export function gustAtTick(
  seed: number,
  droneId: string,
  tick: number,
  windAt20ftMs: number,
  altitudeFt: number,
): number {
  const { sigmaMs } = lowAltitudeDryden(windAt20ftMs, altitudeFt)
  if (!(sigmaMs > 0)) return 0
  const series = normalizedGustSeries(seed, droneId)
  // Wrapping keeps a long mission inside the cached series. The wrap point is a seam in the
  // correlation, not in the statistics, and it is half an hour of sim time out.
  const index = ((Math.floor(tick) % series.length) + series.length) % series.length
  return series[index] * sigmaMs
}

/** Observability only — never an input to any result. */
export function gustFieldCacheSize(): number {
  return normalizedSeriesCache.size
}

/** Test seam: drops the pure memo. Cannot change any answer, only force recomputation. */
export function clearGustFieldCache(): void {
  normalizedSeriesCache.clear()
}

/** Stable FNV-1a, matching the hashing used by the thermal, GNSS and RF models. */
function hashSeed(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}
