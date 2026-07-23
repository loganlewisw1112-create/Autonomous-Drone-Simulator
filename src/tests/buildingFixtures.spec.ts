import { describe, expect, it } from 'vitest'
import {
  buildingFixtureFor,
  buildingIndexFor,
  scenariosWithBuildings,
} from '@/scenarios/buildingFixtures'
import { occlusionServiceFor } from '@/scenarios/terrainFixtures'

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
