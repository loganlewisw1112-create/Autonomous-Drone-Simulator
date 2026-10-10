import type { GroundUnitState, LatLng, RecoveryTeamState } from '@/types'
import { getRoadNetwork } from '@/scenarios/roadFixtures'
import type { RoadNetwork } from '@/scenarios/roadFixtures'
import { bearingDeg } from '@/utils/geometry'
import {
  MAX_ACCESS_GAP_M,
  RECOVERY_WALK_LIMIT_M,
  START_SNAP_LIMIT_M,
  contactAccessGapM,
  pickEntryNode,
  routeOnRoads,
  snapToRoad,
} from '@/sim/mission/roadRouter'
import type { RoadRoute, SnapResult } from '@/sim/mission/roadRouter'

// Leaf module (imports only roadRouter and roadFixtures) so both the store and SimulationLoop can
// use it without an import cycle. The memo is NOT state: full routes never enter the store, replay
// frames or the focus frame. getUnitRoute/getTeamRoute recompute through the pure router on a miss,
// from the scenario of the frame being shown, so replay scrubbing works without the sim's memo.

export type RoadScenarioRef = { id: string; terrainFixtureId?: string }
type ScenarioWithHeat = RoadScenarioRef & { heatSources?: ReadonlyArray<{ id: string; position: LatLng }> }

export interface MemoEntry {
  net: RoadNetwork
  /** Binds the entry to its start node and target so an id reused elsewhere can never serve a wrong route. */
  sig: string
  route: RoadRoute
}

const memo = new Map<string, MemoEntry>()
let pairCache = new WeakMap<RoadNetwork, Map<string, RoadRoute>>()

/** Id-keyed (unit or team) route memo. Cleared by initFleet; abortRecovery deletes its team. */
export const routeMemo = {
  get: (id: string): MemoEntry | undefined => memo.get(id),
  set: (id: string, entry: MemoEntry): void => { memo.set(id, entry) },
  delete: (id: string): void => { memo.delete(id) },
  clear: (): void => {
    memo.clear()
    pairCache = new WeakMap()
  },
}

export function routeSig(fromNode: number, target: LatLng): string {
  return `${fromNode}|${target.lat},${target.lng}`
}

/**
 * Route from a graph node to a target snap, cached per (from node, edge, position along edge) for
 * the mission. Two targets at different distances from the road can snap to the same point and so
 * share one route object: its `accessGapM` is the FIRST caller's walk-in gap. Never read a
 * per-contact value off a returned route; the dispatch plans below carry each contact's own gap.
 */
export function computeRoute(net: RoadNetwork, fromNode: number, target: SnapResult): RoadRoute {
  let byKey = pairCache.get(net)
  if (!byKey) { byKey = new Map(); pairCache.set(net, byKey) }
  const key = `${fromNode}|${target.edge}|${target.alongM}`
  const hit = byKey.get(key)
  if (hit) return hit
  const route = routeOnRoads(net, fromNode, target)
  byKey.set(key, route)
  return route
}

function routeFor(net: RoadNetwork, id: string, fromNode: number, targetPos: LatLng): RoadRoute | null {
  const sig = routeSig(fromNode, targetPos)
  const hit = memo.get(id)
  if (hit && hit.net === net && hit.sig === sig) return hit.route
  const snap = snapToRoad(net, targetPos, { role: 'target' })
  if (!snap) return null
  const route = computeRoute(net, fromNode, snap)
  memo.set(id, { net, sig, route })
  return route
}

/**
 * The route a ground unit drives, for the scenario of the frame being shown. `contactPos` overrides
 * the heat-source lookup (contacts never move, so the two agree for real detections).
 */
export function getUnitRoute(unit: GroundUnitState, scenario: ScenarioWithHeat, contactPos?: LatLng): RoadRoute | null {
  if (unit.routeFromNode === undefined || !unit.targetThermalId) return null
  const net = getRoadNetwork(scenario)
  if (!net) return null
  const target = contactPos ?? scenario.heatSources?.find((h) => h.id === unit.targetThermalId)?.position
  if (!target) return null
  return routeFor(net, unit.id, unit.routeFromNode, target)
}

/** The route a road-routed recovery team drives; null for a team with no road access. */
export function getTeamRoute(team: RecoveryTeamState, scenario: RoadScenarioRef): RoadRoute | null {
  if (team.roadRouted !== true || team.routeFromNode === undefined) return null
  const net = getRoadNetwork(scenario)
  if (!net) return null
  return routeFor(net, team.id, team.routeFromNode, team.targetPosition)
}

// ── Road access for a contact ───────────────────────────────────────────────────
export interface ContactAccess {
  access: 'ok' | 'none'
  gapM: number | null
  /** One line for the contact panel (also its tooltip) when access is none. */
  reason: string | null
}

function formatGap(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`
}

export function contactAccess(scenario: RoadScenarioRef, contact: { sourceId: string; position: LatLng }): ContactAccess {
  const net = getRoadNetwork(scenario)
  if (!net) {
    return { access: 'none', gapM: null, reason: "No road data for this scenario — ground units can't reach this contact" }
  }
  const gap = contactAccessGapM(net, contact.sourceId, contact.position)
  if (gap === null) {
    return { access: 'none', gapM: null, reason: "No drivable road near this contact — ground units can't reach it" }
  }
  if (gap > MAX_ACCESS_GAP_M) {
    return { access: 'none', gapM: gap, reason: `Nearest road ${formatGap(gap)} — ground units can't reach this contact` }
  }
  return { access: 'ok', gapM: gap, reason: null }
}

/** 'ok' when a ground unit can drive to within 2 km of the contact; 'none' otherwise. */
export function contactRoadAccess(scenario: RoadScenarioRef, contact: { sourceId: string; position: LatLng }): 'ok' | 'none' {
  return contactAccess(scenario, contact).access
}

// ── Staging and dispatch plans ──────────────────────────────────────────────────
export interface VehicleApproach {
  /** The vehicle's own target (a contact or a downed drone). */
  target: LatLng
  /** Its graph start node. */
  node: number
}

function approachBearings(net: RoadNetwork, approaches: readonly VehicleApproach[]): number[] {
  return approaches
    .filter((a) => a.node >= 0 && a.node < net.nodes.length)
    .map((a) => bearingDeg(a.target, net.nodes[a.node]))
}

/**
 * Candidate start nodes for the incident command post, best first: the snapped edge's nearer end,
 * its other end, then the entries. A start more than 1500 m from any road stages at the first entry.
 */
export function startNodeCandidates(net: RoadNetwork, startPosition: LatLng): number[] {
  const snap = snapToRoad(net, startPosition, { role: 'origin' })
  if (!snap || snap.distM > START_SNAP_LIMIT_M) return [...net.entries]
  const edge = net.edges[snap.edge]
  const nearFirst = snap.t < 0.5
  const ends = nearFirst ? [edge.from, edge.to] : [edge.to, edge.from]
  const out: number[] = []
  for (const n of [...ends, ...net.entries]) if (!out.includes(n)) out.push(n)
  return out
}

/**
 * Approach list for bearing separation: every ground unit and every non-extracted recovery team
 * that has a start node, each paired with its own target.
 */
export function collectApproaches(
  groundUnits: readonly GroundUnitState[],
  contacts: ReadonlyArray<{ sourceId: string; position: LatLng }>,
  teams: readonly RecoveryTeamState[],
): VehicleApproach[] {
  const out: VehicleApproach[] = []
  for (const u of groundUnits) {
    if (u.routeFromNode === undefined) continue
    const c = contacts.find((tc) => tc.sourceId === u.targetThermalId)
    if (c) out.push({ target: c.position, node: u.routeFromNode })
  }
  for (const t of teams) {
    if (t.status === 'extracted' || t.routeFromNode === undefined) continue
    out.push({ target: t.targetPosition, node: t.routeFromNode })
  }
  return out
}

export type GroundDispatchPlan =
  | { ok: true; net: RoadNetwork; node: number; stagingPos: LatLng; route: RoadRoute; accessGapM: number; sig: string }
  | { ok: false; reason: 'no_network' | 'no_road' | 'too_far' | 'unreachable'; accessGapM: number | null }

/**
 * Where a new ground unit starts and the route it drives. The first unit starts at the incident
 * post (snapped); each additional unit takes the entry that maximises its minimum angular
 * separation to every existing approach. Never a straight line: a missing network or a gap over
 * 2 km refuses.
 */
export function planGroundDispatch(
  scenario: RoadScenarioRef & { startPosition: LatLng },
  contact: { sourceId: string; position: LatLng },
  existingUnits: number,
  approaches: readonly VehicleApproach[],
): GroundDispatchPlan {
  const net = getRoadNetwork(scenario)
  if (!net) return { ok: false, reason: 'no_network', accessGapM: null }
  const gap = contactAccessGapM(net, contact.sourceId, contact.position)
  if (gap === null) return { ok: false, reason: 'no_road', accessGapM: null }
  if (gap > MAX_ACCESS_GAP_M) return { ok: false, reason: 'too_far', accessGapM: gap }
  const target = snapToRoad(net, contact.position, { role: 'target' })
  if (!target) return { ok: false, reason: 'no_road', accessGapM: null }

  const candidates: number[] = []
  if (existingUnits > 0) {
    const entry = pickEntryNode(net, contact.position, target, net.entries, approachBearings(net, approaches))
    if (entry !== null) candidates.push(entry)
  }
  for (const n of startNodeCandidates(net, scenario.startPosition)) if (!candidates.includes(n)) candidates.push(n)
  for (const node of candidates) {
    const route = computeRoute(net, node, target)
    if (route.status !== 'ok') continue
    const nodePos = net.nodes[node]
    return {
      ok: true, net, node, stagingPos: { lat: nodePos.lat, lng: nodePos.lng }, route,
      accessGapM: gap, sig: routeSig(node, contact.position),
    }
  }
  return { ok: false, reason: 'unreachable', accessGapM: gap }
}

export type RecoveryPlan =
  | { roadRouted: true; net: RoadNetwork; node: number; stagingPos: LatLng; route: RoadRoute; accessGapM: number; sig: string }
  | { roadRouted: false; stagingPos: LatLng; accessGapM: number | null }

/**
 * Staging and route for a recovery team. Team 1 starts at the incident post (snapped); later teams
 * start at an entry chosen like additional ground units. Falls back to an unrouted team (frozen at
 * the staging point, no vehicle drawn) when there is no network, the snap fails, the walk-in from
 * the access point would exceed 750 m, or no staging node can reach the access point.
 */
export function planRecoveryDispatch(
  scenario: RoadScenarioRef & { startPosition: LatLng },
  dronePos: LatLng,
  teamsCreated: number,
  approaches: readonly VehicleApproach[],
): RecoveryPlan {
  const net = getRoadNetwork(scenario)
  if (!net) return { roadRouted: false, stagingPos: { ...scenario.startPosition }, accessGapM: null }
  const starts = startNodeCandidates(net, scenario.startPosition)
  const frozen = starts.length > 0 ? net.nodes[starts[0]] : scenario.startPosition
  const unrouted = (gap: number | null): RecoveryPlan => ({ roadRouted: false, stagingPos: { lat: frozen.lat, lng: frozen.lng }, accessGapM: gap })
  const target = snapToRoad(net, dronePos, { role: 'target' })
  if (!target) return unrouted(null)
  const gap = Math.round(target.distM * 10) / 10
  if (gap > RECOVERY_WALK_LIMIT_M) return unrouted(gap)

  const candidates: number[] = []
  if (teamsCreated > 0) {
    const entry = pickEntryNode(net, dronePos, target, net.entries, approachBearings(net, approaches))
    if (entry !== null) candidates.push(entry)
  }
  for (const n of starts) if (!candidates.includes(n)) candidates.push(n)
  for (const node of candidates) {
    const route = computeRoute(net, node, target)
    if (route.status !== 'ok') continue
    const nodePos = net.nodes[node]
    return {
      roadRouted: true, net, node, stagingPos: { lat: nodePos.lat, lng: nodePos.lng }, route,
      accessGapM: gap, sig: routeSig(node, dronePos),
    }
  }
  return unrouted(gap)
}
