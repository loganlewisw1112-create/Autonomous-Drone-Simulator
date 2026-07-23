import { describe, expect, it } from 'vitest'
import { createDroneState } from '@/sim/drone/DroneEntity'
import { applySurfaceClearanceSafety, assessSurfaceClearance } from '@/sim/safety/SafetyManager'
import { createTerrainOcclusionService } from '@/sim/terrain/OcclusionService'
import type { TerrainRaster } from '@/sim/terrain/terrainRaster'

const RASTER: TerrainRaster = {
  width: 2,
  height: 2,
  bounds: { west: 0, south: 0, east: 2, north: 2 },
  metersPerPixel: 10,
  surface: 'bare-earth',
  minElevationM: 100,
  maxElevationM: 100,
  elevations: new Float32Array([100, 100, 100, 100]),
}

function drone(id: string, lat: number, lng: number, altitudeFt: number) {
  return {
    ...createDroneState(id, id, '#fff', { lat, lng }, altitudeFt),
    missionState: 'navigate' as const,
  }
}

describe('surface clearance assessment', () => {
  it('reports covered ground and structure hazards from canonical AGL', () => {
    const service = createTerrainOcclusionService(RASTER, {
      structures: {
        maxTopM: 106.096,
        topAt: (_lat, lng) => lng > 1 ? 106.096 : null,
      },
    })
    const result = assessSurfaceClearance([
      drone('ground-low', 1, 0.5, 10),
      drone('roof-low', 1, 1.5, 30),
      drone('roof-safe', 1, 1.5, 50),
    ], service)

    expect(result.coverage).toEqual([
      { droneId: 'ground-low', coverage: 'available' },
      { droneId: 'roof-low', coverage: 'available' },
      { droneId: 'roof-safe', coverage: 'available' },
    ])
    expect(result.hazards.map(({ droneId, kind }) => ({ droneId, kind }))).toEqual([
      { droneId: 'ground-low', kind: 'ground' },
      { droneId: 'roof-low', kind: 'structure' },
    ])
    expect(result.hazards[0].clearanceFt).toBeCloseTo(10, 8)
    expect(result.hazards[1].aglFt).toBe(30)
    expect(result.hazards[1].clearanceFt).toBeCloseTo(10, 8)
  })

  it('reports unavailable and outside coverage without guessing hazards', () => {
    const service = createTerrainOcclusionService(RASTER)
    const outside = drone('outside', 3, 1, 5)
    const unavailable = assessSurfaceClearance([outside], undefined)
    const outOfArea = assessSurfaceClearance([outside], service)

    expect(unavailable).toEqual({
      coverage: [{ droneId: 'outside', coverage: 'unavailable' }],
      hazards: [],
    })
    expect(outOfArea).toEqual({
      coverage: [{ droneId: 'outside', coverage: 'outside' }],
      hazards: [],
    })
  })

  it('enforces sourced clearance in active flight but permits launch and uncovered flight', () => {
    const service = createTerrainOcclusionService(RASTER)
    const active = drone('active-low', 1, 1, 10)
    const launching = { ...drone('launch-low', 1, 1, 5), missionState: 'launch' as const }
    const outside = drone('outside', 3, 1, 5)
    const result = applySurfaceClearanceSafety([active, launching, outside], service)

    expect(result.drones.map(({ id, missionState }) => ({ id, missionState }))).toEqual([
      { id: 'active-low', missionState: 'emergency' },
      { id: 'launch-low', missionState: 'launch' },
      { id: 'outside', missionState: 'navigate' },
    ])
  })
})
