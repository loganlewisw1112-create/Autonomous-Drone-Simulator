import { bearingDeg, haversineDistanceM, offsetLatLng } from '@/utils/geometry'
import type { DroneState } from '@/types'
import type { TerrainOcclusionService } from '@/sim/terrain/OcclusionService'
import { containsLatLng } from '@/sim/terrain/terrainRaster'

// Conservative TRAINING doctrine, not a regulatory separation minimum. Operational values
// must come from the approved mission risk assessment, aircraft performance, containment,
// navigation uncertainty, terrain, and airspace plan.
export const H_SEP_M = 30
export const V_SEP_FT = 25
export const LOOKAHEAD_S = 8
const METERS_PER_FOOT = 0.3048

// Assigned altitude cruise bands per drone index
export const ALTITUDE_BANDS = [
  { cruise: 100, label: 'BAND-A' },
  { cruise: 130, label: 'BAND-B' },
  { cruise: 160, label: 'BAND-C' },
  { cruise: 190, label: 'BAND-D' },
  { cruise: 220, label: 'BAND-E' },
  { cruise: 250, label: 'BAND-F' },
  { cruise: 280, label: 'BAND-G' },
  { cruise: 310, label: 'BAND-H' },
]

export function getAssignedAltitude(droneId: string, allDrones: DroneState[]): number {
  const idx = allDrones.findIndex((d) => d.id === droneId)
  return ALTITUDE_BANDS[Math.max(0, Math.min(idx, ALTITUDE_BANDS.length - 1))].cruise
}

export interface ConflictPair {
  idA: string
  idB: string
  horizDistM: number
  vertDistFt: number
}

/** Return the time of closest horizontal approach over the look-ahead window.
 * The prior endpoint-only projection could miss two aircraft that crossed before
 * the end of the window. A local tangent plane is sufficiently accurate over the
 * simulator's short (<= 8 s) prediction horizon. */
function closestApproachSec(a: DroneState, b: DroneState): number {
  const separationM = haversineDistanceM(a.position, b.position)
  const separationBearingRad = bearingDeg(a.position, b.position) * Math.PI / 180
  const relativePosition = {
    x: Math.sin(separationBearingRad) * separationM,
    y: Math.cos(separationBearingRad) * separationM,
  }
  const velocity = (drone: DroneState) => {
    const headingRad = drone.headingDeg * Math.PI / 180
    return {
      x: Math.sin(headingRad) * drone.speedMs,
      y: Math.cos(headingRad) * drone.speedMs,
    }
  }
  const velocityA = velocity(a)
  const velocityB = velocity(b)
  const relativeVelocity = {
    x: velocityB.x - velocityA.x,
    y: velocityB.y - velocityA.y,
  }
  const speedSquared = relativeVelocity.x ** 2 + relativeVelocity.y ** 2
  if (speedSquared < 1e-9) return 0
  const unconstrained = -(
    relativePosition.x * relativeVelocity.x
    + relativePosition.y * relativeVelocity.y
  ) / speedSquared
  return Math.max(0, Math.min(LOOKAHEAD_S, unconstrained))
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

      // Predict the closest point within the whole horizon, not only its endpoint.
      const predictionSec = closestApproachSec(a, b)
      const predA = offsetLatLng(a.position, a.headingDeg, a.speedMs * predictionSec)
      const predB = offsetLatLng(b.position, b.headingDeg, b.speedMs * predictionSec)

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
