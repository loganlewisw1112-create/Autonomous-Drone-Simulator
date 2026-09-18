/**
 * Fleet model → scene poses. Pulled once per rendered frame (no subscription state to go stale).
 *
 * Height reference is the ground MapLibre actually DRAWS (`queryTerrainElevation`), not the sim DEM:
 * the map renders relief for only part of the DEM and none below zoom 14, and an aircraft must sit
 * its true AGL above whatever ground is on screen, or it visibly floats or sinks.
 */
import type * as maplibregl from 'maplibre-gl'
import { useDroneStore } from '@/store/droneStore'
import type { DroneState, MissionState } from '@/types'
import type { AirframeId } from './airframes/parts'
import type { FleetFrame, SceneDrone } from './fleet'

const FT_TO_M = 0.3048
const HOVER_RPM = 5200

const AIRFRAME_BY_PLATFORM: Record<string, AirframeId> = { teal_2: 'teal2', skydio_x10: 'x10' }

/** Gimbal pitch by mission state (degrees; negative looks down). The fleet model carries no
 *  gimbal telemetry, so pose follows what the aircraft is doing. */
const GIMBAL_PITCH: Partial<Record<MissionState, number>> = {
  thermal_hold: -75, sar_grid: -60, inspect: -40, hover: -30, return_to_base: -10,
  idle: 0, preflight: 0, landed: 0, remote_landed: 0, recharge: 0,
}
const DEFAULT_GIMBAL_PITCH = -25
const LANDING_BELOW_M = 8

/** The fleet model has no LANDING state; it is the last metres of a return or an emergency descent. */
function isLanding(drone: DroneState, aglM: number): boolean {
  return aglM < LANDING_BELOW_M && (drone.missionState === 'return_to_base' || drone.missionState === 'emergency')
}

export function poseOf(drone: DroneState, groundM: number): SceneDrone {
  const aglM = drone.altitudeFt * FT_TO_M
  const airborne = aglM > 0.5
  const landing = airborne && isLanding(drone, aglM)
  return {
    id: drone.id,
    airframe: AIRFRAME_BY_PLATFORM[drone.platformId ?? ''] ?? 'teal2',
    lng: drone.position.lng,
    lat: drone.position.lat,
    elevationM: groundM + aglM,
    headingDeg: drone.headingDeg,
    speedMs: airborne ? drone.speedMs : 0,
    propRpm: !airborne ? 0 : landing ? HOVER_RPM * 0.75 : HOVER_RPM + drone.speedMs * 60,
    gimbalYawDeg: 0,
    gimbalPitchDeg: landing ? 0 : GIMBAL_PITCH[drone.missionState] ?? DEFAULT_GIMBAL_PITCH, // stowed for touchdown
    color: drone.color,
  }
}

export function storeFleetSource(map: maplibregl.Map): () => FleetFrame {
  return () => {
    const { drones, elapsedSec } = useDroneStore.getState()
    return {
      simTimeSec: elapsedSec,
      drones: drones.map((d) => poseOf(d, map.queryTerrainElevation([d.position.lng, d.position.lat]) ?? 0)),
    }
  }
}
