// GNSS dilution of precision (REALISM_ROADMAP WP-7 / §18.3).
//
// Pure geometry: how the arrangement of visible satellites in the sky amplifies ranging error
// into position error. Nothing here knows about terrain, drones or the sim clock — it takes a
// set of look angles and returns DOP. `gnss.ts` is what connects it to the occlusion service.
//
//   For each visible satellite i, unit line-of-sight (e, n, u) in local east-north-up:
//
//     G = [ −e₁  −n₁  −u₁  1 ]        Q = (Gᵀ G)⁻¹
//         [ −e₂  −n₂  −u₂  1 ]
//         [  …    …    …   … ]
//
//     HDOP = √(Q₁₁ + Q₂₂)   VDOP = √(Q₃₃)   PDOP = √(Q₁₁ + Q₂₂ + Q₃₃)   GDOP = √(trace Q)
//
// The fourth column is the receiver clock bias, which is solved for alongside position and is
// why four satellites are the minimum rather than three.
//
// DETERMINISM (§3). Pure, no clock, no RNG, no module state. The matrix inversion is a fixed
// sequence of arithmetic on a 4×4 — no iteration to a tolerance — so the result is bit-identical
// run to run, which is what lets a replay reproduce a position error exactly.

/** A satellite's apparent position from the receiver: azimuth clockwise from north, elevation. */
export interface SatelliteLook {
  azDeg: number
  elDeg: number
}

export interface DopResult {
  hdop: number
  vdop: number
  pdop: number
  gdop: number
  /** Satellites that entered the solution. */
  satellites: number
}

const DEG = Math.PI / 180

/**
 * DOP above this is refused rather than reported (§18.3's implementation trap).
 *
 * The maths stays valid as geometry degenerates, but its answers stop being useful: a
 * near-singular geometry matrix yields HDOP in the thousands, which through σ_H = HDOP × σ_UERE
 * is a kilometres-wide "position". A real receiver does not report that — it drops the fix, and
 * every autopilot carries a DOP threshold above which it degrades to position hold. Clamping
 * here (before error injection, never after) is both more faithful to the hardware and better
 * training content than a marker teleporting across the map.
 */
export const MAX_USABLE_HDOP = 20

/** Minimum satellites for a fix: three for position, one for the receiver clock bias. */
export const MIN_FIX_SATELLITES = 4

/**
 * Standard elevation mask. Signals arriving below ~5° traverse too much atmosphere and are too
 * multipath-prone to trust, so receivers exclude them regardless of how much the geometry would
 * benefit. Applied before visibility, never after.
 */
export const ELEVATION_MASK_DEG = 5

/** Unit line-of-sight vector in local east-north-up. */
export function lookUnitVector(look: SatelliteLook): [number, number, number] {
  const az = look.azDeg * DEG
  const el = look.elDeg * DEG
  const cosEl = Math.cos(el)
  return [cosEl * Math.sin(az), cosEl * Math.cos(az), Math.sin(el)]
}

/**
 * DOP for a set of look angles, or null when the geometry cannot support a fix — fewer than four
 * satellites, or a matrix too near-singular to invert meaningfully (all satellites in one plane,
 * for instance). Null is the honest answer and the caller must handle it as loss of fix; it is
 * never a large number standing in for "no idea".
 */
export function computeDop(looks: readonly SatelliteLook[]): DopResult | null {
  if (looks.length < MIN_FIX_SATELLITES) return null

  // Normal matrix GᵀG, accumulated directly — G itself is never materialised.
  const n = 4
  const ata = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (const look of looks) {
    const [e, nn, u] = lookUnitVector(look)
    const row = [-e, -nn, -u, 1]
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) ata[i][j] += row[i] * row[j]
    }
  }

  const q = invert4x4(ata)
  if (!q) return null

  const qh = q[0][0] + q[1][1]
  const qv = q[2][2]
  const trace = qh + qv + q[3][3]
  // A negative diagonal is only reachable through floating-point loss on a matrix that was
  // effectively singular. Refuse it rather than take a square root of a negative number.
  if (qh < 0 || qv < 0 || trace < 0) return null

  return {
    hdop: Math.sqrt(qh),
    vdop: Math.sqrt(qv),
    pdop: Math.sqrt(qh + qv),
    gdop: Math.sqrt(trace),
    satellites: looks.length,
  }
}

/** Satellites above the elevation mask. */
export function aboveElevationMask(
  looks: readonly SatelliteLook[],
  maskDeg = ELEVATION_MASK_DEG,
): SatelliteLook[] {
  return looks.filter((look) => look.elDeg >= maskDeg)
}

/**
 * Gauss-Jordan inversion with partial pivoting on a 4×4. Returns null when the pivot collapses,
 * which is the numerical signature of a degenerate satellite geometry.
 */
function invert4x4(m: readonly number[][]): number[][] | null {
  const n = 4
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))])

  for (let col = 0; col < n; col += 1) {
    let pivotRow = col
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivotRow][col])) pivotRow = row
    }
    const pivot = a[pivotRow][col]
    // Scaled against the matrix's own magnitude rather than a bare epsilon, so the test means
    // the same thing for a 4-satellite and a 30-satellite normal matrix.
    if (!Number.isFinite(pivot) || Math.abs(pivot) < 1e-12) return null

    if (pivotRow !== col) {
      const swap = a[col]
      a[col] = a[pivotRow]
      a[pivotRow] = swap
    }

    const inv = 1 / a[col][col]
    for (let j = 0; j < 2 * n; j += 1) a[col][j] *= inv

    for (let row = 0; row < n; row += 1) {
      if (row === col) continue
      const factor = a[row][col]
      if (factor === 0) continue
      for (let j = 0; j < 2 * n; j += 1) a[row][j] -= factor * a[col][j]
    }
  }

  const out = a.map((row) => row.slice(n))
  return out.every((row) => row.every(Number.isFinite)) ? out : null
}
