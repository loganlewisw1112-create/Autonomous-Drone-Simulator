import { loadTerrainRaster, type TerrainHeader, type TerrainRaster } from '@/sim/terrain/terrainRaster'
import {
  createTerrainOcclusionService,
  type OcclusionOptions,
  type TerrainOcclusionService,
} from '@/sim/terrain/OcclusionService'
import { buildingIndexFor } from './buildingFixtures'
import wildfireHeader from './fixtures/demo_wildfire/terrain.json'
import wildfirePng from './fixtures/demo_wildfire/terrain.png?inline'
import osoHeader from './fixtures/hist_oso_sr530_2014/terrain.json'
import osoPng from './fixtures/hist_oso_sr530_2014/terrain.png?inline'
import campHeader from './fixtures/hist_camp_fire_paradise_2018/terrain.json'
import campPng from './fixtures/hist_camp_fire_paradise_2018/terrain.png?inline'
import heleneHeader from './fixtures/hist_helene_asheville_2024/terrain.json'
import helenePng from './fixtures/hist_helene_asheville_2024/terrain.png?inline'
import surfsideHeader from './fixtures/hist_surfside_cts_2021/terrain.json'
import surfsidePng from './fixtures/hist_surfside_cts_2021/terrain.png?inline'
import mountainHeader from './fixtures/train_mountain_sar/terrain.json'
import mountainPng from './fixtures/train_mountain_sar/terrain.png?inline'
import flankHeader from './fixtures/train_wildfire_flank/terrain.json'
import flankPng from './fixtures/train_wildfire_flank/terrain.png?inline'

// Frozen terrain DEMs produced by tools/fixtures/terrain.mjs (REALISM_ROADMAP WP-0/WP-4).
// Same shape as observedWeather.ts: a static import of committed data, keyed by fixture id.
// Never a runtime fetch (§3, enforced by the ESLint rule over src/sim + src/scenarios).
//
// Phase 6 expands DEMs only for priority AOs (Oso, Camp Fire, Helene, Surfside, mountain SAR,
// Dixie flank). Mobile builds alias to terrainFixtures.mobile.ts so phone bundles keep a subset.
//
// WHY `?inline`: DEM must decode identically in browser, classroom, and vitest node — Vite
// resolves the PNG to a base64 data URI at transform time. Runtime fetch is banned.

export interface TerrainFixture {
  /** Base64 data URI of the Terrarium PNG. */
  payload: string
  header: TerrainHeader
}

const TERRAIN: Record<string, TerrainFixture> = {
  demo_wildfire: { payload: wildfirePng, header: wildfireHeader },
  // WP-9 obstructed lane reuses the Grizzly Peak DEM (same AO).
  nist_obstructed_lane: { payload: wildfirePng, header: wildfireHeader },
  hist_oso_sr530_2014: { payload: osoPng, header: osoHeader },
  hist_camp_fire_paradise_2018: { payload: campPng, header: campHeader },
  hist_helene_asheville_2024: { payload: helenePng, header: heleneHeader },
  hist_surfside_cts_2021: { payload: surfsidePng, header: surfsideHeader },
  train_mountain_sar: { payload: mountainPng, header: mountainHeader },
  train_wildfire_flank: { payload: flankPng, header: flankHeader },
}

/**
 * Resolve the committed DEM key for a scenario.
 * Prefers explicit `terrainFixtureId`, then falls back to the scenario id when a fixture exists.
 */
export function resolveTerrainFixtureId(
  scenario: { id: string; terrainFixtureId?: string } | string | null | undefined,
): string | undefined {
  if (!scenario) return undefined
  if (typeof scenario === 'string') {
    return TERRAIN[scenario] ? scenario : undefined
  }
  const key = scenario.terrainFixtureId ?? scenario.id
  return TERRAIN[key] ? key : undefined
}

/** The frozen terrain fixture for a scenario/fixture id, or undefined when none is sourced yet. */
export function terrainFixtureFor(scenarioId: string): TerrainFixture | undefined {
  return TERRAIN[scenarioId]
}

/** Scenario / fixture ids that currently have a committed DEM in this build. */
export function scenariosWithTerrain(): string[] {
  return Object.keys(TERRAIN)
}

/**
 * Decoded DEM for a scenario. The decode is memoised inside `loadTerrainRaster` on the payload
 * itself, so repeated calls share one Float32Array rather than re-inflating the PNG.
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
 * expensive part — the decoded raster — is shared.
 */
export function occlusionServiceFor(
  scenarioId: string,
  options?: OcclusionOptions,
): TerrainOcclusionService | undefined {
  const raster = terrainRasterFor(scenarioId)
  if (!raster) return undefined
  return createTerrainOcclusionService(raster, {
    ...options,
    structures: options?.structures ?? buildingIndexFor(scenarioId),
  })
}
