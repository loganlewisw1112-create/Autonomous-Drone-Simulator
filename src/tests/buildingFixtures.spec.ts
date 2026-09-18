import { describe, expect, it } from 'vitest'
import {
  buildingFixtureFor,
  buildingIndexFor,
  scenariosWithBuildings,
} from '@/scenarios/buildingFixtures'
import { occlusionServiceFor, prepareScenarioTerrain } from '@/scenarios/terrainFixtures'

const terrainPreparation = await prepareScenarioTerrain('demo_wildfire')
if (!terrainPreparation.ok) throw new Error(terrainPreparation.reason)

const KNOWN_FOOTPRINT = { lat: 37.89146, lng: -122.2665625 }

describe('committed building fixtures', () => {
  it('loads and caches the 100 m demo wildfire index', () => {
    const fixture = buildingFixtureFor('demo_wildfire')
    const first = buildingIndexFor('demo_wildfire')
    const second = buildingIndexFor('demo_wildfire')

    expect(fixture?.features).toHaveLength(3_986)
    expect(first).toBe(second)
    expect(first?.buildingCount).toBe(3_986)
    expect(first?.cellSizeM).toBe(100)
    expect(first?.cellCount).toBeGreaterThan(0)
    expect(scenariosWithBuildings()).toContain('demo_wildfire')
    expect(buildingFixtureFor('missing')).toBeUndefined()
    expect(buildingIndexFor('missing')).toBeUndefined()
  })

  it('resolves a known measured footprint roof', () => {
    const hit = buildingIndexFor('demo_wildfire')?.surfaceAt(
      KNOWN_FOOTPRINT.lat,
      KNOWN_FOOTPRINT.lng,
    )

    expect(hit).toMatchObject({
      index: 0,
      h: 6.4,
      hSrc: 'measured',
      base: 175.3,
    })
    expect(hit?.topMslM).toBeCloseTo(181.7, 8)
  })

  it('uses buildings by default for surface height and LOS', () => {
    const service = occlusionServiceFor('demo_wildfire')
    expect(service).toBeDefined()
    if (!service) return

    const ground = service.groundElevation(KNOWN_FOOTPRINT.lat, KNOWN_FOOTPRINT.lng)
    const surface = service.surfaceHeight(KNOWN_FOOTPRINT.lat, KNOWN_FOOTPRINT.lng)
    expect(surface).toBeCloseTo(181.7, 8)
    expect(surface).toBeGreaterThan(ground)

    const belowRoof = {
      ...KNOWN_FOOTPRINT,
      altMslM: surface - 1,
    }
    const los = service.hasLineOfSight(belowRoof, belowRoof)
    expect(los.clear).toBe(false)
    expect(los.blockedBy).toBe('building')
    expect(los.blockHeight).toBeCloseTo(surface, 8)
  })

  it('lets an explicit structure layer override the scenario fixture', () => {
    const service = occlusionServiceFor('demo_wildfire', {
      structures: {
        maxTopM: 900,
        topAt: () => 900,
      },
    })

    expect(service?.surfaceHeight(KNOWN_FOOTPRINT.lat, KNOWN_FOOTPRINT.lng)).toBe(900)
  })
})

// Buildings coverage pass: the urban disaster AOs whose terrain shipped now carry real Overture
// footprints (New Orleans, Houston cropped to the mission core; the Marshall Fire suburbs whole).
describe('urban-AO building coverage', () => {
  const NEW_BUILDING_AOS = [
    'hist_katrina_lower_ninth_2005',
    'hist_harvey_houston_2017',
    'hist_marshall_fire_2021',
  ]

  it('registers each new urban AO with real, non-trivial committed footprints', async () => {
    const covered = new Set(scenariosWithBuildings())
    for (const id of NEW_BUILDING_AOS) {
      expect(covered.has(id), `${id} should have committed buildings`).toBe(true)

      const prep = await prepareScenarioTerrain(id)
      expect(prep.ok, `${id}: ${prep.ok ? '' : prep.reason}`).toBe(true)

      const fixture = buildingFixtureFor(id)
      // A dense urban core is thousands of footprints; anything tiny would mean a broken fetch.
      expect(fixture?.features.length ?? 0, `${id} footprint count`).toBeGreaterThan(500)

      const index = buildingIndexFor(id)
      expect(index?.buildingCount, `${id} index`).toBe(fixture?.features.length)
      expect(index?.maxTopM ?? 0).toBeGreaterThan(0)
    }
  }, 30_000)
})
