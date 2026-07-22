import { loadTerrainRaster, type TerrainHeader, type TerrainRaster } from '@/sim/terrain/terrainRaster'
import {
  createTerrainOcclusionService,
  type OcclusionOptions,
  type TerrainOcclusionService,
} from '@/sim/terrain/OcclusionService'
import wildfireHeader from './fixtures/demo_wildfire/terrain.json'
import wildfirePng from './fixtures/demo_wildfire/terrain.png?inline'

// Frozen terrain DEMs produced by tools/fixtures/terrain.mjs (REALISM_ROADMAP WP-0/WP-4).
// Same shape as observedWeather.ts: a static import of committed data, keyed by scenario id.
// Never a runtime fetch (§3, enforced by the ESLint rule over src/sim + src/scenarios).
//
// WHY `?inline` RATHER THAN A URL OR fs.readFile. The DEM has to decode identically in three
// places — the browser build, the classroom build, and vitest's *node* environment, where there
// is neither `fetch` nor a canvas. Vite's `?inline` resolves the PNG to a base64 data URI at
// build/transform time, so all three get the same immutable string out of the bundle and the
// decode stays synchronous and pure. `?url` would hand back a path that node cannot read, and a
// runtime fetch is banned outright.
//
// COST, STATED PLAINLY. Base64 costs ~33% over the raw PNG (290 KB → ~387 KB of module text)
// and every fixture added here lands in whatever chunk imports it. Nothing in the app graph
// imports this module yet — WP-4's live wiring (AGL floors, safety) is a separate reviewed step
// — so it currently tree-shakes out of the shipped bundles entirely. When it is wired in, weigh
// a dynamic import per scenario; this module is the single place that would change.

export interface TerrainFixture {
  /** Base64 data URI of the Terrarium PNG. */
  payload: string
  header: TerrainHeader
}

const TERRAIN: Record<string, TerrainFixture> = {
  // Grizzly Peak / East Bay Hills. §4.6 names this AO explicitly: "terrain masking makes relay
  // aircraft placement a real decision". 503 m of relief across the AO makes it the scenario
  // where terrain occlusion is most visibly load-bearing.
  demo_wildfire: { payload: wildfirePng, header: wildfireHeader },
}

/** The frozen terrain fixture for a scenario, or undefined when none is sourced yet. */
export function terrainFixtureFor(scenarioId: string): TerrainFixture | undefined {
  return TERRAIN[scenarioId]
}

/** Scenario ids that currently have a committed DEM. */
export function scenariosWithTerrain(): string[] {
  return Object.keys(TERRAIN)
}

/**
 * Decoded DEM for a scenario. The decode is memoised inside `loadTerrainRaster` on the payload
 * itself, so repeated calls share one Float32Array rather than re-inflating ~1.3 MB of PNG.
 */
export function terrainRasterFor(scenarioId: string): TerrainRaster | undefined {
  const fixture = TERRAIN[scenarioId]
  return fixture ? loadTerrainRaster(fixture.payload, fixture.header) : undefined
}

/**
 * A fresh occlusion service over a scenario's DEM.
 *
 * Deliberately NOT memoised: the service carries a 1 Hz epoch and its LOS cache, and handing
 * two unrelated consumers the same mutable epoch would let one clear the other's cache. The
 * expensive part — the decoded raster — is shared. Two services built this way return identical
 * results for identical inputs, which is what determinism requires (§3).
 */
export function occlusionServiceFor(
  scenarioId: string,
  options?: OcclusionOptions,
): TerrainOcclusionService | undefined {
  const raster = terrainRasterFor(scenarioId)
  return raster ? createTerrainOcclusionService(raster, options) : undefined
}
