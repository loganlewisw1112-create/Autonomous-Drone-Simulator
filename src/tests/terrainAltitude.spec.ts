import { describe, expect, it, vi } from 'vitest'
import { createTerrainOcclusionService } from '@/sim/terrain/OcclusionService'
import {
  aglFtToMslM,
  ensureSurfaceClearanceAglFt,
  terrainAltitudeSnapshot,
} from '@/sim/terrain/altitude'
import type { TerrainRaster } from '@/sim/terrain/terrainRaster'

const raster: TerrainRaster = {
  width: 2,
  height: 2,
  bounds: { west: 0, south: 0, east: 2, north: 2 },
  metersPerPixel: 10,
  surface: 'bare-earth',
  minElevationM: 100,
  maxElevationM: 100,
  elevations: new Float32Array([100, 100, 100, 100]),
}

function serviceWithStructure() {
  return createTerrainOcclusionService(raster, {
    structures: {
      maxTopM: 112,
      topAt: () => 112,
    },
  })
}

describe('terrain altitude conversion', () => {
  it('keeps AGL canonical while deriving aircraft MSL and structure clearance', () => {
    const service = serviceWithStructure()
    const position = { lat: 1, lng: 1 }

    expect(aglFtToMslM(service, position, 100)).toBeCloseTo(130.48, 8)
    expect(terrainAltitudeSnapshot(service, position, 100)).toEqual({
      coverage: 'available',
      groundMslM: 100,
      aircraftMslM: 130.48,
      structureHeightM: 12,
      surfaceClearanceFt: expect.closeTo(60.6299212598, 8),
    })
  })

  it('reports unavailable terrain without inventing MSL values', () => {
    const position = { lat: 1, lng: 1 }

    expect(aglFtToMslM(undefined, position, 120)).toBeNull()
    expect(terrainAltitudeSnapshot(undefined, position, 120)).toEqual({
      coverage: 'unavailable',
      groundMslM: null,
      aircraftMslM: null,
      structureHeightM: null,
      surfaceClearanceFt: null,
    })
  })

  it('checks raster coverage before sampling an outside position', () => {
    const service = serviceWithStructure()
    const ground = vi.spyOn(service, 'groundElevation')
    const surface = vi.spyOn(service, 'surfaceHeight')
    const outside = { lat: 3, lng: 1 }

    expect(aglFtToMslM(service, outside, 120)).toBeNull()
    expect(terrainAltitudeSnapshot(service, outside, 120)).toEqual({
      coverage: 'outside',
      groundMslM: null,
      aircraftMslM: null,
      structureHeightM: null,
      surfaceClearanceFt: null,
    })
    expect(ground).not.toHaveBeenCalled()
    expect(surface).not.toHaveBeenCalled()
  })

  it('raises commanded AGL just enough to clear structures and ridges', () => {
    const service = serviceWithStructure()
    const position = { lat: 1, lng: 1 }
    // 12 m structure ≈ 39.37 ft; commanded 30 ft AGL leaves ~-9.37 ft clearance.
    const raised = ensureSurfaceClearanceAglFt(service, position, 30, 20)
    expect(raised).toBeGreaterThan(30)
    const after = terrainAltitudeSnapshot(service, position, raised)
    expect(after.surfaceClearanceFt).toBeCloseTo(20, 5)
  })

  it('leaves commanded AGL alone when clearance is already sufficient', () => {
    const service = serviceWithStructure()
    expect(ensureSurfaceClearanceAglFt(service, { lat: 1, lng: 1 }, 100, 20)).toBe(100)
  })
})
