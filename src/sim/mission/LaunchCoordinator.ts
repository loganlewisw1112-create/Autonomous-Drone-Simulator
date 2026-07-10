import type { LatLng } from '@/types'
import { bearingDeg, offsetLatLng, angleDiffDeg } from '@/utils/geometry'
import { H_SEP_M } from '@/sim/safety/DeconflictEngine'

// ── "Hive-mind" coordinated launch planner ───────────────────────────────────
//
// Given each drone's first outbound target, this computes BOTH:
//   1. a spatial launch bay per drone — fanned out from the staging point so no
//      two drones lift from the same spot, and ordered by outbound bearing so the
//      climb-out legs splay apart instead of crossing; and
//   2. a staggered takeoff schedule (in SIM time) — drones heading in similar
//      directions are separated in time so they never climb through the same
//      airspace at once, while drones diverging onto different headings are
//      released almost together to keep the whole launch window short.
//
// The result is a pure, deterministic function of the staging point + first-leg
// geometry (no RNG, no wall-clock), so replays and same-seed runs reproduce the
// identical launch sequence.

// Lateral spacing between adjacent launch bays. Kept above the horizontal
// separation minimum so drones are already deconflicted on the pad.
export const BAY_SPACING_M = 35
// Time separation between two drones climbing out on SIMILAR headings.
export const LAUNCH_SLOT_SEC = 2.2
// Reduced separation between drones whose headings DIVERGE — they leave each
// other's airspace immediately, so they need only a token gap.
export const LAUNCH_QUICK_SEC = 0.8
// Heading spread (deg) beyond which two consecutive drones count as "diverging".
export const DIVERGENCE_DEG = 35

export interface LaunchSlot {
  bay: LatLng
  scheduledLaunchSec: number
  outboundBearingDeg: number
}

interface PlanParams {
  startPosition: LatLng
  droneIds: string[]
  /** First waypoint position per drone (defines its outbound heading). */
  firstTargets: Record<string, LatLng>
  /** Scenario-defined launch bays; when every drone has one, the fan is skipped. */
  explicitBays?: Record<string, LatLng>
}

/** Circular mean of a set of bearings (deg), robust across the 0/360 wrap. */
function meanBearingDeg(bearings: number[]): number {
  if (bearings.length === 0) return 0
  let sx = 0
  let sy = 0
  for (const b of bearings) {
    const r = (b * Math.PI) / 180
    sx += Math.cos(r)
    sy += Math.sin(r)
  }
  return ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360
}

export function planCoordinatedLaunch(params: PlanParams): Record<string, LaunchSlot> {
  const { startPosition, droneIds, firstTargets, explicitBays } = params
  const result: Record<string, LaunchSlot> = {}
  if (droneIds.length === 0) return result

  // Outbound bearing for each drone (bay→first target; falls back to staging point).
  const bearings: Record<string, number> = {}
  for (const id of droneIds) {
    const origin = explicitBays?.[id] ?? startPosition
    const target = firstTargets[id] ?? startPosition
    bearings[id] = bearingDeg(origin, target)
  }

  const mean = meanBearingDeg(droneIds.map((id) => bearings[id]))
  // Fan axis is perpendicular to the mean outbound direction.
  const fanAxis = (mean + 90) % 360

  // Order drones left→right across the fan by their signed offset from the mean
  // heading. Adjacent bays then carry adjacent headings, so legs never cross.
  const ordered = [...droneIds].sort((a, b) => {
    const da = angleDiffDeg(mean, bearings[a])
    const db = angleDiffDeg(mean, bearings[b])
    if (da !== db) return da - db
    return a.localeCompare(b)   // stable tie-break for determinism
  })

  const n = ordered.length
  let cumulativeSec = 0
  ordered.forEach((id, k) => {
    // Spatial bay: centered fan, ±BAY_SPACING_M steps along the fan axis.
    let bay: LatLng
    if (explicitBays?.[id]) {
      bay = explicitBays[id]
    } else {
      const offsetIndex = k - (n - 1) / 2
      const dist = Math.abs(offsetIndex) * BAY_SPACING_M
      const brg = offsetIndex >= 0 ? fanAxis : (fanAxis + 180) % 360
      bay = dist < 0.01 ? startPosition : offsetLatLng(startPosition, brg, dist)
    }

    // Temporal slot: gap from the previous drone in climb order.
    if (k > 0) {
      const prev = ordered[k - 1]
      const spread = Math.abs(angleDiffDeg(bearings[prev], bearings[id]))
      cumulativeSec += spread >= DIVERGENCE_DEG ? LAUNCH_QUICK_SEC : LAUNCH_SLOT_SEC
    }

    result[id] = {
      bay,
      scheduledLaunchSec: Number(cumulativeSec.toFixed(3)),
      outboundBearingDeg: bearings[id],
    }
  })

  return result
}

// Re-exported so callers can assert bay spacing honors the separation minimum.
export { H_SEP_M }
