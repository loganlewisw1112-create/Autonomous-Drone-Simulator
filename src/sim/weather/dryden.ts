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
