import { pointInPolygon } from '@/utils/geometry'
import type { DroneState, Geofence, ScenarioConfig, WeatherVariantState } from '@/types'
import type { TerrainOcclusionService } from '@/sim/terrain/OcclusionService'
import {
  terrainAltitudeSnapshot,
  type TerrainCoverage,
} from '@/sim/terrain/altitude'

export interface SurfaceClearanceCoverage {
  droneId: string
  coverage: TerrainCoverage
}

export interface SurfaceClearanceHazard {
  droneId: string
  kind: 'ground' | 'structure'
  coverage: 'available'
  aglFt: number
  clearanceFt: number
  minimumClearanceFt: number
  groundMslM: number
  aircraftMslM: number
  structureHeightM: number
}

export interface SurfaceClearanceAssessment {
  coverage: SurfaceClearanceCoverage[]
  hazards: SurfaceClearanceHazard[]
}

const CLEARANCE_ENFORCED_STATES = new Set<DroneState['missionState']>([
  'navigate', 'sar_grid', 'hover', 'inspect', 'thermal_hold', 'route_complete_loiter',
  'avoid', 'return_to_base',
])

export interface SurfaceClearanceSafetyResult extends SurfaceClearanceAssessment {
  drones: DroneState[]
}

/** Apply the sourced-surface floor to active flight without disrupting launch/landing phases. */
export function applySurfaceClearanceSafety(
  drones: DroneState[],
  service?: TerrainOcclusionService,
  minClearanceFt = 20,
): SurfaceClearanceSafetyResult {
  const assessment = assessSurfaceClearance(drones, service, minClearanceFt)
  const hazardousIds = new Set(assessment.hazards.map((hazard) => hazard.droneId))
  return {
    ...assessment,
    drones: drones.map((drone) =>
      hazardousIds.has(drone.id) && CLEARANCE_ENFORCED_STATES.has(drone.missionState)
        ? { ...drone, missionState: 'emergency' as const }
        : drone),
  }
}

/**
 * Assess physical clearance without changing authored altitude semantics.
 *
 * The drone altitude remains AGL. MSL and roof clearance are derived only inside the committed
 * terrain fixture; outside/unavailable coverage is reported explicitly and never edge-clamped
 * into a guessed hazard.
 */
export function assessSurfaceClearance(
  drones: DroneState[],
  service?: TerrainOcclusionService,
  minClearanceFt = 20,
): SurfaceClearanceAssessment {
  const coverage: SurfaceClearanceCoverage[] = []
  const hazards: SurfaceClearanceHazard[] = []

  for (const drone of drones) {
    const snapshot = terrainAltitudeSnapshot(service, drone.position, drone.altitudeFt)
    coverage.push({ droneId: drone.id, coverage: snapshot.coverage })
    if (
      snapshot.coverage !== 'available'
      || snapshot.groundMslM === null
      || snapshot.aircraftMslM === null
      || snapshot.structureHeightM === null
      || snapshot.surfaceClearanceFt === null
      || snapshot.surfaceClearanceFt >= minClearanceFt
    ) continue

    hazards.push({
      droneId: drone.id,
      kind: snapshot.structureHeightM > 0 ? 'structure' : 'ground',
      coverage: 'available',
      aglFt: drone.altitudeFt,
      clearanceFt: snapshot.surfaceClearanceFt,
      minimumClearanceFt: minClearanceFt,
      groundMslM: snapshot.groundMslM,
      aircraftMslM: snapshot.aircraftMslM,
      structureHeightM: snapshot.structureHeightM,
    })
  }

  return { coverage, hazards }
}

/** Check geofence breach for each drone and stamp geofenceBreachFlag. */
export function applyGeofenceFlags(
  drones: DroneState[],
  geofences: Geofence[],
): DroneState[] {
  return drones.map((drone) => {
    const breach = geofences.find((gf) => {
      if (gf.bypassForMission) return false
      if (!pointInPolygon(drone.position, gf.polygon)) return false
      if (gf.type === 'restricted') return drone.altitudeFt <= gf.maxAltitudeFt
      return true
    })

    return {
      ...drone,
      geofenceBreachFlag: breach !== undefined,
      geofenceBreach: breach
        ? {
            id: breach.id,
            label: breach.label,
            type: breach.type,
            maxAltitudeFt: breach.maxAltitudeFt,
          }
        : undefined,
    }
  })
}

/** Simulate RF signal degradation during comms-loss windows with optional weather penalty. */
export function applyCommsModel(
  drones: DroneState[],
  elapsedSec: number,
  scenario: ScenarioConfig,
  weather?: WeatherVariantState,
): DroneState[] {
  const inBlackout = scenario.commsLossWindows.some(
    (w) => elapsedSec >= w.startSec && elapsedSec < w.startSec + w.durationSec,
  )

  return drones.map((drone) => {
    if (['landed', 'idle'].includes(drone.missionState)) return drone

    // Urban environments have dense RF infrastructure; use a higher ceiling if provided.
    // Weather lowers the recovery ceiling once instead of compounding signal loss every tick.
    const signalCeiling = weather?.commsSignalCeilingDbm ?? -55
    const weatherPenaltyDbm = weather ? Math.max(0, 1 - weather.commsReliabilityFactor) * 15 : 0
    const recoveryCeiling = signalCeiling - weatherPenaltyDbm
    let signalDbm = drone.signalDbm
    if (inBlackout) {
      signalDbm = Math.max(-98, signalDbm - 3)
    } else {
      signalDbm = Math.min(recoveryCeiling, signalDbm + 0.5)
    }

    return {
      ...drone,
      signalDbm,
      bvlosFlag: signalDbm < -90,
    }
  })
}
