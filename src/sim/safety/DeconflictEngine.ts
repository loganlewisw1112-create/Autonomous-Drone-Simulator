import { haversineDistanceM, offsetLatLng } from '@/utils/geometry'
import type { DroneState } from '@/types'
import type { TerrainOcclusionService } from '@/sim/terrain/OcclusionService'
import { containsLatLng } from '@/sim/terrain/terrainRaster'

// Separation minima (ICAO-inspired, scaled for low-altitude UAV ops)
export const H_SEP_M = 30      // 30m horizontal minimum separation
export const V_SEP_FT = 15     // 15ft vertical minimum separation
const LOOKAHEAD_S = 2          // 2s prediction horizon for conflict detection
const METERS_PER_FOOT = 0.3048

// Assigned altitude cruise bands per drone index
export const ALTITUDE_BANDS = [
  { cruise: 100, label: 'BAND-A' },
  { cruise: 120, label: 'BAND-B' },
  { cruise: 140, label: 'BAND-C' },
  { cruise: 160, label: 'BAND-D' },
  { cruise: 180, label: 'BAND-E' },
]

export function getAssignedAltitude(droneId: string, allDrones: DroneState[]): number {
  const idx = allDrones.findIndex((d) => d.id === droneId)
  return ALTITUDE_BANDS[Math.min(idx, ALTITUDE_BANDS.length - 1)].cruise
}

export interface ConflictPair {
  idA: string
  idB: string
  horizDistM: number
  vertDistFt: number
}

/** Compute pairwise predicted conflicts among active drones. */
export function detectConflicts(
  drones: DroneState[],
  terrain?: TerrainOcclusionService,
): ConflictPair[] {
  const active = drones.filter(
    (d) => !['landed', 'idle', 'preflight'].includes(d.missionState),
  )
  const conflicts: ConflictPair[] = []

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]
      const b = active[j]

      // Predict future positions
      const predA = offsetLatLng(a.position, a.headingDeg, a.speedMs * LOOKAHEAD_S)
      const predB = offsetLatLng(b.position, b.headingDeg, b.speedMs * LOOKAHEAD_S)

      const horizDist = haversineDistanceM(predA, predB)
      // AGL remains the simulator's canonical altitude. Convert both aircraft to the physical
      // MSL frame only when both predicted positions have sourced terrain coverage. If either
      // prediction is outside, compare the two authored AGL values; mixing one MSL value with
      // one AGL value would manufacture a separation that does not exist.
      const bothCovered = terrain !== undefined
        && containsLatLng(terrain.raster, predA.lat, predA.lng)
        && containsLatLng(terrain.raster, predB.lat, predB.lng)
      const vertDist = bothCovered
        ? Math.abs(
            terrain.groundElevation(predA.lat, predA.lng) + a.altitudeFt * METERS_PER_FOOT
            - terrain.groundElevation(predB.lat, predB.lng) - b.altitudeFt * METERS_PER_FOOT,
          ) / METERS_PER_FOOT
        : Math.abs(a.altitudeFt - b.altitudeFt)

      if (horizDist < H_SEP_M && vertDist < V_SEP_FT) {
        conflicts.push({ idA: a.id, idB: b.id, horizDistM: horizDist, vertDistFt: vertDist })
      }
    }
  }

  return conflicts
}

/** Stamp conflictFlag on drones involved in detected conflicts. */
export function applyConflictFlags(
  drones: DroneState[],
  conflicts: ConflictPair[],
): DroneState[] {
  const conflictIds = new Set<string>()
  conflicts.forEach((c) => {
    conflictIds.add(c.idA)
    conflictIds.add(c.idB)
  })
  return drones.map((d) => ({ ...d, conflictFlag: conflictIds.has(d.id) }))
}
