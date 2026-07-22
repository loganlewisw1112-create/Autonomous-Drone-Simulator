// LiPo battery discharge model (REALISM_ROADMAP WP-11).
//
// Pure, deterministic battery physics: an open-circuit-voltage curve with the
// characteristic low-SoC "knee", internal-resistance sag under load, and a
// temperature derate on usable capacity. Peukert rate-dependency is deliberately
// omitted — it only bites above ~20C discharge, well outside an endurance/range
// flight regime (WP-11). This module changes no live sim behaviour on its own; it
// is the sourced model the linear drain in DroneEntity is replaced by once wired,
// mirroring how sensors/thermalRange.ts (WP-5) ships geometry ahead of its live gate.

export const CELL_FULL_V = 4.2
export const CELL_NOMINAL_V = 3.7
export const CELL_CUTOFF_V = 3.0

// Per-cell open-circuit voltage vs state of charge (SoC 0..1). Piecewise-linear over a
// representative LiPo discharge table: nearly flat from full to ~30%, then a steep knee
// toward the 3.0 V cutoff. The knee is the whole point — it is why a voltage-aware reserve
// fires earlier than a linear "percent remaining" gate.
const OCV_TABLE: ReadonlyArray<readonly [number, number]> = [
  [0.0, 3.0],
  [0.05, 3.3],
  [0.1, 3.5],
  [0.2, 3.65],
  [0.3, 3.72],
  [0.5, 3.8],
  [0.7, 3.88],
  [0.85, 3.96],
  [1.0, 4.2],
]

/** Open-circuit per-cell voltage at a given state of charge (0..1), piecewise-linear. */
export function ocvFromSoc(soc: number): number {
  const s = Math.min(1, Math.max(0, soc))
  for (let i = 1; i < OCV_TABLE.length; i++) {
    const [s0, v0] = OCV_TABLE[i - 1]
    const [s1, v1] = OCV_TABLE[i]
    if (s <= s1) {
      const t = s1 === s0 ? 0 : (s - s0) / (s1 - s0)
      return v0 + t * (v1 - v0)
    }
  }
  return CELL_FULL_V
}

/** Per-cell terminal voltage under load: V = OCV(soc) − IR drop. Pass `sagV = 0` for the
 *  rested open-circuit voltage; a larger `sagV` models a heavier instantaneous draw. */
export function terminalVoltage(soc: number, sagV = 0): number {
  return ocvFromSoc(soc) - Math.max(0, sagV)
}

// Usable-capacity multiplier vs the ~20C reference. LiPo loses usable capacity in the cold
// (higher internal resistance, earlier sag); heat costs little capacity but cycle life. Linear
// derate below 20C at ~0.8%/C, floored; a mild derate above 35C. (WP-11)
export function capacityTempMultiplier(tempC: number): number {
  if (tempC >= 20 && tempC <= 35) return 1
  if (tempC < 20) return Math.max(0.6, 1 - (20 - tempC) * 0.008)
  return Math.max(0.9, 1 - (tempC - 35) * 0.004)
}

export interface EnduranceInput {
  /** Published still-air endurance at ~20C (min), e.g. platform.enduranceMin. */
  publishedMin: number
  tempC: number
  /** Aggregate load factor vs the nominal endurance profile: 1 = as published, >1 = harder
   *  (hover in wind, heavy maneuvering), <1 = gentle cruise. */
  loadFactor?: number
}

/** Modelled endurance (minutes): published endurance scaled by the temperature capacity
 *  derate and load. At 20C, still air, loadFactor 1 this returns `publishedMin` exactly. */
export function enduranceMinutes({ publishedMin, tempC, loadFactor = 1 }: EnduranceInput): number {
  return (publishedMin * capacityTempMultiplier(tempC)) / Math.max(0.1, loadFactor)
}

/** State of charge at which the *loaded* terminal voltage first reaches `reserveCellV` — the
 *  point a real autopilot triggers RTB. Because the knee is nonlinear, this SoC is higher than
 *  a naive linear "reserve % == remaining energy %" gate, so voltage-aware RTB fires earlier.
 *  Scans low→high SoC; OCV is monotonic so the first crossing is the reserve SoC. */
export function reserveSocForVoltage(reserveCellV: number, sagV = 0): number {
  for (let s = 0; s <= 1.0001; s += 0.001) {
    if (terminalVoltage(s, sagV) >= reserveCellV) return Math.min(1, s)
  }
  return 1
}
