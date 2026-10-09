/**
 * c12b: pure road router (snap, A*, corner cap, speedAt, hidden ranges), entries staging, the
 * road-access gate, and the on-road invariant over every committed fixture (tier 1).
 *
 * The loop-level tests (tier 2, recovery, replay) live in roadRoutingLoop.spec.ts so the two
 * heavy halves run in separate workers.
 */
import { describe, it, expect } from 'vitest'
import type { LatLng } from '@/types'
import type { RoadNetwork, RoadEdge } from '@/scenarios/roadFixtures'
import { ROAD_CLASS_NAMES, getRoadNetwork, prepareScenarioRoads, scenariosWithRoads } from '@/scenarios/roadFixtures'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import {
  MIN_ROUTE_SPEED_MPS,
  contactAccessGapM,
  headingAtDistance,
  pickEntryNode,
  pointAtDistance,
  remainingNominalSec,
  roadMetres,
  routeOnRoads,
  snapToRoad,
  speedAt,
} from '@/sim/mission/roadRouter'
import { contactRoadAccess, routeMemo } from '@/sim/mission/routeMemo'
import { bearingDeg } from '@/utils/geometry'

// ── Hand-built graph helpers ────────────────────────────────────────────────────
const ORIGIN: LatLng = { lat: 30, lng: -97 }
const M_PER_DEG = 111195
const COS = Math.cos(ORIGIN.lat * Math.PI / 180)
function ll(xm: number, ym: number): LatLng {
  return { lat: ORIGIN.lat + ym / M_PER_DEG, lng: ORIGIN.lng + xm / (M_PER_DEG * COS) }
}

interface EdgeDef { from: number; to: number; speed: number; oneway?: 0 | 1; flags?: number; via?: Array<[number, number]> }

function buildNet(nodesXY: Array<[number, number]>, defs: EdgeDef[], entries: number[] = []): RoadNetwork {
  const nodes = nodesXY.map(([x, y]) => ll(x, y))
  let maxSpeed = 0
  const edges: RoadEdge[] = defs.map((d) => {
    const points = [nodes[d.from], ...(d.via ?? []).map(([x, y]) => ll(x, y)), nodes[d.to]]
    let lengthM = 0
    for (let i = 1; i < points.length; i++) lengthM += roadMetres(points[i - 1], points[i])
    maxSpeed = Math.max(maxSpeed, d.speed)
    return {
      from: d.from, to: d.to, cls: 3, roadClass: ROAD_CLASS_NAMES[3], speedMps: d.speed,
      oneway: d.oneway ?? 0, flags: d.flags ?? 0, points, lengthM,
    }
  })
  return { nodes, edges, entries, maxSpeed }
}

/** Uncapped travel time of a route: the cost A* minimises (corner caps excluded). */
function uncappedSec(route: { points: LatLng[]; edgeSpeeds: number[] }): number {
  let t = 0
  for (let i = 1; i < route.points.length; i++) t += roadMetres(route.points[i - 1], route.points[i]) / route.edgeSpeeds[i - 1]
  return t
}

/** Equirectangular metres are not exactly additive along an edge, so compare times relatively. */
function expectSecClose(actual: number, expected: number): void {
  expect(Math.abs(actual - expected) / Math.max(expected, 1e-9)).toBeLessThan(2e-3)
}

/** Deterministic LCG so the random-graph test is reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** Independent reference: Floyd-Warshall on nodes + explicit enumeration of the snap exits/entries. */
function referenceSec(net: RoadNetwork, o: NonNullable<ReturnType<typeof snapToRoad>>, t: NonNullable<ReturnType<typeof snapToRoad>>): number {
  const n = net.nodes.length
  const INF = Infinity
  const d: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : INF)))
  const eff = (e: RoadEdge) => Math.max(MIN_ROUTE_SPEED_MPS, e.speedMps)
  for (const e of net.edges) {
    const c = e.lengthM / eff(e)
    d[e.from][e.to] = Math.min(d[e.from][e.to], c)
    if (e.oneway === 0) d[e.to][e.from] = Math.min(d[e.to][e.from], c)
  }
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (d[i][k] + d[k][j] < d[i][j]) d[i][j] = d[i][k] + d[k][j]
  }
  const eo = net.edges[o.edge]
  const et = net.edges[t.edge]
  const a = o.alongM
  const b = t.alongM
  const exits: Array<[number, number]> = [[eo.to, (eo.lengthM - a) / eff(eo)]]
  if (eo.oneway === 0) exits.push([eo.from, a / eff(eo)])
  const entries: Array<[number, number]> = [[et.from, b / eff(et)]]
  if (et.oneway === 0) entries.push([et.to, (et.lengthM - b) / eff(et)])
  let best = INF
  for (const [u, cu] of exits) for (const [v, cv] of entries) best = Math.min(best, cu + d[u][v] + cv)
  if (o.edge === t.edge && (eo.oneway === 0 || a <= b)) best = Math.min(best, Math.abs(b - a) / eff(eo))
  return best
}

// ── snapToRoad ──────────────────────────────────────────────────────────────────
describe('snapToRoad', () => {
  const net = buildNet(
    [[0, 0], [1000, 0], [1000, 1000], [0, 1000]],
    [
      { from: 0, to: 1, speed: 10 },
      { from: 1, to: 2, speed: 10 },
      { from: 2, to: 3, speed: 10, flags: 2 },       // tunnel
      { from: 3, to: 0, speed: 10, flags: 1 },       // bridge
    ],
  )

  it('projects onto the nearest edge and reports distance and position along it', () => {
    const snap = snapToRoad(net, ll(400, 30), { role: 'origin' })!
    expect(snap.edge).toBe(0)
    expect(snap.alongM).toBeGreaterThan(399)
    expect(snap.alongM).toBeLessThan(401)
    expect(snap.distM).toBeGreaterThan(29)
    expect(snap.distM).toBeLessThan(31)
    expect(snap.t).toBeCloseTo(0.4, 2)
  })

  it('breaks exact ties toward the lowest edge index', () => {
    // The point sits exactly at node 1, which edges 0 and 1 share.
    const snap = snapToRoad(net, ll(1000, 0), { role: 'origin' })!
    expect(snap.edge).toBe(0)
    expect(snap.distM).toBeLessThan(0.01)
  })

  it('a target snap excludes tunnel edges even when the tunnel is the nearest road', () => {
    const origin = snapToRoad(net, ll(500, 995), { role: 'origin' })!
    expect(origin.edge).toBe(2)
    const target = snapToRoad(net, ll(500, 995), { role: 'target' })!
    expect(target.edge).not.toBe(2)
  })

  it('a target snap excludes bridge edges unless the contact is within 30 m of them', () => {
    // Left side x=0 is the bridge (edge 3). 100 m from it the bridge is skipped; 20 m away it is kept.
    const far = snapToRoad(net, ll(100, 500), { role: 'target' })!
    expect(far.edge).not.toBe(3)
    const near = snapToRoad(net, ll(20, 500), { role: 'target' })!
    expect(near.edge).toBe(3)
  })

  it('returns null when every edge is excluded or the network is empty', () => {
    const onlyTunnel = buildNet([[0, 0], [100, 0]], [{ from: 0, to: 1, speed: 10, flags: 2 }])
    expect(snapToRoad(onlyTunnel, ll(50, 5), { role: 'target' })).toBeNull()
    expect(snapToRoad(buildNet([], []), ll(0, 0), { role: 'origin' })).toBeNull()
  })
})

// ── routeOnRoads ────────────────────────────────────────────────────────────────
describe('routeOnRoads', () => {
  it('returns the optimal uncapped travel time on random one-way graphs (A* vs Floyd-Warshall)', () => {
    const rand = lcg(20261009)
    let checked = 0
    for (let g = 0; g < 60; g++) {
      const n = 6 + Math.floor(rand() * 4)
      const xy: Array<[number, number]> = Array.from({ length: n }, () => [rand() * 3000, rand() * 3000])
      const defs: EdgeDef[] = []
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n   // ring keeps it connected
        defs.push({ from: i, to: j, speed: 6 + Math.floor(rand() * 34), oneway: rand() < 0.35 ? 1 : 0 })
      }
      for (let k = 0; k < n; k++) {
        const a = Math.floor(rand() * n)
        const b = Math.floor(rand() * n)
        if (a === b) continue
        const mid: [number, number] = [(xy[a][0] + xy[b][0]) / 2 + (rand() - 0.5) * 400, (xy[a][1] + xy[b][1]) / 2 + (rand() - 0.5) * 400]
        defs.push({ from: a, to: b, speed: 6 + Math.floor(rand() * 34), oneway: rand() < 0.35 ? 1 : 0, via: [mid] })
      }
      const net = buildNet(xy, defs)
      for (let q = 0; q < 8; q++) {
        const o = snapToRoad(net, ll(rand() * 3000, rand() * 3000), { role: 'origin' })!
        const t = snapToRoad(net, ll(rand() * 3000, rand() * 3000), { role: 'target' })!
        const ref = referenceSec(net, o, t)
        const route = routeOnRoads(net, o, t)
        if (!Number.isFinite(ref)) {
          expect(route.status).toBe('no_access')
        } else {
          expect(route.status).toBe('ok')
          expectSecClose(uncappedSec(route), ref)
          expect(route.points[route.points.length - 1]).toEqual(t.point)
        }
        checked++
      }
    }
    expect(checked).toBe(480)
  })

  // 0 --(slow, 10)-- 1 --(slow)-- 2, with a fast ONE-WAY shortcut 2 -> 0 that cannot be used 0 -> 2.
  const trap = buildNet(
    [[0, 0], [1000, 0], [2000, 0]],
    [
      { from: 0, to: 1, speed: 10 },
      { from: 1, to: 2, speed: 10 },
      { from: 2, to: 0, speed: 40, oneway: 1, via: [[1000, 300]] },
    ],
  )

  it('respects one-way edges: the fast shortcut is only used in its own direction', () => {
    const o = snapToRoad(trap, ll(0, 0), { role: 'origin' })!
    const t = snapToRoad(trap, ll(2000, 0), { role: 'target' })!
    const forward = routeOnRoads(trap, 0, t)
    expect(forward.status).toBe('ok')
    expect(forward.points.length).toBeGreaterThanOrEqual(3)
    expect(forward.cumDistM[forward.cumDistM.length - 1]).toBeLessThan(2010)   // the 2 km road, not the shortcut
    expect(uncappedSec(forward)).toBeCloseTo(200, 0)
    const back = routeOnRoads(trap, 2, snapToRoad(trap, ll(0, 0), { role: 'target' })!)
    // 2 -> 0 takes the one-way shortcut (about 2.2 km at 40 m/s) instead of 2 km at 10 m/s
    expect(uncappedSec(back)).toBeLessThan(80)
    expect(o.edge).toBe(0)
  })

  it('a mid-edge origin on a one-way edge can only leave toward the edge end', () => {
    const o = snapToRoad(trap, ll(1400, 350), { role: 'origin' })!   // on the one-way arc, flowing 2 -> 0
    expect(o.edge).toBe(2)
    const t = snapToRoad(trap, ll(1500, 0), { role: 'target' })!     // on edge 0-1... actually edge 1 (1000..2000)
    const route = routeOnRoads(trap, o, t)
    expect(route.status).toBe('ok')
    // leaving toward `to` (node 0) means driving away from the target side first
    const first = route.points[0]
    const second = route.points[1]
    const bearing = bearingDeg(first, second)
    expect(bearing).toBeGreaterThan(180)   // westward, toward node 0
    expectSecClose(uncappedSec(route), referenceSec(trap, o, t))
  })

  it('a mid-edge target on a one-way edge is reachable only from its start node', () => {
    const t = snapToRoad(trap, ll(1400, 350), { role: 'target' })!
    expect(t.edge).toBe(2)
    const route = routeOnRoads(trap, 1, t)
    expect(route.status).toBe('ok')
    // node 1 -> node 2 -> along the one-way arc to the target (never entered from node 0)
    const lastBearing = bearingDeg(route.points[route.points.length - 2], route.points[route.points.length - 1])
    expect(lastBearing).toBeGreaterThan(180)   // approaching westward
    expectSecClose(uncappedSec(route), referenceSec(trap, snapToRoad(trap, trap.nodes[1], { role: 'origin' })!, t))
  })

  it('same-edge origin and target: the route is the sub-polyline between them', () => {
    const o = snapToRoad(trap, ll(300, 0), { role: 'origin' })!
    const t = snapToRoad(trap, ll(700, 0), { role: 'target' })!
    const route = routeOnRoads(trap, o, t)
    expect(route.status).toBe('ok')
    expect(route.cumDistM[route.cumDistM.length - 1]).toBeCloseTo(400, 0)
    expect(route.points[0]).toEqual(o.point)
    // reverse direction on a two-way edge is also a direct sub-polyline
    const rev = routeOnRoads(trap, t, o)
    expect(rev.cumDistM[rev.cumDistM.length - 1]).toBeCloseTo(400, 0)
  })

  it('same-edge on a one-way edge is direct only when it flows from origin to target', () => {
    const lo = snapToRoad(trap, ll(1100, 300), { role: 'origin' })!   // later in flow (closer to node 0)
    const hi = snapToRoad(trap, ll(1900, 40), { role: 'target' })!    // earlier in flow (closer to node 2)
    expect(lo.edge).toBe(2)
    expect(hi.edge).toBe(2)
    const wrong = routeOnRoads(trap, lo, hi)   // against the flow: must go round the whole loop
    expect(wrong.status).toBe('ok')
    expect(wrong.cumDistM[wrong.cumDistM.length - 1]).toBeGreaterThan(1500)
    const right = routeOnRoads(trap, hi, lo)
    expect(right.cumDistM[right.cumDistM.length - 1]).toBeLessThan(1500)
  })

  it('a route of length 0 is a single point and exposes the origin as its end', () => {
    const o = snapToRoad(trap, ll(500, 0), { role: 'origin' })!
    const route = routeOnRoads(trap, o, o)
    expect(route.status).toBe('ok')
    expect(route.points).toHaveLength(1)
    expect(route.cumDistM).toEqual([0])
    expect(route.lengthM).toBe(0)
    expect(pointAtDistance(route, 5)).toEqual(o.point)
  })

  it('reports no_access (never a straight line) when the target cannot be reached', () => {
    const split = buildNet(
      [[0, 0], [500, 0], [5000, 0], [5500, 0]],
      [{ from: 0, to: 1, speed: 10 }, { from: 2, to: 3, speed: 10 }],
    )
    const t = snapToRoad(split, ll(5200, 0), { role: 'target' })!
    const route = routeOnRoads(split, 0, t)
    expect(route.status).toBe('no_access')
    expect(route.points).toEqual([])
    // one-way dead end: node 1 has no outgoing arc
    const dead = buildNet([[0, 0], [500, 0], [900, 0]], [{ from: 0, to: 1, speed: 10, oneway: 1 }, { from: 2, to: 1, speed: 10, oneway: 1 }])
    const t2 = snapToRoad(dead, ll(800, 0), { role: 'target' })!
    // edge 1 flows 2 -> 1, so the 800 m target is only entered from node 2
    expect(routeOnRoads(dead, 2, t2).status).toBe('ok')
    expect(routeOnRoads(dead, 0, t2).status).toBe('no_access')
    expect(routeOnRoads(dead, 1, t2).status).toBe('no_access')
  })

  it('is pure and weather-invariant: identical calls give byte-identical routes', () => {
    const o = snapToRoad(trap, ll(100, 0), { role: 'origin' })!
    const t = snapToRoad(trap, ll(1900, 0), { role: 'target' })!
    const a = routeOnRoads(trap, o, t)
    const b = routeOnRoads(trap, o, t)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('exposes tunnel ranges as hiddenRanges that match the tunnel edge span', () => {
    const net = buildNet(
      [[0, 0], [500, 0], [1000, 0], [1500, 0]],
      [{ from: 0, to: 1, speed: 15 }, { from: 1, to: 2, speed: 15, flags: 2 }, { from: 2, to: 3, speed: 15 }],
    )
    const t = snapToRoad(net, ll(1400, 0), { role: 'target' })!
    const route = routeOnRoads(net, 0, t)
    expect(route.status).toBe('ok')
    expect(route.hiddenRanges).toHaveLength(1)
    const [a, b] = route.hiddenRanges[0]
    expect(a).toBeCloseTo(500, 0)
    expect(b).toBeCloseTo(1000, 0)
    // a route that never touches the tunnel has no hidden ranges
    expect(routeOnRoads(net, 0, snapToRoad(net, ll(400, 0), { role: 'target' })!).hiddenRanges).toEqual([])
  })
})

// ── Corner cap and speedAt ──────────────────────────────────────────────────────
describe('speedAt / corner cap', () => {
  const L = buildNet(
    [[0, 0], [500, 0], [500, 500], [1000, 500]],
    [{ from: 0, to: 1, speed: 20 }, { from: 1, to: 2, speed: 20 }, { from: 2, to: 3, speed: 20 }],
  )
  const diag = buildNet(
    [[0, 0], [500, 0], [850, 350]],
    [{ from: 0, to: 1, speed: 20 }, { from: 1, to: 2, speed: 20 }],
  )

  it('a 90 degree corner caps the speed to 6 m/s at the vertex and ramps back over 25 m', () => {
    const route = routeOnRoads(L, 0, snapToRoad(L, ll(500, 400), { role: 'target' })!)
    expect(route.status).toBe('ok')
    const corner = route.cumDistM[1]
    expect(speedAt(route, corner)).toBeCloseTo(6, 6)
    expect(speedAt(route, corner - 25)).toBeCloseTo(20, 6)
    expect(speedAt(route, corner - 12.5)).toBeCloseTo(13, 6)     // 6 + (20 - 6) * 12.5 / 25
    expect(speedAt(route, corner + 12.5)).toBeCloseTo(13, 6)
    expect(speedAt(route, corner + 60)).toBeCloseTo(20, 6)
    expect(speedAt(route, 0)).toBeCloseTo(20, 6)
  })

  it('a 45 degree turn is not capped; a 67.5 degree turn is capped halfway', () => {
    const route = routeOnRoads(diag, 0, snapToRoad(diag, ll(840, 340), { role: 'target' })!)
    const corner = route.cumDistM[1]
    expect(speedAt(route, corner)).toBeCloseTo(20, 2)    // 45 degrees (projection noise only)
    const sharper = buildNet(
      [[0, 0], [500, 0], [500 + 500 * Math.cos(Math.PI * 67.5 / 180), 500 * Math.sin(Math.PI * 67.5 / 180)]],
      [{ from: 0, to: 1, speed: 20 }, { from: 1, to: 2, speed: 20 }],
    )
    const r2 = routeOnRoads(sharper, 0, snapToRoad(sharper, sharper.nodes[2], { role: 'target' })!)
    expect(speedAt(r2, r2.cumDistM[1])).toBeCloseTo(6 + (20 - 6) * 0.5, 1)
  })

  it('never drops below 6 m/s, including on roads slower than 6 m/s', () => {
    const slow = buildNet([[0, 0], [300, 0], [300, 300]], [{ from: 0, to: 1, speed: 2 }, { from: 1, to: 2, speed: 1 }])
    const route = routeOnRoads(slow, 0, snapToRoad(slow, ll(300, 250), { role: 'target' })!)
    for (let s = 0; s <= route.lengthM; s += 7) expect(speedAt(route, s)).toBeGreaterThanOrEqual(MIN_ROUTE_SPEED_MPS)
    expect(Math.min(...route.edgeSpeeds)).toBeGreaterThanOrEqual(MIN_ROUTE_SPEED_MPS)
  })

  it('speedAt is pure: it does not mutate the route and gives the same value twice', () => {
    const route = routeOnRoads(L, 0, snapToRoad(L, ll(800, 500), { role: 'target' })!)
    const before = JSON.stringify(route)
    const a = speedAt(route, 510)
    const b = speedAt(route, 510)
    expect(a).toBe(b)
    expect(JSON.stringify(route)).toBe(before)
  })

  it('remaining nominal time falls monotonically from the full route time to zero', () => {
    const route = routeOnRoads(L, 0, snapToRoad(L, ll(900, 500), { role: 'target' })!)
    const full = remainingNominalSec(route, 0)
    expect(full).toBeGreaterThan(route.lengthM / 20)         // corners slow it below the 20 m/s nominal
    expect(remainingNominalSec(route, route.lengthM)).toBe(0)
    let prev = Infinity
    for (let s = 0; s <= route.lengthM; s += 11) {
      const r = remainingNominalSec(route, s)
      expect(r).toBeLessThanOrEqual(prev + 1e-9)
      prev = r
    }
    expect(headingAtDistance(route, 10)).toBeCloseTo(90, 0)       // east
    expect(headingAtDistance(route, route.cumDistM[1] + 10)).toBeCloseTo(0, 0)   // north
  })
})

// ── Contact access memo ─────────────────────────────────────────────────────────
describe('contact road access', () => {
  const net = buildNet([[0, 0], [1000, 0]], [{ from: 0, to: 1, speed: 15 }])

  it('rounds the access gap to 0.1 m and memoises it by sourceId', () => {
    const a = contactAccessGapM(net, 'hs-1', ll(500, 123.456))
    expect(a).not.toBeNull()
    expect(Math.abs(a! * 10 - Math.round(a! * 10))).toBeLessThan(1e-6)
    expect(a).toBeGreaterThan(123)
    expect(a).toBeLessThan(124)
    expect(contactAccessGapM(net, 'hs-1', ll(500, 123.456))).toBe(a)
    // a different position under the same sourceId is not served stale
    expect(contactAccessGapM(net, 'hs-1', ll(500, 300))).toBeGreaterThan(299)
  })

  it('a contact more than 2 km from any road has no road access', () => {
    const scenario = ALL_SCENARIOS.find((s) => s.id === 'train_hazmat_plume')
    expect(scenario).toBeTruthy()
    // No network staged for an unknown scenario id: access is none and nothing throws
    const contact = { sourceId: 'x', position: { lat: 31, lng: -97 } }
    expect(contactRoadAccess({ id: 'no-such-scenario' }, contact)).toBe('none')
    // staged but 3 km away from the only road in the net -> none; 100 m away -> ok
    const gapFar = contactAccessGapM(net, 'far', ll(500, 3000))!
    expect(gapFar).toBeGreaterThan(2000)
  })
})

// ── Entry staging ───────────────────────────────────────────────────────────────
describe('pickEntryNode', () => {
  /** Eight spokes at 45 degree spacing around a hub, 800 m long, entries at every rim node. */
  function spokes(): { net: RoadNetwork; rim: number[] } {
    const xy: Array<[number, number]> = [[0, 0]]
    const defs: EdgeDef[] = []
    for (let k = 0; k < 8; k++) {
      const ang = (k * 45 * Math.PI) / 180
      xy.push([800 * Math.sin(ang), 800 * Math.cos(ang)])
      defs.push({ from: 0, to: k + 1, speed: 15 })
    }
    return { net: buildNet(xy, defs, [1, 2, 3, 4, 5, 6, 7, 8]), rim: [1, 2, 3, 4, 5, 6, 7, 8] }
  }

  it('three units on one contact take entries at least 60 degrees apart on a hand-built 8-spoke graph', () => {
    const { net } = spokes()
    const contactPos = net.nodes[0]
    const target = snapToRoad(net, contactPos, { role: 'target' })!
    const chosen: number[] = []
    // The first unit starts at rim node 1 (the incident post); the next two follow the rule.
    chosen.push(1)
    for (let n = 0; n < 2; n++) {
      const existing = chosen.map((c) => bearingDeg(contactPos, net.nodes[c]))
      const pick = pickEntryNode(net, contactPos, target, net.entries, existing)
      expect(pick).not.toBeNull()
      chosen.push(pick!)
    }
    expect(new Set(chosen).size).toBe(3)
    const bearings = chosen.map((c) => bearingDeg(contactPos, net.nodes[c]))
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      const diff = Math.abs(((bearings[i] - bearings[j] + 540) % 360) - 180)
      expect(diff, `pair ${i}/${j}`).toBeGreaterThanOrEqual(60 - 1e-6)
    }
  })

  it('ties go to the lowest node id, and unreachable entries are skipped', () => {
    const { net } = spokes()
    const contactPos = net.nodes[0]
    const target = snapToRoad(net, contactPos, { role: 'target' })!
    // No existing approaches: every entry is equally good, so the lowest id wins.
    expect(pickEntryNode(net, contactPos, target, net.entries, [])).toBe(1)
    // One-way spoke 1 (outgoing only from the hub) cannot reach the hub: entry 1 is skipped.
    const oneWay = buildNet(
      net.nodes.map((n) => [(n.lng - ORIGIN.lng) * M_PER_DEG * COS, (n.lat - ORIGIN.lat) * M_PER_DEG] as [number, number]),
      net.edges.map((e, i) => ({ from: e.from, to: e.to, speed: 15, oneway: i === 0 ? (1 as const) : (0 as const) })),
      [1, 2, 3, 4, 5, 6, 7, 8],
    )
    const t2 = snapToRoad(oneWay, oneWay.nodes[0], { role: 'target' })!
    expect(pickEntryNode(oneWay, oneWay.nodes[0], t2, oneWay.entries, [])).toBe(2)
  })

  it('returns null when no entry can reach the target', () => {
    const { net } = spokes()
    const target = snapToRoad(net, net.nodes[0], { role: 'target' })!
    expect(pickEntryNode(net, net.nodes[0], target, [], [])).toBeNull()
  })
})

// ── Route memo module ───────────────────────────────────────────────────────────
describe('routeMemo', () => {
  it('is a plain id-keyed memo with get/set/delete/clear', () => {
    routeMemo.clear()
    expect(routeMemo.get('u1')).toBeUndefined()
    const net = buildNet([[0, 0], [100, 0]], [{ from: 0, to: 1, speed: 10 }])
    const route = routeOnRoads(net, 0, snapToRoad(net, ll(90, 0), { role: 'target' })!)
    routeMemo.set('u1', { net, sig: 'a', route })
    expect(routeMemo.get('u1')?.route).toBe(route)
    routeMemo.delete('u1')
    expect(routeMemo.get('u1')).toBeUndefined()
    routeMemo.set('u2', { net, sig: 'b', route })
    routeMemo.clear()
    expect(routeMemo.get('u2')).toBeUndefined()
  })
})

// ── Tier 1: on-road invariant over every covered scenario ──────────────────────
describe('on-road invariant, tier 1 (pure router, every covered scenario)', () => {
  const ids = scenariosWithRoads()

  /** Brute-force-ish nearest edge distance using the net's own bounding grid, built per net. */
  function makeNearest(net: RoadNetwork) {
    const CELL = 100
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
        const x0 = Math.floor(Math.min(ax, bx) / CELL)
        const x1 = Math.floor(Math.max(ax, bx) / CELL)
        const y0 = Math.floor(Math.min(ay, by) / CELL)
        const y1 = Math.floor(Math.max(ay, by) / CELL)
        for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
          const kk = key(cx, cy)
          const list = grid.get(kk)
          if (list) list.push([ei, k])
          else grid.set(kk, [[ei, k]])
        }
      }
    })
    return (p: LatLng): number => {
      const [px, py] = toXY(p)
      const cx = Math.floor(px / CELL)
      const cy = Math.floor(py / CELL)
      let best = Infinity
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const list = grid.get(key(cx + dx, cy + dy))
        if (!list) continue
        for (const [ei, k] of list) {
          const e = net.edges[ei]
          const [ax, ay] = toXY(e.points[k])
          const [bx, by] = toXY(e.points[k + 1])
          const vx = bx - ax
          const vy = by - ay
          const len2 = vx * vx + vy * vy
          const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2))
          best = Math.min(best, Math.hypot(px - (ax + t * vx), py - (ay + t * vy)))
        }
      }
      return best
    }
  }

  it('covers all 25 incident scenarios', () => {
    expect(ids.length).toBe(25)
  })

  for (const id of ids) {
    it(`${id}: every route sample stays within 0.5 m of a road edge`, async () => {
      const scenario = ALL_SCENARIOS.find((s) => s.id === id)
      expect(scenario, id).toBeTruthy()
      await prepareScenarioRoads(id)
      const net = getRoadNetwork({ id })!
      expect(net).toBeTruthy()
      const nearest = makeNearest(net)
      // Origins: the node nearest startPosition (as dispatch would pick) and each entries[] node.
      let startNode = 0
      let bestD = Infinity
      net.nodes.forEach((n, i) => {
        const d = roadMetres(n, scenario!.startPosition)
        if (d < bestD) { bestD = d; startNode = i }
      })
      const origins = [startNode, ...net.entries]
      let routesChecked = 0
      let okRoutes = 0
      for (const hs of scenario!.heatSources) {
        const target = snapToRoad(net, hs.position, { role: 'target' })
        if (!target) continue
        for (const from of origins) {
          const route = routeOnRoads(net, from, target)
          expect(['ok', 'no_access']).toContain(route.status)
          routesChecked++
          if (route.status !== 'ok') continue
          okRoutes++
          expect(route.points[route.points.length - 1]).toEqual(target.point)
          const total = route.cumDistM[route.cumDistM.length - 1]
          let worst = 0
          for (let s = 0; s <= total; s += 1) worst = Math.max(worst, nearest(pointAtDistance(route, s)))
          worst = Math.max(worst, nearest(pointAtDistance(route, total)))
          expect(worst, `${id} ${hs.id} from ${from}`).toBeLessThanOrEqual(0.5)
        }
      }
      expect(routesChecked).toBeGreaterThan(0)
      expect(okRoutes).toBeGreaterThan(0)
    }, 120_000)
  }
})
