import type { LatLng } from '@/types'

// Frozen Overture-derived drivable road graphs produced by tools/fixtures/roads.mjs. Like the
// building footprints and terrain DEMs these are committed data: the app never fetches roads
// while running. Each fixture is its own async chunk (never on the startup path), staged once
// through prepareScenarioTerrain's pre-terrain block, and read synchronously afterwards via
// getRoadNetwork. A scenario without a fixture (custom, parked, or a failed load) simply has no
// road network, which callers treat as "No road access".

/** On-disk class code = index into this list. */
export const ROAD_CLASS_NAMES = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'unclassified', 'residential', 'living_street', 'service', 'track',
] as const
export type RoadClassName = (typeof ROAD_CLASS_NAMES)[number]

/** Edge flag bit field: 1 = bridge, 2 = tunnel or covered (hidden). */
export const ROAD_FLAG_BRIDGE = 1
export const ROAD_FLAG_HIDDEN = 2

/** Compact on-disk shape of a roads.json fixture (format version 1). */
export interface EncodedRoadNetwork {
  v: 1
  /** [lng0, lat0] of the integer grid origin. */
  origin: [number, number]
  /** Grid steps per degree (1e6, about 0.11 m). */
  scale: number
  /** Delta-encoded integer pairs: [dx0, dy0, dx1, dy1, ...] relative to the previous node. */
  nodes: number[]
  /** [from, to, class, speedCode (x 0.5 m/s), oneway (0|1), flags, geomStart, geomLen]. */
  edges: number[][]
  /** Interior vertices, delta-encoded pairs per edge, the first relative to the edge's `from` node. */
  geom: number[]
  /** Node indices where additional units may enter (at most 8). */
  entries: number[]
}

export interface RoadEdge {
  from: number
  to: number
  /** On-disk class code; see ROAD_CLASS_NAMES. */
  cls: number
  roadClass: RoadClassName
  /** Emergency-response speed in m/s, before any weather divide. */
  speedMps: number
  /** 0 = drivable both ways, 1 = only from -> to. Never 2: backward-only edges are stored swapped. */
  oneway: 0 | 1
  /** ROAD_FLAG_BRIDGE | ROAD_FLAG_HIDDEN. */
  flags: number
  /** Full polyline from node `from` to node `to`, endpoints included. */
  points: readonly LatLng[]
  lengthM: number
}

export interface RoadNetwork {
  nodes: readonly LatLng[]
  edges: readonly RoadEdge[]
  /** Node indices (sorted) where extra units enter the network. */
  entries: readonly number[]
  /** Fastest edge speed in the network, in m/s. */
  maxSpeed: number
}

const M_PER_DEG = 111195

/** Equirectangular metres between two points (same helper family the router uses). */
function metres(a: LatLng, b: LatLng): number {
  const cos = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180)
  return Math.hypot((b.lng - a.lng) * cos * M_PER_DEG, (b.lat - a.lat) * M_PER_DEG)
}

/** Decode the compact fixture. Pure; throws on a malformed shape. */
export function decodeRoadNetwork(encoded: EncodedRoadNetwork): RoadNetwork {
  if (
    !encoded || encoded.v !== 1 || !Array.isArray(encoded.nodes) || !Array.isArray(encoded.edges)
    || !Array.isArray(encoded.geom) || !Array.isArray(encoded.origin) || !(encoded.scale > 0)
  ) {
    throw new Error('Road fixture is malformed')
  }
  const [lng0, lat0] = encoded.origin
  const scale = encoded.scale
  const quantised: Array<[number, number]> = []
  let x = 0
  let y = 0
  for (let i = 0; i + 1 < encoded.nodes.length; i += 2) {
    x += encoded.nodes[i]
    y += encoded.nodes[i + 1]
    quantised.push([x, y])
  }
  const toLatLng = (qx: number, qy: number): LatLng => ({ lat: lat0 + qy / scale, lng: lng0 + qx / scale })
  const nodes = quantised.map(([qx, qy]) => toLatLng(qx, qy))
  let maxSpeed = 0
  const edges: RoadEdge[] = encoded.edges.map((row) => {
    const [from, to, cls, speedCode, oneway, flags, geomStart, geomLen] = row
    if (!nodes[from] || !nodes[to] || !ROAD_CLASS_NAMES[cls]) throw new Error('Road fixture is malformed')
    const points: LatLng[] = [nodes[from]]
    let cx = quantised[from][0]
    let cy = quantised[from][1]
    for (let i = 0; i < geomLen; i++) {
      cx += encoded.geom[(geomStart + i) * 2]
      cy += encoded.geom[(geomStart + i) * 2 + 1]
      points.push(toLatLng(cx, cy))
    }
    points.push(nodes[to])
    let lengthM = 0
    for (let i = 1; i < points.length; i++) lengthM += metres(points[i - 1], points[i])
    const speedMps = speedCode * 0.5
    maxSpeed = Math.max(maxSpeed, speedMps)
    return {
      from, to, cls, roadClass: ROAD_CLASS_NAMES[cls], speedMps,
      oneway: oneway === 1 ? 1 : 0, flags, points, lengthM,
    }
  })
  return { nodes, edges, entries: [...encoded.entries], maxSpeed }
}

type RoadLoader = () => Promise<{ default: unknown }>

/**
 * Simulation-data manifest for committed road graphs, identical in every build target.
 * One dynamic import per scenario, so each fixture is its own `roads-*` chunk. Scenarios whose
 * roads were parked at authoring time (see tools/fixtures/roadTargets.json) are absent.
 */
const ROAD_LOADERS: Readonly<Record<string, RoadLoader>> = {
  demo_basic: () => import('./fixtures/demo_basic/roads.json'),
  demo_perimeter: () => import('./fixtures/demo_perimeter/roads.json'),
  demo_sar: () => import('./fixtures/demo_sar/roads.json'),
  demo_sar_coastal: () => import('./fixtures/demo_sar_coastal/roads.json'),
  demo_wildfire: () => import('./fixtures/demo_wildfire/roads.json'),
  hist_camp_fire_paradise_2018: () => import('./fixtures/hist_camp_fire_paradise_2018/roads.json'),
  hist_east_palestine_2023: () => import('./fixtures/hist_east_palestine_2023/roads.json'),
  hist_harvey_houston_2017: () => import('./fixtures/hist_harvey_houston_2017/roads.json'),
  hist_helene_asheville_2024: () => import('./fixtures/hist_helene_asheville_2024/roads.json'),
  hist_joplin_ef5_2011: () => import('./fixtures/hist_joplin_ef5_2011/roads.json'),
  hist_katrina_lower_ninth_2005: () => import('./fixtures/hist_katrina_lower_ninth_2005/roads.json'),
  hist_kilauea_leilani_2018: () => import('./fixtures/hist_kilauea_leilani_2018/roads.json'),
  hist_marshall_fire_2021: () => import('./fixtures/hist_marshall_fire_2021/roads.json'),
  hist_oso_sr530_2014: () => import('./fixtures/hist_oso_sr530_2014/roads.json'),
  hist_surfside_cts_2021: () => import('./fixtures/hist_surfside_cts_2021/roads.json'),
  train_flood_corridor: () => import('./fixtures/train_flood_corridor/roads.json'),
  train_hazmat_plume: () => import('./fixtures/train_hazmat_plume/roads.json'),
  train_infra_inspection: () => import('./fixtures/train_infra_inspection/roads.json'),
  train_mountain_sar: () => import('./fixtures/train_mountain_sar/roads.json'),
  train_night_relay_sar: () => import('./fixtures/train_night_relay_sar/roads.json'),
  train_tornado_sector: () => import('./fixtures/train_tornado_sector/roads.json'),
  train_urban_usar: () => import('./fixtures/train_urban_usar/roads.json'),
  train_uscg_maritime_sar: () => import('./fixtures/train_uscg_maritime_sar/roads.json'),
  train_welfare_grid: () => import('./fixtures/train_welfare_grid/roads.json'),
  train_wildfire_flank: () => import('./fixtures/train_wildfire_flank/roads.json'),
}

const preparedRoads = new Map<string, RoadNetwork>()
const pendingRoads = new Map<string, Promise<RoadNetwork>>()

/**
 * Load a scenario's committed road graph into the session cache. Scenarios without a fixture
 * resolve immediately; concurrent callers share one import promise; a failure is NOT cached, so
 * the next call retries the chunk import.
 */
export async function prepareScenarioRoads(scenarioId: string): Promise<void> {
  if (preparedRoads.has(scenarioId)) return
  const loader = ROAD_LOADERS[scenarioId]
  if (!loader) return
  const pending = pendingRoads.get(scenarioId)
  if (pending) {
    await pending
    return
  }
  const request = loader()
    .then(({ default: encoded }) => {
      const network = decodeRoadNetwork(encoded as EncodedRoadNetwork)
      preparedRoads.set(scenarioId, network)
      pendingRoads.delete(scenarioId)
      return network
    })
    .catch((error: unknown) => {
      pendingRoads.delete(scenarioId)
      throw error
    })
  pendingRoads.set(scenarioId, request)
  await request
}

/**
 * Non-fatal staging used by the scenario-preparation gate: retries a failed import once, then
 * logs and carries on. The scenario then has no road network ("No road access"); the gate never
 * fails because of roads.
 */
export async function prepareScenarioRoadsNonFatal(scenarioId: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await prepareScenarioRoads(scenarioId)
      return
    } catch (error) {
      if (attempt === 1) {
        console.warn(`Road fixture "${scenarioId}" failed to load; treating the scenario as having no road access`, error)
      }
    }
  }
}

/**
 * The prepared road network for a scenario, or null before staging / when none exists.
 * Tries the fixture registered under `scenario.id`, then the one it aliases through
 * `terrainFixtureId` (for example trainingScenarios -> demo_wildfire).
 */
export function getRoadNetwork(scenario: { id: string; terrainFixtureId?: string }): RoadNetwork | null {
  return preparedRoads.get(scenario.id)
    ?? (scenario.terrainFixtureId ? preparedRoads.get(scenario.terrainFixtureId) : undefined)
    ?? null
}

/** Scenario ids that currently have a committed road fixture. */
export function scenariosWithRoads(): string[] {
  return Object.keys(ROAD_LOADERS)
}
