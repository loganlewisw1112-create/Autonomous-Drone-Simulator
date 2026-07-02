import { haversineDistanceM } from '@/utils/geometry'
import type { DroneState, RecoveryTeamState, LatLng, WeatherVariantState, MissionState } from '@/types'

const RECOVERY_SPEED_MPS = 5.0  // recovery vehicle speed

/** Recovery-triggering states and conditions. */
const RECOVERY_TRIGGER_STATES = new Set<MissionState>([
  'stranded',
  'remote_landed',
  'unrecoverable_sim',
])

/**
 * Grace period before an 'emergency' drone is handed off to a recovery team.
 * Gives MissionManager's controlled descent (emergency -> landed once altitudeFt < 2)
 * a real chance to finish instead of being hijacked the instant battery goes critical.
 */
export const EMERGENCY_TIMEOUT_SEC = 45

/** Check whether a drone requires a recovery team and hasn't already been dispatched. */
export function needsRecovery(
  drone: DroneState,
  existingTeamDroneIds: Set<string>,
  elapsedSec: number,
): boolean {
  if (existingTeamDroneIds.has(drone.id)) return false
  if (RECOVERY_TRIGGER_STATES.has(drone.missionState)) return true
  if (drone.missionState === 'recovery_requested') return true
  if (
    drone.missionState === 'emergency' &&
    elapsedSec - (drone.emergencyStartSec ?? elapsedSec) >= EMERGENCY_TIMEOUT_SEC
  ) return true
  // NOTE: comms-loss alone does NOT trigger recovery. Drones stay airborne (loiter/hover)
  // and reconnect when signal returns; lastKnownPosition is snapshotted for the operator.
  // Recovery only fires when comms-loss is compounded by another failure (critical battery
  // → emergency, then the emergency-timeout branch above).
  return false
}

/** Determine the next drone state when a recovery is triggered. */
export function recoveryTransitionState(drone: DroneState): MissionState {
  if (drone.missionState === 'remote_landed') return 'recovery_requested'
  if (drone.missionState === 'emergency' && drone.batteryPct < 5) return 'stranded'
  return 'recovery_requested'
}

/** Build a RecoveryTeamState dispatched from a staging position to the drone's last position. */
export function createRecoveryTeam(
  id: string,
  droneId: string,
  stagingPos: LatLng,
  targetPos: LatLng,
  weather: WeatherVariantState,
): RecoveryTeamState {
  const dist = haversineDistanceM(stagingPos, targetPos)
  const speed = RECOVERY_SPEED_MPS / weather.groundUnitEtaMultiplier
  const etaSec = Math.round(dist / speed)

  const risks: string[] = []
  if (weather.activeHazards.includes('snow_ice')) risks.push('icy access — 4WD required')
  if (weather.activeHazards.includes('smoke'))    risks.push('smoke — PPE and IR required')
  if (weather.activeHazards.includes('rain'))     risks.push('wet terrain — extended ETA')
  if (weather.activeHazards.includes('fog'))      risks.push('low visibility — use GPS coordinates')

  const accessNotes: string[] = ['Approach on foot for final 50m to avoid prop-wash damage.']

  return {
    id,
    droneId,
    position: { ...stagingPos },
    targetPosition: { ...targetPos },
    status: 'enroute',
    etaSec,
    routePoints: [stagingPos, targetPos],
    weatherRiskNote: risks.length > 0 ? risks.join('; ') : undefined,
    accessNote: accessNotes.join(' '),
  }
}

/** Advance a recovery team one physics tick toward the target drone. */
export function tickRecoveryTeam(
  team: RecoveryTeamState,
  weather: WeatherVariantState,
  dt: number,
): RecoveryTeamState {
  if (team.status !== 'enroute') return team

  const speed = RECOVERY_SPEED_MPS / weather.groundUnitEtaMultiplier
  const dist = haversineDistanceM(team.position, team.targetPosition)

  if (dist < 15) {
    return { ...team, status: 'on_scene', etaSec: 0 }
  }

  const stepM = speed * dt
  const frac = Math.min(1, stepM / dist)
  const newPos: LatLng = {
    lat: team.position.lat + (team.targetPosition.lat - team.position.lat) * frac,
    lng: team.position.lng + (team.targetPosition.lng - team.position.lng) * frac,
  }
  const remaining = Math.max(0, dist - stepM)
  return { ...team, position: newPos, etaSec: Math.round(remaining / speed) }
}

/** Simulate a recovery team completing extraction after being on scene for a few ticks. */
export function tickRecoveryExtraction(
  team: RecoveryTeamState,
  onSceneTicks: number,
): RecoveryTeamState {
  if (team.status !== 'on_scene') return team
  if (onSceneTicks >= 100) {
    return { ...team, status: 'extracted', outcome: 'recovered' }
  }
  return team
}
