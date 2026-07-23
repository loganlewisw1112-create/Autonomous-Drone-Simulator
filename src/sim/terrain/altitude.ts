import type { LatLng } from '@/types'
import type { TerrainOcclusionService } from './OcclusionService'
import { containsLatLng } from './terrainRaster'

const METERS_PER_FOOT = 0.3048

export type TerrainCoverage = 'available' | 'outside' | 'unavailable'

export interface TerrainAltitudeSnapshot {
  coverage: TerrainCoverage
  groundMslM: number | null
  aircraftMslM: number | null
  structureHeightM: number | null
  surfaceClearanceFt: number | null
}

function coverageAt(
  service: TerrainOcclusionService | undefined,
  position: LatLng,
): TerrainCoverage {
  if (!service) return 'unavailable'
  return containsLatLng(service.raster, position.lat, position.lng) ? 'available' : 'outside'
}

/**
 * Convert the simulator's canonical AGL altitude to MSL only where sourced terrain exists.
 * Outside fixture coverage, returning null prevents the raster sampler's edge clamp from being
 * mistaken for real elevation data.
 */
export function aglFtToMslM(
  service: TerrainOcclusionService | undefined,
  position: LatLng,
  aglFt: number,
): number | null {
  if (coverageAt(service, position) !== 'available' || !service) return null
  return service.groundElevation(position.lat, position.lng) + aglFt * METERS_PER_FOOT
}

/**
 * Describe an AGL flight altitude in the terrain frame without changing altitude semantics.
 * Aircraft MSL is derived from bare ground; structures affect clearance, not the canonical AGL.
 */
export function terrainAltitudeSnapshot(
  service: TerrainOcclusionService | undefined,
  position: LatLng,
  aglFt: number,
): TerrainAltitudeSnapshot {
  const coverage = coverageAt(service, position)
  if (coverage !== 'available' || !service) {
    return {
      coverage,
      groundMslM: null,
      aircraftMslM: null,
      structureHeightM: null,
      surfaceClearanceFt: null,
    }
  }

  const groundMslM = service.groundElevation(position.lat, position.lng)
  const surfaceMslM = service.surfaceHeight(position.lat, position.lng)
  const aircraftMslM = groundMslM + aglFt * METERS_PER_FOOT

  return {
    coverage,
    groundMslM,
    aircraftMslM,
    structureHeightM: Math.max(0, surfaceMslM - groundMslM),
    surfaceClearanceFt: (aircraftMslM - surfaceMslM) / METERS_PER_FOOT,
  }
}
