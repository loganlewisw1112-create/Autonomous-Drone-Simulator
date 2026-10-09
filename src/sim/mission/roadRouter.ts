import type { LatLng } from '@/types'
import type { RoadNetwork } from '@/scenarios/roadFixtures'
import { angleDiffDeg, bearingDeg, haversineDistanceM } from '@/utils/geometry'

// Pure, deterministic road router over a decoded fixture (RoadNetwork). No clock, no randomness,
// no dependence on Map/Set iteration order. Vehicles are driven along the returned polyline by
// the simulation; the route itself never depends on weather (weather scales every edge equally).

/** Floor for every vehicle speed, so a unit can never stall on a slow track. */
export const MIN_ROUTE_SPEED_MPS = 6
/** Corner-cap influence radius either side of a vertex. */
export const CORNER_RADIUS_M = 25
/** Spacing of the remaining-time table built with each route. */
export const NOMINAL_TABLE_STEP_M = 5
/** A contact further than this from a road gets no ground unit (store refuses the dispatch). */
export const MAX_ACCESS_GAP_M = 2000
/** Recovery teams walk in at most this far (about 10 minutes on foot). */
export const RECOVERY_WALK_LIMIT_M = 750
/** If the start position is further than this from a road, the first entry node stages instead. */
export const START_SNAP_LIMIT_M = 1500
/** A bridge edge is a valid target snap only when the contact is this close to it. */
export const BRIDGE_TARGET_RADIUS_M = 30

const FLAG_BRIDGE = 1
const FLAG_HIDDEN = 2
const M_PER_DEG = 111195
const GRID_CELL_M = 150
const TIE_EPS_M = 1e-6
const DEDUPE_M = 0.01

/** Equirectangular metres: the one helper edge lengths, chords and route distances share. */
export function roadMetres(a: LatLng, b: LatLng): number {
  const cos = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180)
  return Math.hypot((b.lng - a.lng) * cos * M_PER_DEG, (b.lat - a.lat) * M_PER_DEG)
}

export interface SnapResult {
  edge: number
  /** Fraction along the edge polyline, 0..1. */
  t: number
  /** Metres along the edge polyline from its `from` node. */
  alongM: number
  point: LatLng
  /** Straight distance from the query point to `point`, metres. */
  distM: number
  /** The point that was snapped. */
  query: LatLng
}

export interface RoadRoute {
  status: 'ok' | 'no_access'
  points: LatLng[]
  /** Distance along the route at each point; cumDistM[0] = 0. */
  cumDistM: number[]
  /** Nominal speed (m/s, never below 6) of the segment points[i] -> points[i+1]. */
  edgeSpeeds: number[]
  /** [startM, endM] spans over tunnel/covered edges. */
  hiddenRanges: Array<[number, number]>
  /**
   * Straight distance from the snap point to the query point that built this route, rounded to
   * 0.1 m. Routes are cached per snap point (see computeRoute), so a cached route carries only its
   * first caller's gap: consumers must use the per-contact gap from the dispatch plan instead.
   */
  accessGapM: number
  lengthM: number
  /** Corner speed cap at each vertex (endpoints carry the adjacent segment speed and are unused). */
  cornerCapsMps: number[]
  /** Cumulative nominal seconds at s = 5k (last entry at lengthM). */
  nominalSecAt: number[]
  nominalTotalSec: number
}

// ── Network index (adjacency, edge geometry, spatial grid) ──────────────────────
interface NetGrid {
  lat0: number
  lng0: number
  cosG: number
  w: number
  h: number
  cells: Map<number, number[]>   // key = cy * w + cx; values flat [edge, segment, edge, segment, ...]
}

interface NetIndex {
  cum: Float64Array[]
  lenM: Float64Array
  speed: Float64Array
  arcTo: number[]
  arcEdge: number[]
  arcRev: boolean[]
  adj: number[][]
  grid: NetGrid | null | undefined
}

const indexCache = new WeakMap<RoadNetwork, NetIndex>()

function getIndex(net: RoadNetwork): NetIndex {
  const hit = indexCache.get(net)
  if (hit) return hit
  const E = net.edges.length
  const cum: Float64Array[] = new Array(E)
  const lenM = new Float64Array(E)
  const speed = new Float64Array(E)
  const arcTo: number[] = []
  const arcEdge: number[] = []
  const arcRev: boolean[] = []
  const adj: number[][] = Array.from({ length: net.nodes.length }, () => [])
  for (let e = 0; e < E; e++) {
    const edge = net.edges[e]
    const pts = edge.points
    const c = new Float64Array(pts.length)
    for (let i = 1; i < pts.length; i++) c[i] = c[i - 1] + roadMetres(pts[i - 1], pts[i])
    cum[e] = c
    lenM[e] = c[pts.length - 1]
    speed[e] = Math.max(MIN_ROUTE_SPEED_MPS, edge.speedMps)
    adj[edge.from].push(arcTo.length)
    arcTo.push(edge.to); arcEdge.push(e); arcRev.push(false)
    if (edge.oneway === 0) {
      adj[edge.to].push(arcTo.length)
      arcTo.push(edge.from); arcEdge.push(e); arcRev.push(true)
    }
  }
  const index: NetIndex = { cum, lenM, speed, arcTo, arcEdge, arcRev, adj, grid: undefined }
  indexCache.set(net, index)
  return index
}

function getGrid(net: RoadNetwork, idx: NetIndex): NetGrid | null {
  if (idx.grid !== undefined) return idx.grid
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity
  let any = false
  for (const e of net.edges) {
    for (const p of e.points) {
      any = true
      if (p.lat < minLat) minLat = p.lat
      if (p.lat > maxLat) maxLat = p.lat
      if (p.lng < minLng) minLng = p.lng
      if (p.lng > maxLng) maxLng = p.lng
    }
  }
  if (!any) { idx.grid = null; return null }
  const cosG = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180)
  const w = Math.floor(((maxLng - minLng) * cosG * M_PER_DEG) / GRID_CELL_M) + 1
  const h = Math.floor(((maxLat - minLat) * M_PER_DEG) / GRID_CELL_M) + 1
  const cells = new Map<number, number[]>()
  net.edges.forEach((edge, e) => {
    for (let k = 0; k + 1 < edge.points.length; k++) {
      const a = edge.points[k]
      const b = edge.points[k + 1]
      const ax = (a.lng - minLng) * cosG * M_PER_DEG
      const bx = (b.lng - minLng) * cosG * M_PER_DEG
      const ay = (a.lat - minLat) * M_PER_DEG
      const by = (b.lat - minLat) * M_PER_DEG
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) / GRID_CELL_M))
      const x1 = Math.min(w - 1, Math.floor(Math.max(ax, bx) / GRID_CELL_M))
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) / GRID_CELL_M))
      const y1 = Math.min(h - 1, Math.floor(Math.max(ay, by) / GRID_CELL_M))
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          const key = cy * w + cx
          const list = cells.get(key)
          if (list) list.push(e, k)
          else cells.set(key, [e, k])
        }
      }
    }
  })
  idx.grid = { lat0: minLat, lng0: minLng, cosG, w, h, cells }
  return idx.grid
}

// ── Snapping ────────────────────────────────────────────────────────────────────
/**
 * Project `p` onto the nearest road edge. Ties (within 1 micrometre) go to the lowest edge index,
 * then the lowest segment. A `target` snap never lands on a tunnel/covered edge, and only lands
 * on a bridge when the point is within 30 m of it.
 */
export function snapToRoad(net: RoadNetwork, p: LatLng, opts: { role: 'origin' | 'target' }): SnapResult | null {
  const idx = getIndex(net)
  const grid = getGrid(net, idx)
  if (!grid) return null
  const target = opts.role === 'target'
  const cosq = Math.cos(p.lat * Math.PI / 180)

  let bestD = Infinity
  let bestE = -1
  let bestK = -1
  let bestT = 0

  const evalSeg = (e: number, k: number) => {
    const edge = net.edges[e]
    if (target && (edge.flags & FLAG_HIDDEN)) return
    const a = edge.points[k]
    const b = edge.points[k + 1]
    const ax = (a.lng - p.lng) * cosq * M_PER_DEG
    const ay = (a.lat - p.lat) * M_PER_DEG
    const bx = (b.lng - p.lng) * cosq * M_PER_DEG
    const by = (b.lat - p.lat) * M_PER_DEG
    const vx = bx - ax
    const vy = by - ay
    const len2 = vx * vx + vy * vy
    let t = len2 === 0 ? 0 : -(ax * vx + ay * vy) / len2
    if (t < 0) t = 0
    else if (t > 1) t = 1
    const d = Math.hypot(ax + t * vx, ay + t * vy)
    if (target && (edge.flags & FLAG_BRIDGE) && d > BRIDGE_TARGET_RADIUS_M) return
    if (
      d < bestD - TIE_EPS_M
      || (d <= bestD + TIE_EPS_M && (e < bestE || (e === bestE && k < bestK)))
    ) {
      bestD = d; bestE = e; bestK = k; bestT = t
    }
  }

  const qx = (p.lng - grid.lng0) * grid.cosG * M_PER_DEG
  const qy = (p.lat - grid.lat0) * M_PER_DEG
  const cx0 = Math.floor(qx / GRID_CELL_M)
  const cy0 = Math.floor(qy / GRID_CELL_M)
  const maxRing = Math.max(Math.abs(cx0), Math.abs(cx0 - (grid.w - 1)), Math.abs(cy0), Math.abs(cy0 - (grid.h - 1))) + 1
  const visit = (cx: number, cy: number) => {
    if (cx < 0 || cy < 0 || cx >= grid.w || cy >= grid.h) return
    const list = grid.cells.get(cy * grid.w + cx)
    if (!list) return
    for (let i = 0; i < list.length; i += 2) evalSeg(list[i], list[i + 1])
  }
  for (let r = 0; r <= maxRing; r++) {
    if (r === 0) {
      visit(cx0, cy0)
    } else {
      const xLo = Math.max(cx0 - r, 0)
      const xHi = Math.min(cx0 + r, grid.w - 1)
      if (cy0 - r >= 0 && cy0 - r < grid.h) for (let cx = xLo; cx <= xHi; cx++) visit(cx, cy0 - r)
      if (cy0 + r >= 0 && cy0 + r < grid.h) for (let cx = xLo; cx <= xHi; cx++) visit(cx, cy0 + r)
      const yLo = Math.max(cy0 - r + 1, 0)
      const yHi = Math.min(cy0 + r - 1, grid.h - 1)
      if (cx0 - r >= 0 && cx0 - r < grid.w) for (let cy = yLo; cy <= yHi; cy++) visit(cx0 - r, cy)
      if (cx0 + r >= 0 && cx0 + r < grid.w) for (let cy = yLo; cy <= yHi; cy++) visit(cx0 + r, cy)
    }
    if (bestE >= 0 && bestD * 1.01 <= r * GRID_CELL_M) break
  }
  if (bestE < 0) return null

  const edge = net.edges[bestE]
  const a = edge.points[bestK]
  const b = edge.points[bestK + 1]
  const point: LatLng = bestT <= 0 ? a : bestT >= 1 ? b : {
    lat: a.lat + bestT * (b.lat - a.lat),
    lng: a.lng + bestT * (b.lng - a.lng),
  }
  const c = idx.cum[bestE]
  const alongM = c[bestK] + bestT * (c[bestK + 1] - c[bestK])
  const lenM = idx.lenM[bestE]
  return {
    edge: bestE,
    t: lenM > 0 ? Math.min(1, alongM / lenM) : 0,
    alongM,
    point: { lat: point.lat, lng: point.lng },
    distM: haversineDistanceM(p, point),
    query: { lat: p.lat, lng: p.lng },
  }
}

// ── Geometry helpers ────────────────────────────────────────────────────────────
function pointAtAlong(net: RoadNetwork, idx: NetIndex, e: number, s: number): LatLng {
  const pts = net.edges[e].points
  const c = idx.cum[e]
  if (s <= 0) return pts[0]
  if (s >= idx.lenM[e]) return pts[pts.length - 1]
  let lo = 0
  let hi = c.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (c[mid] <= s) lo = mid
    else hi = mid
  }
  const span = c[lo + 1] - c[lo]
  const f = span > 0 ? (s - c[lo]) / span : 0
  return { lat: pts[lo].lat + f * (pts[lo + 1].lat - pts[lo].lat), lng: pts[lo].lng + f * (pts[lo + 1].lng - pts[lo].lng) }
}

/** Points of edge `e` between along-distances a0 and a1 (either direction), endpoints optionally pinned. */
function sliceEdge(net: RoadNetwork, idx: NetIndex, e: number, a0: number, a1: number, p0?: LatLng, p1?: LatLng): LatLng[] {
  const pts = net.edges[e].points
  const c = idx.cum[e]
  const out: LatLng[] = [p0 ?? pointAtAlong(net, idx, e, a0)]
  if (a0 <= a1) {
    for (let i = 0; i < pts.length; i++) if (c[i] > a0 && c[i] < a1) out.push(pts[i])
  } else {
    for (let i = pts.length - 1; i >= 0; i--) if (c[i] < a0 && c[i] > a1) out.push(pts[i])
  }
  out.push(p1 ?? pointAtAlong(net, idx, e, a1))
  return out
}

interface Piece { pts: LatLng[]; speed: number; hidden: boolean }

function emptyRoute(gap: number): RoadRoute {
  return {
    status: 'no_access', points: [], cumDistM: [], edgeSpeeds: [], hiddenRanges: [], accessGapM: gap,
    lengthM: 0, cornerCapsMps: [], nominalSecAt: [], nominalTotalSec: 0,
  }
}

function flatBearing(a: LatLng, b: LatLng): number {
  const cos = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180)
  const dx = (b.lng - a.lng) * cos
  const dy = b.lat - a.lat
  return ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360
}

function segmentIndex(cum: number[], s: number): number {
  let lo = 0
  let hi = cum.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= s) lo = mid
    else hi = mid
  }
  return lo
}

function assemble(pieces: Piece[], first: LatLng | null, last: LatLng, gap: number): RoadRoute {
  const points: LatLng[] = []
  const segSpeed: number[] = []
  const segHidden: boolean[] = []
  for (const piece of pieces) {
    for (let i = 0; i < piece.pts.length; i++) {
      const pt = piece.pts[i]
      if (points.length === 0) { points.push(pt); continue }
      if (roadMetres(points[points.length - 1], pt) < DEDUPE_M) continue
      points.push(pt)
      segSpeed.push(piece.speed)
      segHidden.push(piece.hidden)
    }
  }
  if (first && points.length > 0 && roadMetres(points[0], first) < DEDUPE_M) points[0] = first
  if (points.length > 0 && roadMetres(points[points.length - 1], last) < DEDUPE_M) points[points.length - 1] = last
  const n = points.length
  const cumDistM: number[] = [0]
  for (let i = 1; i < n; i++) cumDistM.push(cumDistM[i - 1] + roadMetres(points[i - 1], points[i]))
  const hiddenRanges: Array<[number, number]> = []
  for (let i = 0; i < segHidden.length; i++) {
    if (!segHidden[i]) continue
    const prev = hiddenRanges[hiddenRanges.length - 1]
    if (prev && prev[1] === cumDistM[i]) prev[1] = cumDistM[i + 1]
    else hiddenRanges.push([cumDistM[i], cumDistM[i + 1]])
  }
  const cornerCapsMps: number[] = new Array(n)
  for (let j = 0; j < n; j++) {
    if (j === 0 || j === n - 1) { cornerCapsMps[j] = segSpeed[j === 0 ? 0 : n - 2] ?? MIN_ROUTE_SPEED_MPS; continue }
    const turn = Math.abs(angleDiffDeg(flatBearing(points[j - 1], points[j]), flatBearing(points[j], points[j + 1])))
    const k = Math.min(1, Math.max(0, (turn - 45) / 45))
    const vmin = Math.min(segSpeed[j - 1], segSpeed[j])
    cornerCapsMps[j] = vmin + (MIN_ROUTE_SPEED_MPS - vmin) * k
  }
  const route: RoadRoute = {
    status: 'ok', points, cumDistM, edgeSpeeds: segSpeed, hiddenRanges, accessGapM: gap,
    lengthM: cumDistM[n - 1] ?? 0, cornerCapsMps, nominalSecAt: [0], nominalTotalSec: 0,
  }
  // Remaining-time table: nominal seconds integrated every 5 m (midpoint speed), cumulative from the start.
  const L = route.lengthM
  const K = Math.ceil(L / NOMINAL_TABLE_STEP_M)
  const table: number[] = [0]
  for (let k = 0; k < K; k++) {
    const s0 = k * NOMINAL_TABLE_STEP_M
    const s1 = Math.min(L, (k + 1) * NOMINAL_TABLE_STEP_M)
    table.push(table[k] + (s1 - s0) / speedAt(route, (s0 + s1) / 2))
  }
  route.nominalSecAt = table
  route.nominalTotalSec = table[table.length - 1]
  return route
}

// ── Speed model ─────────────────────────────────────────────────────────────────
/**
 * Speed (m/s, nominal, before the weather divide) at distance `s` along the route: the edge speed,
 * pulled down toward each corner cap within 25 m of a vertex, never below 6 m/s. Pure.
 */
export function speedAt(route: RoadRoute, s: number): number {
  const n = route.cumDistM.length
  if (n < 2) return route.edgeSpeeds[0] ?? MIN_ROUTE_SPEED_MPS
  const cum = route.cumDistM
  const sc = Math.min(Math.max(s, 0), cum[n - 1])
  const i = segmentIndex(cum, sc)
  const v0 = route.edgeSpeeds[i]
  let v = v0
  for (let j = i; j >= 1; j--) {
    const d = Math.abs(sc - cum[j])
    if (d > CORNER_RADIUS_M) break
    const c = route.cornerCapsMps[j]
    v = Math.min(v, c + (v0 - c) * d / CORNER_RADIUS_M)
  }
  for (let j = i + 1; j <= n - 2; j++) {
    const d = Math.abs(cum[j] - sc)
    if (d > CORNER_RADIUS_M) break
    const c = route.cornerCapsMps[j]
    v = Math.min(v, c + (v0 - c) * d / CORNER_RADIUS_M)
  }
  return Math.max(MIN_ROUTE_SPEED_MPS, v)
}

/** Nominal seconds still to drive from distance `s` to the route end (before the weather multiplier). */
export function remainingNominalSec(route: RoadRoute, s: number): number {
  const table = route.nominalSecAt
  if (table.length < 2 || s >= route.lengthM) return 0
  const sc = Math.max(0, s)
  const k = Math.floor(sc / NOMINAL_TABLE_STEP_M)
  const s0 = k * NOMINAL_TABLE_STEP_M
  const s1 = Math.min(route.lengthM, (k + 1) * NOMINAL_TABLE_STEP_M)
  const f = s1 > s0 ? (sc - s0) / (s1 - s0) : 0
  const t = table[k] + f * (table[k + 1] - table[k])
  return Math.max(0, route.nominalTotalSec - t)
}

/** The point at distance `s` along the route (clamped to its ends). Always on a road edge. */
export function pointAtDistance(route: RoadRoute, s: number): LatLng {
  const n = route.points.length
  if (n === 0) return { lat: 0, lng: 0 }
  if (n === 1 || s <= 0) return route.points[0]
  if (s >= route.cumDistM[n - 1]) return route.points[n - 1]
  const i = segmentIndex(route.cumDistM, s)
  const span = route.cumDistM[i + 1] - route.cumDistM[i]
  const f = span > 0 ? (s - route.cumDistM[i]) / span : 0
  const a = route.points[i]
  const b = route.points[i + 1]
  return { lat: a.lat + f * (b.lat - a.lat), lng: a.lng + f * (b.lng - a.lng) }
}

/** The part of the route still ahead of distance `s`: the point at `s` followed by every later vertex. */
export function remainingPolyline(route: RoadRoute, s: number): LatLng[] {
  const n = route.points.length
  if (n === 0) return []
  if (n === 1 || s >= route.cumDistM[n - 1]) return [route.points[n - 1]]
  const i = segmentIndex(route.cumDistM, Math.max(0, s))
  return [pointAtDistance(route, s), ...route.points.slice(i + 1)]
}

/** Compass heading (degrees, 0 = north) of the route at distance `s`. */
export function headingAtDistance(route: RoadRoute, s: number): number {
  const n = route.points.length
  if (n < 2) return 0
  const i = segmentIndex(route.cumDistM, Math.min(Math.max(s, 0), route.cumDistM[n - 1]))
  return flatBearing(route.points[i], route.points[i + 1])
}

// ── A* ──────────────────────────────────────────────────────────────────────────
interface HeapItem { f: number; g: number; n: number }

function heapLess(x: HeapItem, y: HeapItem): boolean {
  if (x.f !== y.f) return x.f < y.f
  if (x.g !== y.g) return x.g < y.g
  return x.n < y.n
}

class MinHeap {
  private a: HeapItem[] = []
  get size(): number { return this.a.length }
  push(it: HeapItem): void {
    const a = this.a
    a.push(it)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!heapLess(a[i], a[p])) break
      ;[a[i], a[p]] = [a[p], a[i]]
      i = p
    }
  }
  pop(): HeapItem | undefined {
    const a = this.a
    if (a.length === 0) return undefined
    const top = a[0]
    const last = a.pop()!
    if (a.length > 0) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && heapLess(a[l], a[m])) m = l
        if (r < a.length && heapLess(a[r], a[m])) m = r
        if (m === i) break
        ;[a[i], a[m]] = [a[m], a[i]]
        i = m
      }
    }
    return top
  }
}

// predArc codes beyond real arc ids
const FROM_START = -1
const ORIGIN_TO_FROM_END = -2
const ORIGIN_TO_TO_END = -3
const TARGET_FROM_FROM_END = -4
const TARGET_FROM_TO_END = -5

/**
 * Fastest drivable route. `from` is a graph node index or a mid-edge origin snap; `to` is a target
 * snap. Cost is travel time (edge length / edge speed, floored at 6 m/s); corner caps slow the
 * vehicle after the route is chosen and are NOT part of the cost. Heuristic: 0.999 x chord / the
 * network's top speed, admissible and consistent. Heap order is (f, g, node id).
 */
export function routeOnRoads(net: RoadNetwork, from: number | SnapResult, to: SnapResult): RoadRoute {
  const idx = getIndex(net)
  const gap = Math.round(haversineDistanceM(to.point, to.query) * 10) / 10
  const eT = net.edges[to.edge]
  const bT = to.alongM
  const lenT = idx.lenM[to.edge]
  const vT = idx.speed[to.edge]
  const hiddenT = (eT.flags & FLAG_HIDDEN) !== 0

  // Same edge, direction allowed: the route is the sub-polyline between the two snap points.
  if (typeof from !== 'number' && from.edge === to.edge && (eT.oneway === 0 || from.alongM <= to.alongM)) {
    const pts = sliceEdge(net, idx, to.edge, from.alongM, to.alongM, from.point, to.point)
    return assemble([{ pts, speed: vT, hidden: hiddenT }], from.point, to.point, gap)
  }

  const N = net.nodes.length
  const VO = N
  const VT = N + 1
  const hv = Math.max(net.maxSpeed, MIN_ROUTE_SPEED_MPS)
  const originSnap = typeof from === 'number' ? null : from
  const g = new Float64Array(N + 2).fill(Infinity)
  const pred = new Int32Array(N + 2).fill(-1)
  const predArc = new Int32Array(N + 2).fill(FROM_START)
  const closed = new Uint8Array(N + 2)
  const h = (n: number): number => {
    if (n === VT) return 0
    const pt = n === VO ? originSnap!.point : net.nodes[n]
    return 0.999 * roadMetres(pt, to.point) / hv
  }
  const heap = new MinHeap()
  const start = originSnap ? VO : (from as number)
  if (!originSnap && (start < 0 || start >= N)) return emptyRoute(gap)
  g[start] = 0
  heap.push({ f: h(start), g: 0, n: start })

  const relax = (n: number, m: number, cost: number, code: number) => {
    const ng = g[n] + cost
    if (ng < g[m]) {
      g[m] = ng
      pred[m] = n
      predArc[m] = code
      heap.push({ f: ng + h(m), g: ng, n: m })
    }
  }

  while (heap.size > 0) {
    const cur = heap.pop()!
    const n = cur.n
    if (closed[n]) continue
    closed[n] = 1
    if (n === VT) break
    if (n === VO) {
      const eo = net.edges[originSnap!.edge]
      const lenO = idx.lenM[originSnap!.edge]
      const vO = idx.speed[originSnap!.edge]
      relax(n, eo.to, (lenO - originSnap!.alongM) / vO, ORIGIN_TO_TO_END)
      if (eo.oneway === 0) relax(n, eo.from, originSnap!.alongM / vO, ORIGIN_TO_FROM_END)
      continue
    }
    for (const arc of idx.adj[n]) {
      const e = idx.arcEdge[arc]
      relax(n, idx.arcTo[arc], idx.lenM[e] / idx.speed[e], arc)
    }
    if (n === eT.from) relax(n, VT, bT / vT, TARGET_FROM_FROM_END)
    if (eT.oneway === 0 && n === eT.to) relax(n, VT, (lenT - bT) / vT, TARGET_FROM_TO_END)
  }
  if (!closed[VT]) return emptyRoute(gap)

  // Walk the predecessor chain back to the start, then build the pieces forward.
  const chain: Array<{ code: number }> = []
  for (let n = VT; n !== start; n = pred[n]) chain.push({ code: predArc[n] })
  chain.reverse()
  const pieces: Piece[] = []
  for (const { code } of chain) {
    if (code === ORIGIN_TO_FROM_END || code === ORIGIN_TO_TO_END) {
      const o = originSnap!
      const e = o.edge
      const toEnd = code === ORIGIN_TO_TO_END
      pieces.push({
        pts: sliceEdge(net, idx, e, o.alongM, toEnd ? idx.lenM[e] : 0, o.point),
        speed: idx.speed[e],
        hidden: (net.edges[e].flags & FLAG_HIDDEN) !== 0,
      })
    } else if (code === TARGET_FROM_FROM_END || code === TARGET_FROM_TO_END) {
      pieces.push({
        pts: sliceEdge(net, idx, to.edge, code === TARGET_FROM_FROM_END ? 0 : lenT, bT, undefined, to.point),
        speed: vT,
        hidden: hiddenT,
      })
    } else {
      const e = idx.arcEdge[code]
      const pts = idx.arcRev[code] ? [...net.edges[e].points].reverse() : [...net.edges[e].points]
      pieces.push({ pts, speed: idx.speed[e], hidden: (net.edges[e].flags & FLAG_HIDDEN) !== 0 })
    }
  }
  return assemble(pieces, originSnap ? originSnap.point : net.nodes[start], to.point, gap)
}

// ── Access gap (memoised by contact id) ─────────────────────────────────────────
const gapMemo = new WeakMap<RoadNetwork, Map<string, { lat: number; lng: number; gap: number | null }>>()

/**
 * Straight distance from a contact to its road access point (metres, rounded to 0.1), or null when
 * no road qualifies. Computed once per contact and memoised by `sourceId` (the contact panel renders
 * often); a changed position under the same id is recomputed rather than served stale.
 */
export function contactAccessGapM(net: RoadNetwork, sourceId: string, position: LatLng): number | null {
  let byId = gapMemo.get(net)
  if (!byId) { byId = new Map(); gapMemo.set(net, byId) }
  const hit = byId.get(sourceId)
  if (hit && hit.lat === position.lat && hit.lng === position.lng) return hit.gap
  const snap = snapToRoad(net, position, { role: 'target' })
  const gap = snap ? Math.round(snap.distM * 10) / 10 : null
  byId.set(sourceId, { lat: position.lat, lng: position.lng, gap })
  return gap
}

// ── Entry staging ───────────────────────────────────────────────────────────────
/**
 * Choose the entry node that maximises the minimum angular separation (from the target) to every
 * existing approach bearing. Ties go to the lowest node id; entries that cannot reach the target
 * are skipped. Returns null when none qualifies.
 */
export function pickEntryNode(
  net: RoadNetwork,
  targetPos: LatLng,
  targetSnap: SnapResult,
  candidates: readonly number[],
  existingBearings: readonly number[],
): number | null {
  const sorted = [...candidates].sort((a, b) => a - b)
  let best = -1
  let bestSep = -Infinity
  for (const c of sorted) {
    if (c < 0 || c >= net.nodes.length) continue
    if (routeOnRoads(net, c, targetSnap).status !== 'ok') continue
    const brg = bearingDeg(targetPos, net.nodes[c])
    let sep = Infinity
    for (const b of existingBearings) sep = Math.min(sep, Math.abs(angleDiffDeg(brg, b)))
    if (best < 0 || sep > bestSep + 1e-3) { best = c; bestSep = sep }
  }
  return best < 0 ? null : best
}
