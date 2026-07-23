import { pointInPolygon } from '@/utils/geometry'
import type { DroneState, Geofence, ScenarioConfig, WeatherVariantState } from '@/types'
import type { TerrainOcclusionService } from '@/sim/terrain/OcclusionService'
import {
  terrainAltitudeSnapshot,
  type TerrainCoverage,
} from '@/sim/terrain/altitude'
import { clutterForLocationTag, reportedSignalDbm, resolveLink } from '@/sim/safety/commsModel'

const FT_TO_M = 0.3048
/** Ground control station antenna height above local ground, m. */
const GCS_MAST_HEIGHT_M = 2

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

/** Authored RF interference during a comms-loss window, dB (see `applyCommsModel`). */
const BLACKOUT_INTERFERENCE_DB = 22

/** Maximum weather-driven attenuation, dB, at zero comms reliability. */
const MAX_WEATHER_INTERFERENCE_DB = 15

/** A drone must be airborne and holding its own usable link before it can relay for another. */
const RELAY_ELIGIBLE_STATES = new Set<DroneState['missionState']>([
  'navigate', 'sar_grid', 'hover', 'thermal_hold', 'inspect', 'avoid', 'return_to_base',
])
const RELAY_MIN_ALT_FT = 20

/**
 * RF link budget (REALISM_ROADMAP WP-8 / §18.4).
 *
 * Replaces the previous model, which was a timer: authored blackout windows plus a weather factor
 * ramping signal up and down regardless of where the aircraft was. Signal is now computed from
 * range, altitude, scenario clutter class, true terrain/building LOS (WP-4) and relay placement.
 *
 * The authored inputs are retained but demoted from overrides to **impairments in dB**, added to
 * the path loss like any other attenuation:
 *  - a comms-loss window is real authored RF interference (the wildfire scenario's smoke/RF event
 *    at T+80s is a scripted *event*, and remains one) — but it can no longer force a link down on
 *    its own, and an aircraft parked next to the operator will ride it out;
 *  - weather reliability becomes attenuation rather than a ceiling on recovery.
 *
 * What changes for the operator: comms loss becomes a consequence of where they put the aircraft,
 * and repositioning a relay measurably restores margin downstream.
 */
export function applyCommsModel(
  drones: DroneState[],
  elapsedSec: number,
  scenario: ScenarioConfig,
  weather?: WeatherVariantState,
  occlusion?: TerrainOcclusionService,
): DroneState[] {
  const inBlackout = scenario.commsLossWindows.some(
    (w) => elapsedSec >= w.startSec && elapsedSec < w.startSec + w.durationSec,
  )
  const weatherDb = weather
    ? Math.max(0, 1 - weather.commsReliabilityFactor) * MAX_WEATHER_INTERFERENCE_DB
    : 0
  const interferenceDb = (inBlackout ? BLACKOUT_INTERFERENCE_DB : 0) + weatherDb

  const clutter = scenario.rfClutter ?? clutterForLocationTag(scenario.weatherProfile?.locationTag)

  // The ground control station sits at the scenario start position, on a short mast.
  const gcsGroundM = occlusion?.groundElevation(scenario.startPosition.lat, scenario.startPosition.lng) ?? 0
  const groundStation = {
    position: scenario.startPosition,
    altMslM: gcsGroundM + GCS_MAST_HEIGHT_M,
  }

  const altMslFor = (drone: DroneState) =>
    (occlusion?.groundElevation(drone.position.lat, drone.position.lng) ?? 0) + drone.altitudeFt * FT_TO_M

  // Any other airborne aircraft can carry a hop. These fleets fly meshed C2, and restricting
  // relaying to an aircraft flagged 'relay' would make the capability depend on scenario
  // authoring rather than on where the operator actually put the aircraft.
  const relayPool = drones
    .filter((d) => RELAY_ELIGIBLE_STATES.has(d.missionState) && d.altitudeFt >= RELAY_MIN_ALT_FT)
    .map((d) => ({ id: d.id, position: d.position, altMslM: altMslFor(d) }))

  return drones.map((drone) => {
    if (['landed', 'idle'].includes(drone.missionState)) return drone

    const link = resolveLink(
      {
        from: groundStation,
        to: { position: drone.position, altMslM: altMslFor(drone) },
        clutter,
        seed: scenario.seed,
        linkId: drone.id,
        occlusion,
        interferenceDb,
      },
      relayPool.filter((candidate) => candidate.id !== drone.id),
    )

    const signalDbm = reportedSignalDbm(link.rssiDbm)
    return {
      ...drone,
      signalDbm,
      bvlosFlag: signalDbm < -90,
      linkMarginDb: link.marginDb,
      linkPacketLossPct: link.packetLossPct,
      linkLatencyMs: link.controlLatencyMs,
      linkViaRelayId: link.viaRelayId,
      linkLos: link.los,
    }
  })
}
