#!/usr/bin/env node
// Authoring-time Overture road-network fixture generator (DEMO_BLOCKERS c12a).
//
// Downloads a frozen extract of Overture `transportation/segment` (drivable roads) plus `water`
// (validation only, never shipped), reduces it to a compact, validated, strongly connected
// directed graph and writes src/scenarios/fixtures/<id>/roads.json. The app imports the result
// through src/scenarios/roadFixtures.ts and never fetches roads while running.
//
//   node --max-old-space-size=4096 tools/fixtures/roads.mjs --id hist_marshall_fire_2021
//   node tools/fixtures/roads.mjs --id demo_basic --input raw-segments.geojson --water-input raw-water.geojson
//   node tools/fixtures/roads.mjs --id demo_basic --bbox -122.5,37.7,-122.4,37.8
//
// The box comes from tools/fixtures/roadTargets.json (written by src/tests/roadTargets.gen.spec.ts);
// --bbox overrides it. A scenario that cannot be shipped is PARKED in roadTargets.json `parked[]`
// (reasons: download_failed, no_network, budget) and gets no roads.json; the run continues.
//
// Real Overture shapes this parser relies on were read from a downloaded file, not the docs:
//   road_flags        [{values:[...], between:null|[a,b]}] | null
//   access_restrictions [{access_type, when:null|{during,heading,using,recognized,mode,vehicle}, between}] | null
//   speed_limits      [{max_speed:{value,unit:'mph'|'km/h'}, when:null, between:null|[a,b]}] | null
//   connectors        [{connector_id, at}] sorted by `at`, first 0 and last 1
//   water             Polygon/LineString/Point; subtype+class; `is_intermittent` present only when true

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

export const OVERTURE_ROADS_SOURCE = 'Overture Maps Foundation — transportation theme'
export const OVERTURE_ROADS_LICENSE = 'ODbL 1.0'
export const OVERTURE_ROADS_DOCS = 'https://docs.overturemaps.org/guides/transportation/'
export const OVERTURE_ROADS_ATTRIBUTION = '© OpenStreetMap contributors, Overture Maps Foundation'
// The buildings pin (2026-08-19.0) predates the current release. Overture keeps ~2 monthly
// releases on S3, so roads use the CURRENT release at authoring time (2026-10-09) and record it.
export const OVERTURE_ROADS_DATA_RELEASE = '2026-09-23.1'
// The release's schema version is not present in the downloaded features; docs.overturemaps.org
// listed v2.0.0 as current on 2026-10-09. The parser was validated against the real file instead.
export const OVERTURE_ROADS_SCHEMA_VERSION = 'v2.0.0 (per docs 2026-10-09; shapes verified against the downloaded file)'
export const OVERTURE_ROADS_CLIENT_VERSION = '1.0.2'
export const OVERTURE_ROADS_STAC_COLLECTION =
  `https://stac.overturemaps.org/${OVERTURE_ROADS_DATA_RELEASE}/transportation/segment/collection.json`

export const MAX_SCENARIO_BYTES = 500 * 1024
export const ROAD_FORMAT_VERSION = 1
export const ROAD_SCALE = 1e6
export const WATER_TOLERANCE_M = 8
export const MIN_COMPONENT_EDGES = 20
export const MIN_EDGE_LENGTH_M = 0.5

/** Class order is the on-disk class code (index). */
export const ROAD_CLASSES = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'unclassified', 'residential', 'living_street', 'service', 'track',
]
export const CLASS_SPEED_CAP_MPS = {
  motorway: 29, trunk: 25, primary: 20, secondary: 17, tertiary: 14,
  unclassified: 12, residential: 11, living_street: 6, service: 5, track: 6,
}
const DROP_SUBCLASSES = new Set(['driveway', 'parking_aisle', 'sidewalk', 'crosswalk', 'cycle_crossing'])
const DROP_FLAGS = new Set(['is_under_construction', 'is_abandoned', 'is_indoor'])
const VEHICLE_MODES = new Set(['vehicle', 'motor_vehicle', 'car', 'truck'])
const SKIP_WATER_CLASSES = new Set(['swimming_pool', 'fountain', 'drain'])
export const FLAG_BRIDGE = 1
export const FLAG_HIDDEN = 2 // tunnel or covered

// ── geometry helpers (local equirectangular metres) ──────────────────────────────────────────
const M_PER_DEG = 111195
const makeProjector = (latRef, lngRef) => {
  const cos = Math.cos((latRef * Math.PI) / 180)
  return {
    x: (lng) => (lng - lngRef) * cos * M_PER_DEG,
    y: (lat) => (lat - latRef) * M_PER_DEG,
  }
}
const dist2d = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by)

function polylineLengthM(pts, proj) {
  let total = 0
  for (let i = 1; i < pts.length; i++) {
    total += dist2d(proj.x(pts[i - 1][0]), proj.y(pts[i - 1][1]), proj.x(pts[i][0]), proj.y(pts[i][1]))
  }
  return total
}

function distPointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  return dist2d(px, py, ax + t * dx, ay + t * dy)
}

function minDistToPolylineM(point, pts, proj) {
  const px = proj.x(point.lng)
  const py = proj.y(point.lat)
  let best = Infinity
  for (let i = 1; i < pts.length; i++) {
    best = Math.min(best, distPointToSegment(
      px, py, proj.x(pts[i - 1][0]), proj.y(pts[i - 1][1]), proj.x(pts[i][0]), proj.y(pts[i][1]),
    ))
  }
  return best
}

/** Douglas–Peucker over [x,y] metre points; returns kept indices (always the endpoints). */
function douglasPeuckerIndices(xy, tolerance) {
  const n = xy.length
  if (n <= 2) return Array.from({ length: n }, (_, i) => i)
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack = [[0, n - 1]]
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()
    let worst = -1
    let worstD = tolerance
    for (let i = lo + 1; i < hi; i++) {
      const d = distPointToSegment(xy[i][0], xy[i][1], xy[lo][0], xy[lo][1], xy[hi][0], xy[hi][1])
      if (d > worstD) { worstD = d; worst = i }
    }
    if (worst >= 0) {
      keep[worst] = 1
      stack.push([lo, worst], [worst, hi])
    }
  }
  const out = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i)
  return out
}

// ── access / speed / flag normalisation (pure, exported for tests) ───────────────────────────

/**
 * Per-direction vehicle access. Rules are walked in list order and the LAST applicable rule wins.
 * A rule applies when its mode is absent or names a vehicle mode, its heading is absent or equals
 * the direction, and none of during/using/recognized/vehicle/between are set. Rules naming a
 * vehicle mode but carrying any of those other scopes are skipped and counted as ambiguous.
 */
export function directionalAccess(restrictions) {
  const result = { forward: true, backward: true, ambiguous: 0 }
  if (!Array.isArray(restrictions)) return result
  for (const rule of restrictions) {
    const when = rule?.when ?? null
    const modes = when?.mode ?? null
    if (Array.isArray(modes) && modes.length > 0 && !modes.some((m) => VEHICLE_MODES.has(m))) continue
    const scoped = (when?.during ?? null) !== null
      || (when?.using ?? null) !== null
      || (when?.recognized ?? null) !== null
      || (when?.vehicle ?? null) !== null
      || (rule?.between ?? null) !== null
    if (scoped) { result.ambiguous++; continue }
    const allowed = rule.access_type === 'allowed' || rule.access_type === 'designated'
    const heading = when?.heading ?? null
    if (heading === null || heading === 'forward') result.forward = allowed
    if (heading === null || heading === 'backward') result.backward = allowed
  }
  return result
}

/** A bare array of strings means "whole segment"; otherwise [{values, between}]. */
export function normalizeRoadFlags(roadFlags) {
  if (!Array.isArray(roadFlags) || roadFlags.length === 0) return []
  if (roadFlags.every((entry) => typeof entry === 'string')) return [{ values: roadFlags, between: null }]
  return roadFlags
    .filter((entry) => entry && Array.isArray(entry.values))
    .map((entry) => ({
      values: entry.values,
      between: Array.isArray(entry.between) && entry.between.length === 2 ? [Number(entry.between[0]), Number(entry.between[1])] : null,
    }))
}

const flagBits = (values) =>
  (values.includes('is_bridge') ? FLAG_BRIDGE : 0)
  | (values.includes('is_tunnel') || values.includes('is_covered') ? FLAG_HIDDEN : 0)

/** Whole-segment speed limit in m/s (both `when` and `between` null), or null. */
export function wholeSegmentLimitMps(speedLimits) {
  if (!Array.isArray(speedLimits)) return null
  for (const rule of speedLimits) {
    if ((rule?.when ?? null) !== null || (rule?.between ?? null) !== null) continue
    const value = Number(rule?.max_speed?.value)
    if (!(value > 0)) continue
    if (rule.max_speed.unit === 'mph') return value * 0.44704
    if (rule.max_speed.unit === 'km/h') return value / 3.6
  }
  return null
}

/** Edge speed in 0.5 m/s steps (floor, so the cap is never exceeded), min 1 m/s. */
export function edgeSpeedCode(roadClass, limitMps) {
  const cap = CLASS_SPEED_CAP_MPS[roadClass]
  const speed = limitMps === null ? cap : Math.min(limitMps * 1.15, cap)
  return Math.max(2, Math.floor(speed * 2 + 1e-9))
}

// ── segment → edges ──────────────────────────────────────────────────────────────────────────

/**
 * Keep drivable road segments. `ctx` carries ladder choices: dropClasses, serviceNearOnly
 * ({points, radiusM}), residentialNearOnly ({points, radiusM}), box (w,s,e,n) and proj.
 */
export function selectSegments(features, ctx) {
  const stats = { input: 0, kept: 0, ambiguousAccessRules: 0, droppedByAccess: 0 }
  const segments = []
  for (const feature of features) {
    stats.input++
    const p = feature.properties ?? {}
    if (p.subtype !== 'road') continue
    if (!ROAD_CLASSES.includes(p.class)) continue
    if (ctx.dropClasses?.has(p.class)) continue
    if (DROP_SUBCLASSES.has(p.subclass)) continue
    if (feature.geometry?.type !== 'LineString' || feature.geometry.coordinates.length < 2) continue
    const flagRules = normalizeRoadFlags(p.road_flags)
    if (flagRules.some((rule) => rule.values.some((v) => DROP_FLAGS.has(v)))) continue
    const connectors = (p.connectors ?? []).map((c) => ({ id: c.connector_id, at: Number(c.at) }))
    if (connectors.length < 2) continue
    connectors.sort((a, b) => a.at - b.at)

    const geom = feature.geometry.coordinates.map((c) => [c[0], c[1]])
    if (ctx.box) {
      const [w, s, e, n] = ctx.box
      let minLng = Infinity; let maxLng = -Infinity; let minLat = Infinity; let maxLat = -Infinity
      for (const [lng, lat] of geom) {
        minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng)
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat)
      }
      if (maxLng < w || minLng > e || maxLat < s || minLat > n) continue
    }
    if (p.class === 'service' && ctx.serviceNearOnly) {
      const near = ctx.serviceNearOnly.points.some((pt) => minDistToPolylineM(pt, geom, ctx.proj) <= ctx.serviceNearOnly.radiusM)
      if (!near) continue
    }
    if ((p.class === 'residential' || p.class === 'living_street') && ctx.residentialNearOnly) {
      const near = ctx.residentialNearOnly.points.some((pt) => minDistToPolylineM(pt, geom, ctx.proj) <= ctx.residentialNearOnly.radiusM)
      if (!near) continue
    }

    const access = directionalAccess(p.access_restrictions)
    stats.ambiguousAccessRules += access.ambiguous
    if (!access.forward && !access.backward) { stats.droppedByAccess++; continue }

    segments.push({
      id: String(feature.id ?? p.id),
      roadClass: p.class,
      geom,
      connectors,
      fwd: access.forward,
      bwd: access.backward,
      limitMps: wholeSegmentLimitMps(p.speed_limits),
      flagRules,
    })
  }
  segments.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  stats.kept = segments.length
  return { segments, stats }
}

function prepareSegmentGeometry(seg, proj) {
  const cum = [0]
  for (let i = 1; i < seg.geom.length; i++) {
    cum.push(cum[i - 1] + dist2d(
      proj.x(seg.geom[i - 1][0]), proj.y(seg.geom[i - 1][1]), proj.x(seg.geom[i][0]), proj.y(seg.geom[i][1]),
    ))
  }
  seg.totalM = cum[cum.length - 1]
  seg.cumF = cum.map((c) => (seg.totalM > 0 ? c / seg.totalM : 0))
}

function pointAtFraction(seg, f) {
  const { cumF, geom } = seg
  if (f <= 0) return [geom[0][0], geom[0][1]]
  if (f >= 1) return [geom[geom.length - 1][0], geom[geom.length - 1][1]]
  let lo = 0
  let hi = cumF.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cumF[mid] <= f) lo = mid
    else hi = mid
  }
  const span = cumF[hi] - cumF[lo]
  const t = span > 0 ? (f - cumF[lo]) / span : 0
  return [geom[lo][0] + (geom[hi][0] - geom[lo][0]) * t, geom[lo][1] + (geom[hi][1] - geom[lo][1]) * t]
}

function slicePolyline(seg, f0, f1) {
  const pts = [pointAtFraction(seg, f0)]
  for (let i = 0; i < seg.geom.length; i++) {
    if (seg.cumF[i] > f0 + 1e-9 && seg.cumF[i] < f1 - 1e-9) pts.push([seg.geom[i][0], seg.geom[i][1]])
  }
  pts.push(pointAtFraction(seg, f1))
  return pts.filter((pt, i) => i === 0 || pt[0] !== pts[i - 1][0] || pt[1] !== pts[i - 1][1])
}

/**
 * Split kept segments at junction connectors (referenced by >= 2 kept segments), their two end
 * connectors and `between` boundaries of road_flags, then drop self-loops and < 0.5 m pieces.
 * Returns { nodes: Map(id -> {id,lng,lat}), edges: [...] } with fully snapped geometry.
 */
export function splitSegments(segments, proj) {
  const refs = new Map()
  for (const seg of segments) {
    for (const id of new Set(seg.connectors.map((c) => c.id))) refs.set(id, (refs.get(id) ?? 0) + 1)
  }
  const nodes = new Map()
  const edges = []
  let droppedSelfLoops = 0
  let droppedShort = 0

  for (const seg of segments) {
    prepareSegmentGeometry(seg, proj)
    if (!(seg.totalM > 0)) continue
    const lastIndex = seg.connectors.length - 1
    // fraction -> node id
    const cuts = new Map()
    seg.connectors.forEach((c, i) => {
      const isEnd = i === 0 || i === lastIndex
      if (isEnd || (refs.get(c.id) ?? 0) >= 2) {
        const f = Math.max(0, Math.min(1, c.at))
        if (!cuts.has(f)) cuts.set(f, c.id)
      }
    })
    // Segment ends are always cut points even if the data omitted the exact 0 / 1 `at`.
    if (!cuts.has(0)) cuts.set(0, `${seg.id}@0`)
    if (!cuts.has(1)) cuts.set(1, `${seg.id}@1`)
    for (const rule of seg.flagRules) {
      if (!rule.between) continue
      for (const f of rule.between) {
        const clamped = Math.max(0, Math.min(1, f))
        const near = [...cuts.keys()].some((k) => Math.abs(k - clamped) < 1e-6)
        if (!near) cuts.set(clamped, `${seg.id}@${clamped.toFixed(9)}`)
      }
    }
    const fractions = [...cuts.keys()].sort((a, b) => a - b)
    const speedCode = edgeSpeedCode(seg.roadClass, seg.limitMps)
    const cls = ROAD_CLASSES.indexOf(seg.roadClass)

    for (let i = 0; i + 1 < fractions.length; i++) {
      const f0 = fractions[i]
      const f1 = fractions[i + 1]
      const fromId = cuts.get(f0)
      const toId = cuts.get(f1)
      if (fromId === toId) { droppedSelfLoops++; continue }
      const pts = slicePolyline(seg, f0, f1)
      if (pts.length < 2 || polylineLengthM(pts, proj) < MIN_EDGE_LENGTH_M) { droppedShort++; continue }
      let flags = 0
      for (const rule of seg.flagRules) {
        const bits = flagBits(rule.values)
        if (!bits) continue
        if (!rule.between) flags |= bits
        else if (f0 >= rule.between[0] - 1e-6 && f1 <= rule.between[1] + 1e-6) flags |= bits
      }
      for (const [id, pt] of [[fromId, pts[0]], [toId, pts[pts.length - 1]]]) {
        if (!nodes.has(id)) nodes.set(id, { id, lng: pt[0], lat: pt[1] })
      }
      const a = nodes.get(fromId)
      const b = nodes.get(toId)
      pts[0] = [a.lng, a.lat]
      pts[pts.length - 1] = [b.lng, b.lat]
      edges.push({
        key: `${seg.id}#${f0.toFixed(9)}`,
        from: fromId,
        to: toId,
        cls,
        speedCode,
        flags,
        fwd: seg.fwd,
        bwd: seg.bwd,
        pts,
      })
    }
  }
  return { nodes, edges, stats: { droppedSelfLoops, droppedShort } }
}

/** Normalise direction: backward-only edges are swapped so oneway is 0 or 1 only. */
function orientEdges(edges) {
  return edges.map((e) => {
    if (e.fwd && e.bwd) return { ...e, oneway: 0 }
    if (e.fwd) return { ...e, oneway: 1 }
    return { ...e, from: e.to, to: e.from, pts: [...e.pts].reverse(), oneway: 1 }
  })
}

/** Contract degree-2 nodes whose two edges agree in class, speed, flags and direction. */
export function contractNodes(nodeMap, edgesIn) {
  const edges = edgesIn.map((e) => ({ ...e, dead: false }))
  const adj = new Map()
  const link = (id, e) => { if (!adj.has(id)) adj.set(id, new Set()); adj.get(id).add(e) }
  for (const e of edges) { link(e.from, e); link(e.to, e) }
  const queue = [...adj.keys()].sort()
  const queued = new Set(queue)
  let contracted = 0
  while (queue.length > 0) {
    const id = queue.shift()
    queued.delete(id)
    const set = adj.get(id)
    if (!set || set.size !== 2) continue
    const [e1, e2] = [...set].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
    if (e1.from === e1.to || e2.from === e2.to) continue
    if (e1.cls !== e2.cls || e1.speedCode !== e2.speedCode || e1.flags !== e2.flags || e1.oneway !== e2.oneway) continue
    const other1 = e1.from === id ? e1.to : e1.from
    const other2 = e2.from === id ? e2.to : e2.from
    if (other1 === other2 || other1 === id || other2 === id) continue
    let merged
    if (e1.oneway === 0) {
      // Two-way: lay out other1 -> id -> other2.
      const p1 = e1.to === id ? e1.pts : [...e1.pts].reverse()
      const p2 = e2.from === id ? e2.pts : [...e2.pts].reverse()
      merged = { from: other1, to: other2, pts: [...p1, ...p2.slice(1)] }
    } else {
      // One-way: both must flow through id.
      let inE; let outE
      if (e1.to === id && e2.from === id) { inE = e1; outE = e2 } else if (e2.to === id && e1.from === id) { inE = e2; outE = e1 } else continue
      merged = { from: inE.from, to: outE.to, pts: [...inE.pts, ...outE.pts.slice(1)] }
    }
    e1.dead = true
    e2.dead = true
    for (const node of [other1, other2, id]) adj.get(node)?.delete(e1)
    for (const node of [other1, other2, id]) adj.get(node)?.delete(e2)
    adj.delete(id)
    const edge = {
      key: e1.key < e2.key ? e1.key : e2.key,
      from: merged.from, to: merged.to, cls: e1.cls, speedCode: e1.speedCode, flags: e1.flags,
      oneway: e1.oneway, pts: merged.pts, dead: false,
    }
    edges.push(edge)
    link(edge.from, edge)
    link(edge.to, edge)
    contracted++
    for (const n of [other1, other2]) if (!queued.has(n)) { queued.add(n); queue.push(n) }
  }
  const survivors = edges.filter((e) => !e.dead)
  const used = new Set()
  for (const e of survivors) { used.add(e.from); used.add(e.to) }
  return { nodes: new Map([...nodeMap].filter(([id]) => used.has(id))), edges: survivors, contracted }
}

// ── compact encoding ─────────────────────────────────────────────────────────────────────────

const SPEED_STEP = 0.5

/**
 * Network → compact JSON object. `net` is { origin:[lng0,lat0], nodes:[{lat,lng}], edges:[{from,to,cls,speedMps,oneway,flags,pts:[{lat,lng}...]}], entries }.
 * `pts` are FULL polylines (node to node); only the interior vertices are stored.
 */
export function encodeRoadNetwork(net) {
  const [lng0, lat0] = net.origin
  const q = (lng, lat) => [Math.round((lng - lng0) * ROAD_SCALE), Math.round((lat - lat0) * ROAD_SCALE)]
  const qn = net.nodes.map((n) => q(n.lng, n.lat))
  const nodes = []
  let px = 0
  let py = 0
  for (const [x, y] of qn) { nodes.push(x - px, y - py); px = x; py = y }
  const edges = []
  const geom = []
  let geomCount = 0
  for (const e of net.edges) {
    const interior = e.pts.slice(1, -1)
    let cx = qn[e.from][0]
    let cy = qn[e.from][1]
    for (const pt of interior) {
      const [x, y] = q(pt.lng, pt.lat)
      geom.push(x - cx, y - cy)
      cx = x; cy = y
    }
    edges.push([e.from, e.to, e.cls, Math.round(e.speedMps / SPEED_STEP), e.oneway, e.flags, geomCount, interior.length])
    geomCount += interior.length
  }
  return { v: ROAD_FORMAT_VERSION, origin: [lng0, lat0], scale: ROAD_SCALE, nodes, edges, geom, entries: [...net.entries] }
}

export const serializeRoadNetwork = (encoded) => JSON.stringify(encoded) + '\n'

/** Compact JSON object → network (the same shape `encodeRoadNetwork` consumes). */
export function decodeRoadNetwork(encoded) {
  if (!encoded || encoded.v !== ROAD_FORMAT_VERSION) throw new Error('unsupported road fixture version')
  const [lng0, lat0] = encoded.origin
  const scale = encoded.scale
  const qn = []
  let x = 0
  let y = 0
  for (let i = 0; i < encoded.nodes.length; i += 2) {
    x += encoded.nodes[i]; y += encoded.nodes[i + 1]
    qn.push([x, y])
  }
  const toLL = (qx, qy) => ({ lng: lng0 + qx / scale, lat: lat0 + qy / scale })
  const nodes = qn.map(([qx, qy]) => toLL(qx, qy))
  const edges = encoded.edges.map(([from, to, cls, speedCode, oneway, flags, geomStart, geomLen]) => {
    const pts = [nodes[from]]
    let cx = qn[from][0]
    let cy = qn[from][1]
    for (let i = 0; i < geomLen; i++) {
      cx += encoded.geom[(geomStart + i) * 2]
      cy += encoded.geom[(geomStart + i) * 2 + 1]
      pts.push(toLL(cx, cy))
    }
    pts.push(nodes[to])
    return { from, to, cls, speedMps: speedCode * SPEED_STEP, oneway, flags, pts }
  })
  return { origin: [lng0, lat0], nodes, edges, entries: [...encoded.entries] }
}

// ── authoring-time validation on the DECODED geometry ────────────────────────────────────────

class RingIndex {
  /** rings: array of arrays of [x,y] metre points (closed or open). */
  constructor(rings, cell = 250) {
    this.cell = cell
    this.segs = []
    this.grid = new Map()
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]
        const b = ring[(i + 1) % ring.length]
        if (a[0] === b[0] && a[1] === b[1]) continue
        const idx = this.segs.length
        this.segs.push([a[0], a[1], b[0], b[1]])
        minX = Math.min(minX, a[0]); maxX = Math.max(maxX, a[0])
        minY = Math.min(minY, a[1]); maxY = Math.max(maxY, a[1])
        const cx0 = Math.floor(Math.min(a[0], b[0]) / cell)
        const cx1 = Math.floor(Math.max(a[0], b[0]) / cell)
        const cy0 = Math.floor(Math.min(a[1], b[1]) / cell)
        const cy1 = Math.floor(Math.max(a[1], b[1]) / cell)
        for (let cx = cx0; cx <= cx1; cx++) {
          for (let cy = cy0; cy <= cy1; cy++) {
            const key = cx * 1_000_003 + cy
            const list = this.grid.get(key)
            if (list) list.push(idx)
            else this.grid.set(key, [idx])
          }
        }
      }
    }
    this.bbox = [minX, minY, maxX, maxY]
    this.maxCx = Math.floor(maxX / cell)
    this.stamp = new Int32Array(this.segs.length)
    this.call = 0
  }

  /** Even-odd containment across all rings (holes included). */
  contains(x, y) {
    const [minX, minY, maxX, maxY] = this.bbox
    if (x < minX || x > maxX || y < minY || y > maxY) return false
    const cell = this.cell
    const cy = Math.floor(y / cell)
    const cx0 = Math.floor(x / cell)
    this.call++
    let inside = false
    for (let cx = cx0; cx <= this.maxCx; cx++) {
      const list = this.grid.get(cx * 1_000_003 + cy)
      if (!list) continue
      for (const idx of list) {
        if (this.stamp[idx] === this.call) continue
        this.stamp[idx] = this.call
        const [x1, y1, x2, y2] = this.segs[idx]
        if ((y1 > y) !== (y2 > y)) {
          const xCross = x1 + ((y - y1) * (x2 - x1)) / (y2 - y1)
          if (x < xCross) inside = !inside
        }
      }
    }
    return inside
  }

  /** True when segment (a,b) properly crosses any ring segment. */
  crosses(ax, ay, bx, by) {
    const cell = this.cell
    const cx0 = Math.floor(Math.min(ax, bx) / cell)
    const cx1 = Math.floor(Math.max(ax, bx) / cell)
    const cy0 = Math.floor(Math.min(ay, by) / cell)
    const cy1 = Math.floor(Math.max(ay, by) / cell)
    this.call++
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const list = this.grid.get(cx * 1_000_003 + cy)
        if (!list) continue
        for (const idx of list) {
          if (this.stamp[idx] === this.call) continue
          this.stamp[idx] = this.call
          const [x1, y1, x2, y2] = this.segs[idx]
          if (properIntersect(ax, ay, bx, by, x1, y1, x2, y2)) return true
        }
      }
    }
    return false
  }
}

function properIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const o1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
  const o2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax)
  const o3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx)
  const o4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx)
  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0) && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0
}

/** Water polygons (non-intermittent, non pool/fountain/drain) → ring indexes in metres. */
export function buildWaterIndexes(waterFeatures, proj) {
  const indexes = []
  for (const feature of waterFeatures ?? []) {
    const p = feature.properties ?? {}
    if (p.is_intermittent === true) continue
    if (SKIP_WATER_CLASSES.has(p.class)) continue
    const geometry = feature.geometry
    const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon' ? geometry.coordinates : []
    for (const polygon of polygons) {
      const rings = polygon.map((ring) => ring.map(([lng, lat]) => [proj.x(lng), proj.y(lat)]))
      if (rings.length === 0 || rings[0].length < 4) continue
      indexes.push(new RingIndex(rings))
    }
  }
  return indexes
}

export function buildFootprintIndexes(buildingCollection, proj) {
  const indexes = []
  for (const feature of buildingCollection?.features ?? []) {
    const geometry = feature.geometry
    const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon' ? geometry.coordinates : []
    for (const polygon of polygons) {
      const rings = polygon.map((ring) => ring.map(([lng, lat]) => [proj.x(lng), proj.y(lat)]))
      if (rings.length > 0 && rings[0].length >= 4) indexes.push(new RingIndex(rings, 100))
    }
  }
  return indexes
}

const bboxOverlap = (a, b, pad = 0) =>
  !(a[2] < b[0] - pad || a[0] > b[2] + pad || a[3] < b[1] - pad || a[1] > b[3] + pad)

/** Metres of an edge polyline inside each polygon (sampled at ~1 m); returns the maximum. */
export function maxInsideWaterM(xy, indexes) {
  let worst = 0
  const lineBox = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [x, y] of xy) {
    lineBox[0] = Math.min(lineBox[0], x); lineBox[1] = Math.min(lineBox[1], y)
    lineBox[2] = Math.max(lineBox[2], x); lineBox[3] = Math.max(lineBox[3], y)
  }
  for (const index of indexes) {
    if (!bboxOverlap(lineBox, index.bbox)) continue
    let inside = 0
    for (let i = 1; i < xy.length; i++) {
      const [ax, ay] = xy[i - 1]
      const [bx, by] = xy[i]
      const len = dist2d(ax, ay, bx, by)
      const steps = Math.max(1, Math.ceil(len / 1))
      const stepLen = len / steps
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) / steps
        if (index.contains(ax + (bx - ax) * t, ay + (by - ay) * t)) inside += stepLen
      }
    }
    worst = Math.max(worst, inside)
  }
  return worst
}

function crossesFootprint(xy, indexes) {
  const lineBox = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [x, y] of xy) {
    lineBox[0] = Math.min(lineBox[0], x); lineBox[1] = Math.min(lineBox[1], y)
    lineBox[2] = Math.max(lineBox[2], x); lineBox[3] = Math.max(lineBox[3], y)
  }
  for (const index of indexes) {
    if (!bboxOverlap(lineBox, index.bbox)) continue
    for (let i = 1; i < xy.length; i++) {
      const [ax, ay] = xy[i - 1]
      const [bx, by] = xy[i]
      if (index.crosses(ax, ay, bx, by)) return true
      if (index.contains((ax + bx) / 2, (ay + by) / 2)) return true
    }
  }
  return false
}

/** Strongly connected components (iterative Tarjan) over the drivable directions. */
export function stronglyConnectedComponents(nodeCount, edges) {
  const out = Array.from({ length: nodeCount }, () => [])
  edges.forEach((e) => {
    out[e.from].push(e.to)
    if (e.oneway === 0) out[e.to].push(e.from)
  })
  const index = new Int32Array(nodeCount).fill(-1)
  const low = new Int32Array(nodeCount)
  const onStack = new Uint8Array(nodeCount)
  const comp = new Int32Array(nodeCount).fill(-1)
  const stack = []
  let counter = 0
  let compCount = 0
  for (let root = 0; root < nodeCount; root++) {
    if (index[root] !== -1) continue
    const call = [[root, 0]]
    index[root] = low[root] = counter++
    stack.push(root); onStack[root] = 1
    while (call.length > 0) {
      const frame = call[call.length - 1]
      const v = frame[0]
      if (frame[1] < out[v].length) {
        const w = out[v][frame[1]++]
        if (index[w] === -1) {
          index[w] = low[w] = counter++
          stack.push(w); onStack[w] = 1
          call.push([w, 0])
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], index[w])
        }
      } else {
        if (low[v] === index[v]) {
          let w
          do { w = stack.pop(); onStack[w] = 0; comp[w] = compCount } while (w !== v)
          compCount++
        }
        call.pop()
        if (call.length > 0) {
          const parent = call[call.length - 1][0]
          low[parent] = Math.min(low[parent], low[v])
        }
      }
    }
  }
  return { comp, count: compCount }
}

/**
 * Validate a DECODED network against water, building footprints and connectivity.
 * Returns { net, validation, componentEdges }; `net` has dropped edges removed and nodes compacted.
 */
export function validateDecoded(decoded, { proj, waterIndexes, footprintIndexes, startPosition, box, centre }) {
  const counters = { droppedWaterCrossings: 0, droppedBuildingCrossings: 0, droppedDisconnectedEdges: 0, droppedDegenerate: 0 }
  const edgeXY = (e) => e.pts.map((p) => [proj.x(p.lng), proj.y(p.lat)])
  let edges = []
  for (const e of decoded.edges) {
    const xy = edgeXY(e)
    let length = 0
    for (let i = 1; i < xy.length; i++) length += dist2d(xy[i - 1][0], xy[i - 1][1], xy[i][0], xy[i][1])
    if (length < 0.1 || e.from === e.to) { counters.droppedDegenerate++; continue }
    if (!(e.flags & (FLAG_BRIDGE | FLAG_HIDDEN)) && waterIndexes.length > 0 && maxInsideWaterM(xy, waterIndexes) > WATER_TOLERANCE_M) {
      counters.droppedWaterCrossings++
      continue
    }
    if (footprintIndexes && !(e.flags & FLAG_HIDDEN) && crossesFootprint(xy, footprintIndexes)) {
      counters.droppedBuildingCrossings++
      continue
    }
    edges.push(e)
  }

  const scc = stronglyConnectedComponents(decoded.nodes.length, edges)
  const lengthByComp = new Map()
  const edgeLen = (e) => polylineLengthM(e.pts.map((p) => [p.lng, p.lat]), proj)
  const lens = new Map()
  for (const e of edges) {
    const c = scc.comp[e.from]
    if (c === scc.comp[e.to]) {
      const len = edgeLen(e)
      lens.set(e, len)
      lengthByComp.set(c, (lengthByComp.get(c) ?? 0) + len)
    }
  }
  let best = -1
  let bestLen = -1
  for (const [c, len] of [...lengthByComp.entries()].sort((a, b) => a[0] - b[0])) {
    if (len > bestLen) { best = c; bestLen = len }
  }
  const kept = edges.filter((e) => scc.comp[e.from] === best && scc.comp[e.to] === best)
  counters.droppedDisconnectedEdges = edges.length - kept.length

  // Compact nodes, preserving order.
  const remap = new Map()
  const nodes = []
  const used = new Set()
  for (const e of kept) { used.add(e.from); used.add(e.to) }
  decoded.nodes.forEach((n, i) => { if (used.has(i)) { remap.set(i, nodes.length); nodes.push(n) } })
  const outEdges = kept.map((e) => ({ ...e, from: remap.get(e.from), to: remap.get(e.to) }))

  let startSnapM = null
  if (startPosition) {
    startSnapM = Infinity
    const sx = proj.x(startPosition.lng)
    const sy = proj.y(startPosition.lat)
    for (const n of nodes) startSnapM = Math.min(startSnapM, dist2d(sx, sy, proj.x(n.lng), proj.y(n.lat)))
    startSnapM = Number.isFinite(startSnapM) ? Math.round(startSnapM * 10) / 10 : null
  }

  const entries = computeEntries(nodes, outEdges, centre ?? { lat: (box[1] + box[3]) / 2, lng: (box[0] + box[2]) / 2 }, proj)
  return {
    net: { origin: decoded.origin, nodes, edges: outEdges, entries },
    counters,
    startSnapM,
    keptEdgeCount: outEdges.length,
  }
}

/** One node per 45 degree sector: touches a tertiary-or-higher edge, farthest from the centre. */
export function computeEntries(nodes, edges, centre, proj) {
  const major = new Set()
  for (const e of edges) if (e.cls <= ROAD_CLASSES.indexOf('tertiary')) { major.add(e.from); major.add(e.to) }
  const cx = proj.x(centre.lng)
  const cy = proj.y(centre.lat)
  const bestBySector = new Array(8).fill(null)
  for (const i of [...major].sort((a, b) => a - b)) {
    const dx = proj.x(nodes[i].lng) - cx
    const dy = proj.y(nodes[i].lat) - cy
    const bearing = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360
    const sector = Math.floor(((bearing + 22.5) % 360) / 45)
    const d = Math.hypot(dx, dy)
    const current = bestBySector[sector]
    if (!current || d > current.d + 1e-9) bestBySector[sector] = { i, d }
  }
  return [...new Set(bestBySector.filter(Boolean).map((b) => b.i))].sort((a, b) => a - b)
}

// ── whole-scenario pipeline for one set of ladder choices ────────────────────────────────────

const roundTo6 = (v) => Math.round(v * 1e6) / 1e6

/**
 * Raw features → validated, encoded network for one ladder configuration.
 * Order: filter → split/contract → simplify → quantise → decode → validate → encode.
 */
export function buildNetwork({ segmentFeatures, waterFeatures, buildingCollection, box, startPosition, heatSources, config }) {
  const centre = { lat: (box[1] + box[3]) / 2, lng: (box[0] + box[2]) / 2 }
  const proj = makeProjector(centre.lat, centre.lng)
  const dropClasses = new Set(config.dropClasses ?? [])
  const near = (radiusM) => ({ points: heatSources, radiusM })
  const ctx = {
    box,
    proj,
    dropClasses,
    serviceNearOnly: config.serviceNearHeatOnly ? near(300) : null,
    residentialNearOnly: config.residentialNearOnly
      ? { points: [startPosition, ...heatSources], radiusM: 1000 }
      : null,
  }
  const { segments, stats: selectStats } = selectSegments(segmentFeatures, ctx)
  const split = splitSegments(segments, proj)
  const oriented = orientEdges(split.edges)
  const contracted = contractNodes(split.nodes, oriented)

  // Deterministic ordering: nodes by id, edges by source key then endpoints.
  const nodeIds = [...contracted.nodes.keys()].sort()
  const nodeIndex = new Map(nodeIds.map((id, i) => [id, i]))
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  const edgesSorted = contracted.edges
    .map((e) => (e.oneway === 0 && cmp(e.from, e.to) > 0 ? { ...e, from: e.to, to: e.from, pts: [...e.pts].reverse() } : e))
    .sort((a, b) => cmp(a.key, b.key) || cmp(a.from, b.from) || cmp(a.to, b.to))

  const origin = [roundTo6(box[0]), roundTo6(box[1])]
  const simplifyM = config.simplifyM ?? 1.0
  const net = {
    origin,
    nodes: nodeIds.map((id) => ({ lng: contracted.nodes.get(id).lng, lat: contracted.nodes.get(id).lat })),
    edges: edgesSorted.map((e) => {
      const xy = e.pts.map((p) => [proj.x(p[0]), proj.y(p[1])])
      // Edges are split wherever bridge/tunnel status changes, so that boundary is always an
      // endpoint here and the simplifier can never remove a status-change vertex.
      const keep = douglasPeuckerIndices(xy, simplifyM)
      return {
        from: nodeIndex.get(e.from),
        to: nodeIndex.get(e.to),
        cls: e.cls,
        speedMps: e.speedCode * SPEED_STEP,
        oneway: e.oneway,
        flags: e.flags,
        pts: keep.map((i) => ({ lng: e.pts[i][0], lat: e.pts[i][1] })),
      }
    }),
    entries: [],
  }
  const decoded = decodeRoadNetwork(encodeRoadNetwork(net)) // quantise, then validate what ships
  const waterIndexes = buildWaterIndexes(waterFeatures, proj)
  const footprintIndexes = buildingCollection ? buildFootprintIndexes(buildingCollection, proj) : null
  const result = validateDecoded(decoded, { proj, waterIndexes, footprintIndexes, startPosition, box, centre })
  const encoded = encodeRoadNetwork(result.net)
  const json = serializeRoadNetwork(encoded)
  const finalDecoded = decodeRoadNetwork(encoded)
  // Re-check the exact geometry that ships: no unbridged water crossing may remain.
  let remainingWaterCrossings = 0
  for (const e of finalDecoded.edges) {
    if (e.flags & (FLAG_BRIDGE | FLAG_HIDDEN)) continue
    const xy = e.pts.map((p) => [proj.x(p.lng), proj.y(p.lat)])
    if (waterIndexes.length > 0 && maxInsideWaterM(xy, waterIndexes) > WATER_TOLERANCE_M) remainingWaterCrossings++
  }
  return {
    encoded,
    json,
    decoded: finalDecoded,
    gzipBytes: gzipSync(json, { level: 9 }).byteLength,
    stats: {
      select: selectStats,
      split: split.stats,
      contracted: contracted.contracted,
      nodes: result.net.nodes.length,
      edges: result.net.edges.length,
      entries: result.net.entries.length,
    },
    validation: {
      waterChecked: true,
      buildingsChecked: Boolean(buildingCollection),
      waterToleranceM: WATER_TOLERANCE_M,
      droppedWaterCrossings: result.counters.droppedWaterCrossings,
      droppedBuildingCrossings: result.counters.droppedBuildingCrossings,
      droppedDisconnectedEdges: result.counters.droppedDisconnectedEdges,
      remainingWaterCrossings,
      ambiguousAccessRules: selectStats.ambiguousAccessRules,
      startSnapM: result.startSnapM,
    },
    keptEdgeCount: result.keptEdgeCount,
  }
}

// ── budget ladder ────────────────────────────────────────────────────────────────────────────

/** Cumulative ladder; step k applies steps 1..k. Step 0 is the unrestricted baseline. */
export function ladderConfig(step, { startPosition, heatSources }) {
  const config = { step, applied: [], dropClasses: [], simplifyM: 1.0, marginM: 1500, boxMode: 'full' }
  if (step >= 1) { config.dropClasses.push('track'); config.applied.push('drop track') }
  if (step >= 2) { config.serviceNearHeatOnly = true; config.applied.push('drop service except within 300 m of a heat source') }
  if (step >= 3) { config.simplifyM = 2.0; config.applied.push('simplify at 2.0 m') }
  if (step >= 4) { config.marginM = 750; config.boxMode = 'margin750'; config.applied.push('reduce margin to 750 m') }
  if (step >= 5) { config.residentialNearOnly = true; config.applied.push('residential/living_street only within 1000 m of start or a heat source') }
  if (step >= 6) { config.simplifyM = 3.0; config.applied.push('simplify at 3.0 m') }
  if (step >= 7) { config.boxMode = 'core750'; config.applied.push('restrict box to start + heat sources ±750 m') }
  void startPosition; void heatSources
  return config
}

function boxForConfig(fullBox, config, { startPosition, heatSources }) {
  const [w, s, e, n] = fullBox
  const latC = (s + n) / 2
  const dLat = (m) => m / M_PER_DEG
  const dLng = (m, lat) => m / (M_PER_DEG * Math.cos((lat * Math.PI) / 180))
  if (config.boxMode === 'margin750') {
    // fullBox = envelope + 1500 m, so shrinking by 750 m per side gives envelope + 750 m.
    return [w + dLng(750, latC), s + dLat(750), e - dLng(750, latC), n - dLat(750)]
  }
  if (config.boxMode === 'core750') {
    const pts = [startPosition, ...heatSources]
    const lats = pts.map((p) => p.lat)
    const lngs = pts.map((p) => p.lng)
    const lat = (Math.min(...lats) + Math.max(...lats)) / 2
    return [
      Math.min(...lngs) - dLng(750, lat), Math.min(...lats) - dLat(750),
      Math.max(...lngs) + dLng(750, lat), Math.max(...lats) + dLat(750),
    ]
  }
  return fullBox
}

// ── I/O ──────────────────────────────────────────────────────────────────────────────────────

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const uvxCommand = () => (process.platform === 'win32' ? 'uvx.exe' : 'uvx')

function runWithTimeout(command, args, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-800) })
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      else child.kill('SIGKILL')
      reject(new Error(`${command} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited ${code}: ${stderr.replace(/\s+/g, ' ').slice(-300)}`))
    })
  })
}

async function downloadOverture(type, bbox, output, { retries = 1, timeoutMs = 10 * 60 * 1000 } = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await rm(output, { force: true })
      await rm(`${output}.state`, { force: true })
      await runWithTimeout(uvxCommand(), [
        '--from', `overturemaps==${OVERTURE_ROADS_CLIENT_VERSION}`,
        'overturemaps', 'download',
        `--bbox=${bbox.join(',')}`,
        `--release=${OVERTURE_ROADS_DATA_RELEASE}`,
        `--type=${type}`,
        '-f', 'geojson',
        '-o', output,
      ], timeoutMs)
      return
    } catch (error) {
      lastError = error
      console.error(`  download ${type} attempt ${attempt + 1} failed: ${error.message}`)
    }
  }
  throw lastError
}

const roundBox = (box) => box.map((v) => Math.round(v * 1e6) / 1e6)

const targetsUrl = new URL('./roadTargets.json', import.meta.url)

async function readTargets() {
  return JSON.parse(await readFile(targetsUrl, 'utf8'))
}

async function setParked(targets, id, entry) {
  const fresh = await readTargets().catch(() => targets)
  const parked = (fresh.parked ?? []).filter((p) => p.id !== id)
  if (entry) parked.push(entry)
  parked.sort((a, b) => (a.id < b.id ? -1 : 1))
  await writeFile(targetsUrl, JSON.stringify({ ...fresh, parked }, null, 2) + '\n')
}

function countedBytes(name, bytes) {
  return name.endsWith('.png') ? bytes.length : gzipSync(bytes, { level: 9 }).length
}

/** Gzip bytes of every OTHER counted fixture in the scenario dir (mirrors assert-realism-fixture-budget). */
async function otherCountedBytes(dirPath, manifestJson) {
  let total = 0
  for (const name of ['terrain.png', 'terrain.json', 'terrain-refpoints.json', 'buildings.json']) {
    const bytes = await readFile(join(dirPath, name)).catch(() => null)
    if (bytes) total += countedBytes(name, bytes)
  }
  total += countedBytes('manifest.json', Buffer.from(manifestJson))
  return total
}

/** @param {any} previous @param {{ scenarioId: string, source?: any, roadsRemoved?: boolean }} options */
function mergeManifest(previous, { scenarioId, source, roadsRemoved }) {
  const kept = (previous?.sources ?? []).filter((s) => s.fixture !== 'roads.json')
  const sources = roadsRemoved ? kept : [...kept, source]
  return {
    ...(previous ?? {}),
    scenarioId,
    // area.aoBbox is owned by the terrain/buildings tools; the road box lives in the source entry.
    ...(previous?.area ? { area: previous.area } : {}),
    generatedAt: previous?.generatedAt ?? new Date().toISOString().slice(0, 10),
    sources: sources.sort((a, b) => (a.fixture < b.fixture ? -1 : 1)),
  }
}

export async function generateScenarioRoads({ id, target, inputPath, waterInputPath, scratchDir, refresh, fixturesRoot }) {
  const dirUrl = new URL(`${id}/`, fixturesRoot)
  const dirPath = fileURLToPath(dirUrl)
  await mkdir(scratchDir, { recursive: true })
  const fullBox = roundBox(target.bbox)
  const tag = `${id}-${OVERTURE_ROADS_DATA_RELEASE}-${sha256(fullBox.join(',')).slice(0, 8)}`
  const segPath = inputPath ?? join(scratchDir, `${tag}-segment.geojson`)
  const waterPath = waterInputPath ?? join(scratchDir, `${tag}-water.geojson`)

  /** @type {any} */
  const outcome = { id, status: 'pending', steps: [] }
  try {
    if (!inputPath && (refresh || !existsSync(segPath))) await downloadOverture('segment', fullBox, segPath)
    if (!waterInputPath && (refresh || !existsSync(waterPath))) await downloadOverture('water', fullBox, waterPath)
  } catch (error) {
    outcome.status = 'parked'
    outcome.reason = 'download_failed'
    outcome.detail = error.message
    return outcome
  }
  const rawSegmentsText = await readFile(segPath)
  const segmentFeatures = JSON.parse(rawSegmentsText.toString('utf8')).features ?? []
  const waterFeatures = JSON.parse((await readFile(waterPath)).toString('utf8')).features ?? []
  const buildingCollection = await readFile(new URL('buildings.json', dirUrl), 'utf8').then(JSON.parse).catch(() => null)
  const previousManifest = await readFile(new URL('manifest.json', dirUrl), 'utf8').then(JSON.parse).catch(() => null)
  const heatSources = target.heatSources ?? []
  const startPosition = target.startPosition

  /** @type {any} */
  let last = null
  for (let step = 0; step <= 7; step++) {
    const config = ladderConfig(step, { startPosition, heatSources })
    const box = boxForConfig(fullBox, config, { startPosition, heatSources })
    const built = buildNetwork({ segmentFeatures, waterFeatures, buildingCollection, box, startPosition, heatSources, config })
    last = { built, config, box }
    if (built.keptEdgeCount < MIN_COMPONENT_EDGES) {
      outcome.status = 'parked'
      outcome.reason = 'no_network'
      outcome.gzipBytes = built.gzipBytes
      outcome.keptEdges = built.keptEdgeCount
      await dropRoadsFixture(dirUrl, previousManifest, id)
      return outcome
    }
    const source = {
      fixture: 'roads.json',
      source: OVERTURE_ROADS_SOURCE,
      url: OVERTURE_ROADS_DOCS,
      license: OVERTURE_ROADS_LICENSE,
      attribution: OVERTURE_ROADS_ATTRIBUTION,
      retrievedAt: new Date().toISOString().slice(0, 10),
      sha256: sha256(built.json),
      rawBytes: Buffer.byteLength(built.json),
      gzipBytes: built.gzipBytes,
      input: inputPath ? basename(inputPath) : `overturemaps==${OVERTURE_ROADS_CLIENT_VERSION}`,
      inputSha256: sha256(rawSegmentsText),
      dataRelease: OVERTURE_ROADS_DATA_RELEASE,
      schemaVersion: OVERTURE_ROADS_SCHEMA_VERSION,
      stacCollection: OVERTURE_ROADS_STAC_COLLECTION,
      client: { package: 'overturemaps', version: OVERTURE_ROADS_CLIENT_VERSION },
      roadBbox: roundBox(box),
      downloadBbox: fullBox,
      filters: 'subtype=road; classes motorway..track; drops under-construction/abandoned/indoor, driveway/parking_aisle/sidewalk/crosswalk/cycle_crossing; per-direction vehicle access (last matching rule wins); rail, ferry and water are never shipped',
      budgetSteps: config.applied,
      stats: built.stats,
      validation: built.validation,
    }
    const manifest = mergeManifest(previousManifest, { scenarioId: id, source })
    const manifestJson = JSON.stringify(manifest, null, 2) + '\n'
    const others = await otherCountedBytes(dirPath, manifestJson)
    const total = others + built.gzipBytes
    last.total = total
    last.source = source
    last.manifestJson = manifestJson
    outcome.steps.push({ step, gzipBytes: built.gzipBytes, totalShippedBytes: total, nodes: built.stats.nodes, edges: built.stats.edges })
    if (total <= MAX_SCENARIO_BYTES) {
      await mkdir(dirPath, { recursive: true })
      await writeFile(new URL('roads.json', dirUrl), built.json)
      await writeFile(new URL('manifest.json', dirUrl), manifestJson)
      outcome.status = 'covered'
      outcome.gzipBytes = built.gzipBytes
      outcome.rawBytes = Buffer.byteLength(built.json)
      outcome.totalShippedBytes = total
      outcome.nodes = built.stats.nodes
      outcome.edges = built.stats.edges
      outcome.budgetSteps = config.applied
      outcome.validation = built.validation
      return outcome
    }
  }
  outcome.status = 'parked'
  outcome.reason = 'budget'
  outcome.gzipBytes = last.built.gzipBytes
  await dropRoadsFixture(dirUrl, previousManifest, id)
  return outcome
}

/** A parked scenario ships no roads.json and no manifest roads entry. */
async function dropRoadsFixture(dirUrl, previousManifest, id) {
  await rm(new URL('roads.json', dirUrl), { force: true })
  if (previousManifest?.sources?.some((s) => s.fixture === 'roads.json')) {
    const manifest = mergeManifest(previousManifest, { scenarioId: id, roadsRemoved: true })
    await writeFile(new URL('manifest.json', dirUrl), JSON.stringify(manifest, null, 2) + '\n')
  }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else { out[key] = next; i++ }
  }
  return out
}

async function cli() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.id || args.id === true) {
    throw new Error('usage: node --max-old-space-size=4096 tools/fixtures/roads.mjs --id <id>[,<id>...] [--input raw-segments.geojson] [--water-input raw-water.geojson] [--bbox w,s,e,n] [--scratch dir] [--refresh]')
  }
  const targets = await readTargets().catch(() => ({ targets: [], parked: [] }))
  const fixturesRoot = new URL('../../src/scenarios/fixtures/', import.meta.url)
  const scratchDir = resolve(args.scratch && args.scratch !== true ? args.scratch : join(process.cwd(), 'outputs', 'roads-scratch'))
  const ids = String(args.id).split(',').filter(Boolean)
  const results = []
  for (const id of ids) {
    const known = targets.targets.find((t) => t.id === id)
    let target = known
    if (args.bbox && args.bbox !== true) {
      const bbox = args.bbox.split(',').map(Number)
      if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) throw new Error('--bbox must be w,s,e,n')
      target = { id, startPosition: known?.startPosition ?? { lng: (bbox[0] + bbox[2]) / 2, lat: (bbox[1] + bbox[3]) / 2 }, heatSources: known?.heatSources ?? [], usesRecovery: true, ...known, bbox }
    }
    if (!target) throw new Error(`no road target for "${id}" in roadTargets.json; pass --bbox`)
    console.log(`== ${id} bbox ${roundBox(target.bbox).join(',')}`)
    const started = Date.now()
    /** @type {any} */
    let outcome
    try {
      outcome = await generateScenarioRoads({
        id, target, inputPath: args.input && args.input !== true ? resolve(args.input) : undefined,
        waterInputPath: args['water-input'] && args['water-input'] !== true ? resolve(args['water-input']) : undefined,
        scratchDir, refresh: Boolean(args.refresh), fixturesRoot,
      })
    } catch (error) {
      outcome = { id, status: 'parked', reason: 'pipeline_error', detail: error.stack ?? error.message }
    }
    outcome.seconds = Math.round((Date.now() - started) / 1000)
    if (outcome.status === 'parked') {
      await setParked(targets, id, { id, reason: outcome.reason, gzipBytes: outcome.gzipBytes ?? 0 })
      console.log(`  PARKED ${outcome.reason}${outcome.detail ? ` (${String(outcome.detail).slice(0, 300)})` : ''}`)
    } else {
      await setParked(targets, id, null)
      console.log(
        `  roads: ${outcome.nodes} nodes · ${outcome.edges} edges · ${(outcome.rawBytes / 1024).toFixed(1)} KB raw · `
        + `${(outcome.gzipBytes / 1024).toFixed(1)} KB gzip · scenario total ${(outcome.totalShippedBytes / 1024).toFixed(1)} KB`
        + ` · steps [${outcome.budgetSteps.join('; ') || 'none'}] · ${JSON.stringify(outcome.validation)}`,
      )
    }
    results.push(outcome)
  }
  console.log('SUMMARY ' + JSON.stringify(results.map(({ id, status, reason, gzipBytes, nodes, edges, seconds }) => ({ id, status, reason, gzipBytes, nodes, edges, seconds }))))
  return results
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (invoked === import.meta.url || process.argv[1]?.endsWith('roads.mjs')) {
  cli().catch((error) => {
    console.error('road fixture failed:', error.message)
    process.exit(1)
  })
}
