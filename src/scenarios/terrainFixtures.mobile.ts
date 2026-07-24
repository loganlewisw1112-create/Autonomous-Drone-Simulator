import { loadTerrainRaster, type TerrainHeader, type TerrainRaster } from '@/sim/terrain/terrainRaster'
import {
  createTerrainOcclusionService,
  type OcclusionOptions,
  type TerrainOcclusionService,
} from '@/sim/terrain/OcclusionService'
import { buildingIndexFor } from './buildingFixtures'
import wildfireHeader from './fixtures/demo_wildfire/terrain.json'
import wildfirePng from './fixtures/demo_wildfire/terrain.png?inline'

// Mobile subset — only the Grizzly Peak DEM (+ NIST obstructed-lane alias).
// Classroom / Windows / universal builds use terrainFixtures.ts with the full Phase 6 set.
// Vite aliases `@/scenarios/terrainFixtures` → this file when VITE_APP_TARGET=mobile.

export interface TerrainFixture {
  payload: string
  header: TerrainHeader
}

const TERRAIN: Record<string, TerrainFixture> = {
  demo_wildfire: { payload: wildfirePng, header: wildfireHeader },
  nist_obstructed_lane: { payload: wildfirePng, header: wildfireHeader },
}

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

export function terrainFixtureFor(scenarioId: string): TerrainFixture | undefined {
  return TERRAIN[scenarioId]
}

export function scenariosWithTerrain(): string[] {
  return Object.keys(TERRAIN)
}

export function terrainRasterFor(scenarioId: string): TerrainRaster | undefined {
  const fixture = TERRAIN[scenarioId]
  return fixture ? loadTerrainRaster(fixture.payload, fixture.header) : undefined
}

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
