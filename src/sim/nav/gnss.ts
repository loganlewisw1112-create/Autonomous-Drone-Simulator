import { offsetLatLng } from '@/utils/geometry'
import type { GnssFixQuality, LatLng } from '@/types'
import type { OcclusionService } from '@/sim/terrain/OcclusionService'
import {
  aboveElevationMask,
  computeDop,
  ELEVATION_MASK_DEG,
  MAX_USABLE_HDOP,
  MIN_FIX_SATELLITES,
  type DopResult,
  type SatelliteLook,
} from './dop'

// GNSS position degradation from real sky occlusion (REALISM_ROADMAP WP-7 / §7.2, §18.3).
//
// The chain, end to end:
//   almanac look angles → elevation mask → skyVisibility() against terrain+buildings (WP-4)
//     → DOP from the surviving geometry → σ_H = HDOP × σ_UERE → reported position
//
// WHAT IS AND IS NOT SIMULATED (§7.1, recorded). This is Tier 2. There are no pseudoranges, no
// weighted least squares, no RAIM, no receiver Kalman filter — the roadmap rejects Tier 3 on the
// grounds that a pseudorange bias has no consumer here: you do not simulate a GNSS receiver, you
// simulate an aircraft that reports a position. Occlusion → geometry → DOP → reported error is
// the whole model, and reported error is the only GNSS quantity an operator actually observes.
//
// TRUTH IS RETAINED (§7.2 step 4). `evaluateGnss` never moves the aircraft. It returns a
// *reported* position alongside the truth the sim keeps flying, which is what makes the training
// content work: the operator sees the track drift from where the drone actually is.
//
// DETERMINISM (§3). Pure function of (position, constellation, occlusion, seed, tick). The error
// is band-limited noise evaluated directly from sim time — NOT an accumulating random walk and
// NOT a per-tick draw from a stateful RNG. That matters twice over: it keeps replay
// bit-identical under sub-stepping (no RNG state to desynchronise), and it makes the error
// continuous, which is what satisfies the accept criterion that a reported position never jumps
// more than 3σ between consecutive fixes.

/** Default user-equivalent range error (§18.3). Tunable per platform; 4 m is the stated default. */
export const DEFAULT_UERE_M = 4

/** Hard cap on reported error in units of σ_H, so a fix that is valid can never teleport. */
const MAX_SIGMA_MULTIPLE = 3

/** Number of sinusoids summed to build the band-limited error signal. */
const NOISE_HARMONICS = 4

/** Slowest error component period (s). GNSS error wanders over minutes, not milliseconds. */
const NOISE_BASE_PERIOD_SEC = 240

// GnssFixQuality is declared in @/types (leaf-level, so DroneState can carry it):
//   'fix'      — four or more satellites and usable geometry
//   'degraded' — a valid fix, but geometry poor enough that the operator should distrust it
//   'no_fix'   — under 4 satellites or DOP past the threshold; position hold / dead reckoning
export type { GnssFixQuality }

/** HDOP at or above which a fix is still valid but flagged for the operator. */
export const DEGRADED_HDOP = 4

export interface GnssState {
  /** Satellites above the elevation mask AND with clear sky. */
  satsVisible: number
  /** Satellites above the elevation mask, before occlusion — what an open sky would have given. */
  satsInView: number
  hdop: number | null
  vdop: number | null
  fixQuality: GnssFixQuality
  /** 1σ horizontal error (m). Null when there is no fix. */
  horizontalErrorM: number | null
  /**
   * Position the aircraft reports. Equals truth only when error is zero; during `no_fix` it is
   * the last position the receiver could vouch for, which is what position hold means.
   */
  reportedPosition: LatLng
  /** Why the fix was refused, when it was. */
  lossReason: 'insufficient_satellites' | 'degenerate_geometry' | null
}

export interface GnssInput {
  droneId: string
  /** Ground truth. Never modified. */
  position: LatLng
  /** Aircraft altitude, m MSL — the ray origin for sky visibility. */
  altMslM: number
  /** Look angles for the whole constellation at this moment, before any masking. */
  constellation: readonly SatelliteLook[]
  /** Terrain + buildings. Omitted ⇒ open sky (no occlusion evidence, so none is invented). */
  occlusion?: OcclusionService
  seed: number
  tick: number
  /** Sim seconds. Drives the error signal; must be sim time, never the wall clock. */
  elapsedSec: number
  uereM?: number
  /** Reported position from the previous evaluation, held through a fix outage. */
  lastReported?: LatLng
}

/**
 * Which satellites this receiver can actually use from this position.
 *
 * Elevation mask first, then occlusion — the mask is a receiver policy that applies regardless
 * of what the terrain does, so a satellite at 3° is excluded even in perfectly open sky.
 */
export function visibleSatellites(
  position: LatLng,
  altMslM: number,
  constellation: readonly SatelliteLook[],
  occlusion?: OcclusionService,
  maskDeg = ELEVATION_MASK_DEG,
): { inView: SatelliteLook[]; visible: SatelliteLook[] } {
  const inView = aboveElevationMask(constellation, maskDeg)
  if (!occlusion) return { inView, visible: inView }
  const origin = { lat: position.lat, lng: position.lng, altMslM }
  return {
    inView,
    visible: inView.filter((look) => occlusion.skyVisibility(origin, look.azDeg, look.elDeg)),
  }
}

/**
 * Full GNSS evaluation for one aircraft at one instant.
 *
 * Returns `no_fix` — position hold, not a wild position — whenever fewer than four satellites
 * survive or the geometry is past `MAX_USABLE_HDOP`. §18.3's implementation trap is explicit
 * that the near-singular cases are mathematically correct and operationally catastrophic, and
 * that clamping belongs *before* error injection.
 */
export function evaluateGnss(input: GnssInput): GnssState {
  const { inView, visible } = visibleSatellites(
    input.position,
    input.altMslM,
    input.constellation,
    input.occlusion,
  )

  const held = input.lastReported ?? input.position

  if (visible.length < MIN_FIX_SATELLITES) {
    return noFix(inView.length, visible.length, held, 'insufficient_satellites')
  }

  const dop: DopResult | null = computeDop(visible)
  if (!dop || !Number.isFinite(dop.hdop) || dop.hdop > MAX_USABLE_HDOP) {
    return noFix(inView.length, visible.length, held, 'degenerate_geometry')
  }

  const uere = input.uereM ?? DEFAULT_UERE_M
  const sigmaH = dop.hdop * uere

  // Band-limited, zero-mean, continuous in sim time. Two independent axes so the error has a
  // wandering bearing rather than pulsing along one line.
  const east = sigmaH * bandLimitedNoise(input.seed, input.droneId, 'E', input.elapsedSec)
  const north = sigmaH * bandLimitedNoise(input.seed, input.droneId, 'N', input.elapsedSec)

  const rawM = Math.hypot(east, north)
  const cap = sigmaH * MAX_SIGMA_MULTIPLE
  const scale = rawM > cap && rawM > 0 ? cap / rawM : 1
  const offsetM = rawM * scale
  const bearing = (Math.atan2(east, north) * 180) / Math.PI

  return {
    satsInView: inView.length,
    satsVisible: visible.length,
    hdop: dop.hdop,
    vdop: dop.vdop,
    fixQuality: dop.hdop >= DEGRADED_HDOP ? 'degraded' : 'fix',
    horizontalErrorM: sigmaH,
    reportedPosition: offsetM > 0.01 ? offsetLatLng(input.position, bearing, offsetM) : input.position,
    lossReason: null,
  }
}

function noFix(
  satsInView: number,
  satsVisible: number,
  held: LatLng,
  lossReason: NonNullable<GnssState['lossReason']>,
): GnssState {
  return {
    satsInView,
    satsVisible,
    hdop: null,
    vdop: null,
    fixQuality: 'no_fix',
    horizontalErrorM: null,
    // Position hold: the receiver reports the last position it could vouch for rather than
    // either the truth (which it does not know) or a fabricated degraded fix.
    reportedPosition: held,
    lossReason,
  }
}

/** Stable FNV-1a, matching the hashing already used by the thermal sensor model. */
function hashIdentity(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Zero-mean band-limited noise in roughly [−1, 1], continuous and differentiable in `tSec`.
 *
 * A sum of sinusoids at incommensurate periods, with frequencies and phases derived from the
 * seed. This is deliberately NOT a random walk: a walk needs accumulated state, and persistent
 * RNG state is precisely what this simulation's determinism guarantees forbid — it would
 * desynchronise under sub-stepping and break byte-identical replay. Evaluating a closed form at
 * sim time gives the same value no matter how the caller reaches that time, while still looking
 * and behaving like the slow wander of real GNSS error.
 */
export function bandLimitedNoise(seed: number, droneId: string, axis: string, tSec: number): number {
  const base = hashIdentity(`${seed}|${droneId}|${axis}`)
  let sum = 0
  for (let k = 0; k < NOISE_HARMONICS; k += 1) {
    const h = hashIdentity(`${base}|${k}`)
    // Irrational-ish period spread keeps the harmonics from re-phasing into a short cycle.
    const period = NOISE_BASE_PERIOD_SEC / (1 + k * 0.6180339887) * (0.75 + ((h >>> 16) / 65535) * 0.5)
    const phase = ((h & 0xffff) / 65535) * Math.PI * 2
    sum += Math.sin((tSec / period) * Math.PI * 2 + phase)
  }
  return sum / NOISE_HARMONICS
}
