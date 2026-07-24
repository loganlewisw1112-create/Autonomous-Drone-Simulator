import { describe, expect, it } from 'vitest'
import { INCIDENT_SCENARIOS } from '@/scenarios/catalog'
import {
  resolveTerrainFixtureId,
  scenariosWithTerrain,
  terrainFixtureFor,
  terrainRasterFor,
} from '@/scenarios/terrainFixtures'
import { buildingFixtureFor, scenariosWithBuildings } from '@/scenarios/buildingFixtures'

const PRIORITY_TERRAIN_IDS = [
  'demo_wildfire',
  'hist_oso_sr530_2014',
  'hist_camp_fire_paradise_2018',
  'hist_helene_asheville_2024',
  'hist_surfside_cts_2021',
  'train_mountain_sar',
  'train_wildfire_flank',
] as const

describe('Phase 6 terrain fixture expansion', () => {
  it('commits DEMs for every priority AO', () => {
    for (const id of PRIORITY_TERRAIN_IDS) {
      expect(terrainFixtureFor(id), id).toBeDefined()
      const raster = terrainRasterFor(id)
      expect(raster, id).toBeDefined()
      expect(raster!.width).toBeGreaterThan(100)
      expect(raster!.height).toBeGreaterThan(100)
      expect(raster!.maxElevationM).toBeGreaterThan(raster!.minElevationM - 1)
    }
    expect(scenariosWithTerrain()).toEqual(expect.arrayContaining([...PRIORITY_TERRAIN_IDS, 'nist_obstructed_lane']))
  })

  it('resolves terrainFixtureId aliases from catalog scenarios', () => {
    for (const id of PRIORITY_TERRAIN_IDS) {
      if (id === 'demo_wildfire') continue
      const scenario = INCIDENT_SCENARIOS.find((s) => s.id === id)
      expect(scenario, id).toBeDefined()
      expect(resolveTerrainFixtureId(scenario!), id).toBe(id)
    }
    const wildfire = INCIDENT_SCENARIOS.find((s) => s.id === 'demo_wildfire')
    expect(resolveTerrainFixtureId(wildfire)).toBe('demo_wildfire')
  })

  it('ships Surfside Overture building footprints', () => {
    expect(scenariosWithBuildings()).toContain('hist_surfside_cts_2021')
    const fixture = buildingFixtureFor('hist_surfside_cts_2021')
    expect(fixture?.features.length).toBeGreaterThan(50)
    for (const feature of fixture!.features.slice(0, 20)) {
      expect(feature.properties?.h).toBeGreaterThan(0)
      expect(Number.isFinite(feature.properties?.base)).toBe(true)
    }
  })
})
