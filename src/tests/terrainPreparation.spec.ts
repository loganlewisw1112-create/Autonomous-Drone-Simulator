import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import {
  prepareScenarioTerrain,
  requireScenarioTerrainPrepared,
  scenariosWithTerrain,
  terrainFixtureFor,
  TerrainNotPreparedError,
} from '@/scenarios/terrainFixtures'
import { initFleet } from '@/sim/SimulationLoop'
import { useDroneStore } from '@/store/droneStore'

const EXPECTED_TERRAIN_IDS = [
  'demo_wildfire',
  'nist_obstructed_lane',
  'hist_oso_sr530_2014',
  'hist_camp_fire_paradise_2018',
  'hist_helene_asheville_2024',
  'hist_surfside_cts_2021',
  'train_mountain_sar',
  'train_wildfire_flank',
]

describe('target-neutral terrain preparation', () => {
  it('keeps one canonical fixture manifest and no target-specific data alias', () => {
    expect(scenariosWithTerrain()).toEqual(EXPECTED_TERRAIN_IDS)

    const viteConfig = readFileSync(join(process.cwd(), 'vite.config.ts'), 'utf8')
    expect(viteConfig).not.toMatch(/terrainFixtures\.mobile/)
    expect(viteConfig).not.toMatch(/find:\s*['"]@\/scenarios\/terrainFixtures/)
  })

  it('deduplicates concurrent imports and caches the prepared fixture', async () => {
    const [left, right] = await Promise.all([
      prepareScenarioTerrain('demo_wildfire'),
      prepareScenarioTerrain('demo_wildfire'),
    ])

    expect(left.ok).toBe(true)
    expect(right.ok).toBe(true)
    expect(terrainFixtureFor('demo_wildfire')).toBeDefined()
    expect(await prepareScenarioTerrain('demo_wildfire')).toEqual({
      ok: true,
      fixtureId: 'demo_wildfire',
      state: 'cached',
    })
  })

  it('does not require terrain for a scenario with no declared package', async () => {
    await expect(prepareScenarioTerrain({ id: 'custom-flat' })).resolves.toEqual({
      ok: true,
      fixtureId: null,
      state: 'not_required',
    })
    expect(() => requireScenarioTerrainPrepared({ id: 'custom-flat' })).not.toThrow()
  })

  it('fails closed for an explicitly declared package that is absent', async () => {
    const scenario = {
      ...ALL_SCENARIOS.find((candidate) => candidate.id === 'demo_basic')!,
      id: 'missing-terrain-package-test',
      terrainFixtureId: 'missing-terrain-package',
    }

    await expect(prepareScenarioTerrain(scenario)).resolves.toMatchObject({
      ok: false,
      fixtureId: 'missing-terrain-package',
      state: 'failed',
    })

    useDroneStore.setState({ scenario, launchPlan: null, drones: [] })
    expect(() => initFleet()).toThrow(TerrainNotPreparedError)
    expect(useDroneStore.getState().drones).toHaveLength(0)
  })
})
