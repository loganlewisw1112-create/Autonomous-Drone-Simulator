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
  /** Scenario-defined launch-bay coordinates. Distinct or ungrouped bays remain exact. */
  explicitBays?: Record<string, LatLng>
  /** Stable physical-site identity for each explicit bay assignment. */
  explicitBaySiteIds?: Record<string, string>
  /** Usable fan-axis width for each physical site. */
  explicitBayFootprintsM?: Record<string, number>
}

/** Circular mean of a set of bearings (deg), robust across the 0/360 wrap. */
function meanBearingDeg(bearings: number[], fallback = 0): number {
  if (bearings.length === 0) return fallback
  let sx = 0
  let sy = 0
  for (const b of bearings) {
    const r = (b * Math.PI) / 180
    sx += Math.cos(r)
    sy += Math.sin(r)
  }
  if (Math.hypot(sx, sy) < 1e-9) return fallback
  return ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360
}

function orderByBearing(droneIds: string[], bearings: Record<string, number>, mean: number): string[] {
  return [...droneIds].sort((a, b) => {
    const da = angleDiffDeg(mean, bearings[a])
    const db = angleDiffDeg(mean, bearings[b])
    if (da !== db) return da - db
    return a.localeCompare(b)
  })
}

export function planCoordinatedLaunch(params: PlanParams): Record<string, LaunchSlot> {
  const {
    startPosition,
    droneIds,
    firstTargets,
    explicitBays,
    explicitBaySiteIds,
    explicitBayFootprintsM,
  } = params
  const result: Record<string, LaunchSlot> = {}
  if (droneIds.length === 0) return result

  // Outbound bearing for each drone (bay→first target; falls back to staging point).
  const bearings: Record<string, number> = {}
  for (const id of droneIds) {
    const origin = explicitBays?.[id] ?? startPosition
    const target = firstTargets[id] ?? startPosition
    bearings[id] = bearingDeg(origin, target)
  }

  const stableDroneIds = [...droneIds].sort((a, b) => a.localeCompare(b))
  const mean = meanBearingDeg(droneIds.map((id) => bearings[id]), bearings[stableDroneIds[0]])
  // Fan axis is perpendicular to the mean outbound direction.
  const fanAxis = (mean + 90) % 360

  // Order drones left→right across the fan by their signed offset from the mean
  // heading. Adjacent bays then carry adjacent headings, so legs never cross.
  const ordered = orderByBearing(droneIds, bearings, mean)

  // Explicit assignments retain their authored coordinate unless multiple drones
  // resolve to the same physical site. Shared sites get their own centered fan;
  // unrelated explicit sites never move.
  const fannedExplicitBays: Record<string, LatLng> = {}
  const dronesBySite = new Map<string, string[]>()
  for (const id of stableDroneIds) {
    const siteId = explicitBays?.[id] ? explicitBaySiteIds?.[id] : undefined
    if (!siteId) continue
    const members = dronesBySite.get(siteId) ?? []
    members.push(id)
    dronesBySite.set(siteId, members)
  }

  for (const siteId of [...dronesBySite.keys()].sort((a, b) => a.localeCompare(b))) {
    const members = dronesBySite.get(siteId) ?? []
    if (members.length === 0) continue
    if (members.length === 1) {
      fannedExplicitBays[members[0]] = explicitBays![members[0]]
      continue
    }

    const center = explicitBays![members[0]]
    const groupMean = meanBearingDeg(members.map((id) => bearings[id]), bearings[members[0]])
    const groupFanAxis = (groupMean + 90) % 360
    const groupOrder = orderByBearing(members, bearings, groupMean)
    const requiredSpanM = (groupOrder.length - 1) * BAY_SPACING_M
    // Doctrine rejects a declared footprint shorter than requiredSpanM. The
    // coordinator never compresses below BAY_SPACING_M; safety wins even if a
    // blocked plan is inspected before launch.
    const declaredSpanM = explicitBayFootprintsM?.[siteId]
    const usableSpanM = Number.isFinite(declaredSpanM) && (declaredSpanM ?? -1) >= 0
      ? Math.max(requiredSpanM, declaredSpanM!)
      : requiredSpanM
    const leadingInsetM = (usableSpanM - requiredSpanM) / 2

    groupOrder.forEach((id, index) => {
      const signedOffsetM = -usableSpanM / 2 + leadingInsetM + index * BAY_SPACING_M
      const bearing = signedOffsetM >= 0 ? groupFanAxis : (groupFanAxis + 180) % 360
      const distanceM = Math.abs(signedOffsetM)
      fannedExplicitBays[id] = distanceM < 0.01 ? center : offsetLatLng(center, bearing, distanceM)
    })
  }

  const n = ordered.length
  let cumulativeSec = 0
  ordered.forEach((id, k) => {
    // Spatial bay: centered fan, ±BAY_SPACING_M steps along the fan axis.
    let bay: LatLng
    if (explicitBays?.[id]) {
      bay = fannedExplicitBays[id] ?? explicitBays[id]
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
