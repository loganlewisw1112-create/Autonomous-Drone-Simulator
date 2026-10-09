import type { LatLng } from '@/types'
import type { RoadNetwork } from '@/scenarios/roadFixtures'
import { offsetLatLng } from '@/utils/geometry'
import { snapToRoad } from '@/sim/mission/roadRouter'

const CELL = 100
const M_PER_DEG = 111195

/** Nearest-edge distance (metres) through a bounding grid, independent of the router's own snap. */
export function makeNearestEdgeDistM(net: RoadNetwork): (p: LatLng) => number {
  const lat0 = net.nodes[0].lat
  const lng0 = net.nodes[0].lng
  const cosL = Math.cos(lat0 * Math.PI / 180)
  const key = (cx: number, cy: number) => cx * 100003 + cy
  const grid = new Map<number, Array<[number, number]>>()
  const toXY = (p: LatLng): [number, number] => [(p.lng - lng0) * cosL * M_PER_DEG, (p.lat - lat0) * M_PER_DEG]
  net.edges.forEach((e, ei) => {
    for (let k = 0; k + 1 < e.points.length; k++) {
      const [ax, ay] = toXY(e.points[k])
      const [bx, by] = toXY(e.points[k + 1])
      for (let cx = Math.floor(Math.min(ax, bx) / CELL); cx <= Math.floor(Math.max(ax, bx) / CELL); cx++) {
        for (let cy = Math.floor(Math.min(ay, by) / CELL); cy <= Math.floor(Math.max(ay, by) / CELL); cy++) {
          const list = grid.get(key(cx, cy))
          if (list) list.push([ei, k])
          else grid.set(key(cx, cy), [[ei, k]])
        }
      }
    }
  })
  return (p) => {
    const [px, py] = toXY(p)
    const cx = Math.floor(px / CELL)
    const cy = Math.floor(py / CELL)
    let best = Infinity
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const [ei, k] of grid.get(key(cx + dx, cy + dy)) ?? []) {
          const [ax, ay] = toXY(net.edges[ei].points[k])
          const [bx, by] = toXY(net.edges[ei].points[k + 1])
          const vx = bx - ax
          const vy = by - ay
          const len2 = vx * vx + vy * vy
          const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2))
          best = Math.min(best, Math.hypot(px - (ax + t * vx), py - (ay + t * vy)))
        }
      }
    }
    return best
  }
}

/**
 * A point whose nearest drivable road (target snap) is `gapM` away (within 1.5 m), found by
 * offsetting sideways from vertices of ordinary edges. With `near`, the closest qualifying point
 * to the centre wins (so a drone stays inside comms range). `skip` selects the (skip+1)th hit and
 * `minSeparationM` keeps hits away from `avoid`.
 */
export function findGapPoint(
  net: RoadNetwork,
  gapM: number,
  opts: { skip?: number; avoid?: LatLng[]; minSeparationM?: number; near?: { center: LatLng; maxM: number } } = {},
): LatLng | null {
  const dist = (p: LatLng, q: LatLng) => Math.hypot((q.lat - p.lat) * M_PER_DEG, (q.lng - p.lng) * M_PER_DEG * 0.85)
  const cands: Array<{ p: LatLng; d: number }> = []
  for (const edge of net.edges) {
    if (edge.flags !== 0 || edge.lengthM < 100) continue
    for (let i = 1; i < edge.points.length; i += Math.max(1, Math.floor(edge.points.length / 4))) {
      const a = edge.points[i - 1]
      const b = edge.points[i]
      const course = (Math.atan2((b.lng - a.lng) * Math.cos(a.lat * Math.PI / 180), b.lat - a.lat) * 180) / Math.PI
      for (const side of [90, -90]) {
        const p = offsetLatLng(b, course + side, gapM)
        const d = opts.near ? dist(p, opts.near.center) : 0
        if (opts.near && d > opts.near.maxM) continue
        cands.push({ p, d })
      }
    }
  }
  if (opts.near) cands.sort((x, y) => x.d - y.d)
  let remaining = opts.skip ?? 0
  for (const { p } of cands) {
    const snap = snapToRoad(net, p, { role: 'target' })
    if (!snap || Math.abs(snap.distM - gapM) > 1.5) continue
    if (opts.avoid?.some((q) => dist(p, q) < (opts.minSeparationM ?? 0))) continue
    if (remaining-- > 0) continue
    return p
  }
  return null
}
