import {
  createBuildingIndex,
  type BuildingFeatureCollection,
  type BuildingIndex,
} from '@/sim/terrain/buildingIndex'
import wildfireBuildings from './fixtures/demo_wildfire/buildings.json'

// Frozen Overture-derived footprints produced by tools/fixtures/buildings.mjs. Like terrain
// fixtures, these are committed data and never fetched while the simulator is running.
const BUILDINGS: Record<string, BuildingFeatureCollection> = {
  demo_wildfire: wildfireBuildings as unknown as BuildingFeatureCollection,
  // WP-9's obstructed lane is laid out in this same AO — terrain masking is the whole
  // content of that trial — so it reuses the identical committed fixture rather than
  // shipping a second copy of the same bytes.
  nist_obstructed_lane: wildfireBuildings as unknown as BuildingFeatureCollection,
}

const INDEXES = new Map<string, BuildingIndex>()

/** The frozen building collection for a scenario, or undefined when none is sourced. */
export function buildingFixtureFor(scenarioId: string): BuildingFeatureCollection | undefined {
  return BUILDINGS[scenarioId]
}

/** Shared immutable 100 m spatial index for a scenario's committed footprints. */
export function buildingIndexFor(scenarioId: string): BuildingIndex | undefined {
  const cached = INDEXES.get(scenarioId)
  if (cached) return cached
  const fixture = BUILDINGS[scenarioId]
  if (!fixture) return undefined
  const index = createBuildingIndex(fixture)
  INDEXES.set(scenarioId, index)
  return index
}

/** Scenario ids that currently have committed building coverage. */
export function scenariosWithBuildings(): string[] {
  return Object.keys(BUILDINGS)
}
