// SAR effective sweep width and probability of detection (REALISM_ROADMAP WP-6 / §18.2).
//
// The profession runs search planning on effective sweep width (W) and probability of
// detection (POD), not raw area coverage. This closes the chain WP-5 opens:
//   R_d (detection radius, from thermalRange) → W → coverage → POD.
// Pure functions; changes no live behaviour on its own. POD is the honest, agency-recognised
// metric that replaces the geometric-area coverage figure on the READY tab once wired.

/** Field relation from the USCG/NASAR land-search detection experiments: W ≈ 1.645·R_d
 *  (R² = 0.827 across ten experiments). */
export const SWEEP_WIDTH_FACTOR = 1.645

/** Effective sweep width (m) from the sensor detection radius (m). */
export function sweepWidthM(detectionRadiusM: number): number {
  return SWEEP_WIDTH_FACTOR * Math.max(0, detectionRadiusM)
}

/** Fractional coverage = (search effort × sweep width) / sector area. `effortM` is the total
 *  track length flown in the sector; unitless result (can exceed 1 for a re-swept sector). */
export function coverage(effortM: number, sweepWidthMeters: number, sectorAreaM2: number): number {
  if (sectorAreaM2 <= 0) return 0
  return (Math.max(0, effortM) * Math.max(0, sweepWidthMeters)) / sectorAreaM2
}

/** POD from coverage on the conservative random-search curve: POD = 1 − e^(−coverage).
 *  Well-executed parallel-track sweeps beat this, so reporting it errs safe. Clamped to [0,1]. */
export function podFromCoverage(cov: number): number {
  if (cov <= 0) return 0
  return Math.min(1, 1 - Math.exp(-cov))
}

export interface SweepInput {
  /** Sensor detection radius R_d (m). 0 (e.g. LOS never achieved) yields POD 0. */
  detectionRadiusM: number
  /** Total track length flown in the sector (m). */
  trackLengthM: number
  /** Sector area (m²). */
  sectorAreaM2: number
}

export interface SweepResult {
  sweepWidthM: number
  coverage: number
  pod: number
}

/** Full R_d → W → coverage → POD for one sector sweep. */
export function probabilityOfDetection(input: SweepInput): SweepResult {
  const w = sweepWidthM(input.detectionRadiusM)
  const cov = coverage(input.trackLengthM, w, input.sectorAreaM2)
  return { sweepWidthM: w, coverage: cov, pod: podFromCoverage(cov) }
}

/** Cumulative POD after independent sweeps of the same sector: 1 − Π(1 − POD_i). Re-sweeping
 *  raises cumulative POD along the documented curve — the real "re-sweep vs move on" tradeoff. */
export function cumulativePod(pods: number[]): number {
  const miss = pods.reduce((acc, p) => acc * (1 - Math.min(1, Math.max(0, p))), 1)
  return 1 - miss
}
