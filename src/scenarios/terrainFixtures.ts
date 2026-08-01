import { loadTerrainRaster, type TerrainHeader, type TerrainRaster } from '@/sim/terrain/terrainRaster'
import {
  createTerrainOcclusionService,
  type OcclusionOptions,
  type TerrainOcclusionService,
} from '@/sim/terrain/OcclusionService'
import { buildingIndexFor } from './buildingFixtures'

// Frozen terrain DEMs produced by tools/fixtures/terrain.mjs (REALISM_ROADMAP WP-0/WP-4).
// Runtime mission loading is local-only: dynamic imports split committed fixtures into
// scenario chunks, but never fetch source data or contact a third-party service.

export interface TerrainFixture {
  /** Base64 data URI of the Terrarium PNG. */
  payload: string
  header: TerrainHeader
}

type FixtureModule = Readonly<{ fixture: TerrainFixture }>
type FixtureLoader = () => Promise<FixtureModule>

const loadWildfireTerrain = () => import('./terrainFixturePackages/demo_wildfire')

/**
 * This registry is the single simulation-data manifest for every build target.
 * Presentation modules may still differ (mobile omits MapLibre extrusion/terrain rendering),
 * but Vite must never replace or filter this registry by target.
 */
const TERRAIN_LOADERS: Readonly<Record<string, FixtureLoader>> = {
  demo_wildfire: loadWildfireTerrain,
  // WP-9 obstructed lane uses the same sourced Grizzly Peak DEM package.
  nist_obstructed_lane: loadWildfireTerrain,
  hist_oso_sr530_2014: () => import('./terrainFixturePackages/hist_oso_sr530_2014'),
  hist_camp_fire_paradise_2018: () => import('./terrainFixturePackages/hist_camp_fire_paradise_2018'),
  hist_helene_asheville_2024: () => import('./terrainFixturePackages/hist_helene_asheville_2024'),
  hist_surfside_cts_2021: () => import('./terrainFixturePackages/hist_surfside_cts_2021'),
  train_mountain_sar: () => import('./terrainFixturePackages/train_mountain_sar'),
  train_wildfire_flank: () => import('./terrainFixturePackages/train_wildfire_flank'),
}

/**
 * Physical fixture packages emitted as independent build chunks.
 *
 * `nist_obstructed_lane` intentionally aliases `demo_wildfire`, so the scenario registry has
 * eight keys while the artifact has seven physical packages. Keeping both manifests explicit
 * lets the release parity gate prove the alias itself is identical across targets without
 * pretending it is an eighth DEM.
 */
const TERRAIN_PACKAGE_IDS = [
  'demo_wildfire',
  'hist_camp_fire_paradise_2018',
  'hist_helene_asheville_2024',
  'hist_oso_sr530_2014',
  'hist_surfside_cts_2021',
  'train_mountain_sar',
  'train_wildfire_flank',
] as const

const preparedFixtures = new Map<string, TerrainFixture>()
const pendingFixtures = new Map<string, Promise<TerrainFixture>>()

export type TerrainPreparationResult =
  | Readonly<{ ok: true; fixtureId: null; state: 'not_required' }>
  | Readonly<{ ok: true; fixtureId: string; state: 'cached' | 'prepared' }>
  | Readonly<{ ok: false; fixtureId: string; state: 'failed'; reason: string }>

export class TerrainNotPreparedError extends Error {
  readonly fixtureId: string

  constructor(fixtureId: string) {
    super(`Terrain fixture "${fixtureId}" has not been prepared; mission initialization is blocked`)
    this.name = 'TerrainNotPreparedError'
    this.fixtureId = fixtureId
  }
}

/**
 * Resolve the committed DEM key for a scenario.
 * An explicit terrainFixtureId is returned even when unknown so preparation fails closed
 * instead of silently treating a misspelled or missing package as flat terrain.
 */
export function resolveTerrainFixtureId(
  scenario: { id: string; terrainFixtureId?: string } | string | null | undefined,
): string | undefined {
  if (!scenario) return undefined
  if (typeof scenario === 'string') {
    return TERRAIN_LOADERS[scenario] ? scenario : undefined
  }
  if (scenario.terrainFixtureId) return scenario.terrainFixtureId
  return TERRAIN_LOADERS[scenario.id] ? scenario.id : undefined
}

async function loadFixture(fixtureId: string): Promise<TerrainFixture> {
  const prepared = preparedFixtures.get(fixtureId)
  if (prepared) return prepared

  const pending = pendingFixtures.get(fixtureId)
  if (pending) return pending

  const loader = TERRAIN_LOADERS[fixtureId]
  if (!loader) throw new Error(`No committed terrain package exists for "${fixtureId}"`)

  const request = loader()
    .then(({ fixture }) => {
      if (
        !fixture
        || !fixture.payload.startsWith('data:image/png;base64,')
        || fixture.header.width <= 0
        || fixture.header.height <= 0
      ) {
        throw new Error(`Terrain package "${fixtureId}" is malformed`)
      }
      preparedFixtures.set(fixtureId, fixture)
      pendingFixtures.delete(fixtureId)
      return fixture
    })
    .catch((error: unknown) => {
      pendingFixtures.delete(fixtureId)
      throw error
    })

  pendingFixtures.set(fixtureId, request)
  return request
}

/**
 * Prepare a scenario's committed terrain package before fleet initialization.
 * Concurrent callers share one import promise; successful packages stay cached for the session.
 */
export async function prepareScenarioTerrain(
  scenario: { id: string; terrainFixtureId?: string } | string | null | undefined,
): Promise<TerrainPreparationResult> {
  const fixtureId = resolveTerrainFixtureId(scenario)
  if (!fixtureId) return { ok: true, fixtureId: null, state: 'not_required' }
  if (preparedFixtures.has(fixtureId)) return { ok: true, fixtureId, state: 'cached' }

  try {
    await loadFixture(fixtureId)
    return { ok: true, fixtureId, state: 'prepared' }
  } catch (error) {
    return {
      ok: false,
      fixtureId,
      state: 'failed',
      reason: error instanceof Error ? error.message : `Terrain package "${fixtureId}" failed to load`,
    }
  }
}

/** Fail-closed assertion used by the synchronous simulation initialization boundary. */
export function requireScenarioTerrainPrepared(
  scenario: { id: string; terrainFixtureId?: string } | string | null | undefined,
): void {
  const fixtureId = resolveTerrainFixtureId(scenario)
  if (fixtureId && !preparedFixtures.has(fixtureId)) throw new TerrainNotPreparedError(fixtureId)
}

/** The prepared terrain fixture, or undefined before preparation / when no fixture exists. */
export function terrainFixtureFor(scenarioId: string): TerrainFixture | undefined {
  return preparedFixtures.get(scenarioId)
}

/** Scenario / fixture ids that have committed DEM packages in every build target. */
export function scenariosWithTerrain(): string[] {
  return Object.keys(TERRAIN_LOADERS)
}

/** Physical committed DEM package ids expected in every built target. */
export function terrainPackageIds(): string[] {
  return [...TERRAIN_PACKAGE_IDS]
}

/** Decoded DEM for a prepared scenario. */
export function terrainRasterFor(scenarioId: string): TerrainRaster | undefined {
  const fixture = preparedFixtures.get(scenarioId)
  return fixture ? loadTerrainRaster(fixture.payload, fixture.header) : undefined
}

/**
 * A fresh occlusion service over a prepared scenario's DEM.
 *
 * Deliberately NOT memoised: the service carries a 1 Hz epoch and its LOS cache, and handing
 * two unrelated consumers the same mutable epoch would let one clear the other's cache.
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
