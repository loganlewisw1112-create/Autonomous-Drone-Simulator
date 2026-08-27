import {
  createBuildingIndex,
  type BuildingFeatureCollection,
  type BuildingIndex,
} from '@/sim/terrain/buildingIndex'

// Frozen Overture-derived footprints produced by tools/fixtures/buildings.mjs. Like terrain
// fixtures, these are committed data and never fetched while the simulator is running.
//
// F-12: the committed collections total ~1.4 MB of JSON. Importing them statically pinned that
// payload into the startup `catalog` chunk, so — mirroring TERRAIN_LOADERS — dynamic imports
// split each physical fixture into its own async chunk, staged once through the same
// scenario-preparation gate that stages the DEM (prepareScenarioTerrain). Every accessor below
// stays synchronous over the session cache, so post-preparation data and behavior are identical
// to the old static imports.
type BuildingLoader = () => Promise<{ default: unknown }>

const loadWildfireBuildings = () => import('./fixtures/demo_wildfire/buildings.json')

/**
 * Simulation-data manifest for committed footprints, identical in every build target.
 * Presentation modules may differ (mobile omits the extrusion layer), but Vite must never
 * replace or filter this registry by target.
 */
const BUILDING_LOADERS: Readonly<Record<string, BuildingLoader>> = {
  demo_wildfire: loadWildfireBuildings,
  // WP-9's obstructed lane is laid out in this same AO — terrain masking is the whole
  // content of that trial — so it reuses the identical committed fixture rather than
  // shipping a second copy of the same bytes.
  nist_obstructed_lane: loadWildfireBuildings,
  // Phase 6 — Surfside collapse AO (Overture footprints + small DEM for base MSL).
  hist_surfside_cts_2021: () => import('./fixtures/hist_surfside_cts_2021/buildings.json'),
}

const preparedBuildings = new Map<string, BuildingFeatureCollection>()
const pendingBuildings = new Map<string, Promise<BuildingFeatureCollection>>()
const INDEXES = new Map<string, BuildingIndex>()

export class BuildingsNotPreparedError extends Error {
  readonly scenarioId: string

  constructor(scenarioId: string) {
    super(`Building fixture "${scenarioId}" has not been prepared; mission initialization is blocked`)
    this.name = 'BuildingsNotPreparedError'
    this.scenarioId = scenarioId
  }
}

/**
 * Load a scenario's committed building fixture into the session cache.
 * Scenarios without committed footprints resolve immediately; concurrent callers share one
 * import promise; successful fixtures stay cached for the session.
 */
export async function prepareScenarioBuildings(scenarioId: string): Promise<void> {
  if (preparedBuildings.has(scenarioId)) return
  const loader = BUILDING_LOADERS[scenarioId]
  if (!loader) return

  const pending = pendingBuildings.get(scenarioId)
  if (pending) {
    await pending
    return
  }

  const request = loader()
    .then(({ default: collection }) => {
      const fixture = collection as BuildingFeatureCollection
      if (!fixture || !Array.isArray(fixture.features)) {
        throw new Error(`Building fixture "${scenarioId}" is malformed`)
      }
      preparedBuildings.set(scenarioId, fixture)
      pendingBuildings.delete(scenarioId)
      return fixture
    })
    .catch((error: unknown) => {
      pendingBuildings.delete(scenarioId)
      throw error
    })

  pendingBuildings.set(scenarioId, request)
  await request
}

/**
 * Fail-closed assertion mirroring requireScenarioTerrainPrepared (F-12): the sim must never
 * tick with structures absent for a scenario that has them, so a sourced-but-unstaged fixture
 * is a hard error, never a "no buildings" fallback.
 */
export function requireScenarioBuildingsPrepared(scenarioId: string | null | undefined): void {
  if (!scenarioId) return
  if (BUILDING_LOADERS[scenarioId] && !preparedBuildings.has(scenarioId)) {
    throw new BuildingsNotPreparedError(scenarioId)
  }
}

/** The frozen building collection for a prepared scenario, or undefined when none is sourced. */
export function buildingFixtureFor(scenarioId: string): BuildingFeatureCollection | undefined {
  return preparedBuildings.get(scenarioId)
}

/** Shared immutable 100 m spatial index for a prepared scenario's committed footprints. */
export function buildingIndexFor(scenarioId: string): BuildingIndex | undefined {
  const cached = INDEXES.get(scenarioId)
  if (cached) return cached
  const fixture = preparedBuildings.get(scenarioId)
  if (!fixture) return undefined
  const index = createBuildingIndex(fixture)
  INDEXES.set(scenarioId, index)
  return index
}

/** Scenario ids that currently have committed building coverage. */
export function scenariosWithBuildings(): string[] {
  return Object.keys(BUILDING_LOADERS)
}
