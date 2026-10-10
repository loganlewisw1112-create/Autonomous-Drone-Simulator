import { haversineDistanceM } from '@/utils/geometry'
import type { DroneState, RecoveryTeamState, LatLng, WeatherVariantState, MissionState } from '@/types'
import { headingAtDistance, pointAtDistance, remainingNominalSec, speedAt } from '@/sim/mission/roadRouter'
import type { RoadRoute } from '@/sim/mission/roadRouter'

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
  requiredTicks = 100,
): RecoveryTeamState {
  if (team.status !== 'on_scene') return team
  if (onSceneTicks >= requiredTicks) {
    return { ...team, status: 'extracted', outcome: 'recovered' }
  }
  return team
}

// ── Road-routed recovery teams (c12b) ───────────────────────────────────────────
// createRecoveryTeam / tickRecoveryTeam above stay as the retained straight-line model. Teams in
// the live loop are either road-routed (drive the route, park at the access point, walk in) or
// unrouted (no usable road access: no vehicle is drawn and the position stays at the staging point).

/** Walking pace from the parked vehicle to the aircraft, m/s, before the weather divide. */
const WALK_SPEED_MPS = 1.3
const SIM_HZ = 20

/** On-scene steps the walk-in takes: ceil(gap / (1.3 / multiplier) * 20). */
export function recoveryWalkTicks(accessGapM: number, weather: WeatherVariantState): number {
  return Math.ceil((accessGapM / (WALK_SPEED_MPS / weather.groundUnitEtaMultiplier)) * SIM_HZ)
}

function recoveryRiskNotes(weather: WeatherVariantState): string | undefined {
  const risks: string[] = []
  if (weather.activeHazards.includes('snow_ice')) risks.push('icy access — 4WD required')
  if (weather.activeHazards.includes('smoke'))    risks.push('smoke — PPE and IR required')
  if (weather.activeHazards.includes('rain'))     risks.push('wet terrain — extended ETA')
  if (weather.activeHazards.includes('fog'))      risks.push('low visibility — use GPS coordinates')
  return risks.length > 0 ? risks.join('; ') : undefined
}

/**
 * A team that drives `route` (staging node to road access point). The caller sets `routeFromNode`.
 * `accessGapM` is this aircraft's own walk-in gap (the dispatch plan's); routes are cached per snap
 * point and shared between targets, so it defaults to the access point to `targetPos` distance, never
 * to `route.accessGapM`.
 */
export function createRoutedRecoveryTeam(
  id: string,
  droneId: string,
  route: RoadRoute,
  targetPos: LatLng,
  weather: WeatherVariantState,
  accessGapM?: number,
): RecoveryTeamState {
  const start = route.points[0]
  const access = route.points[route.points.length - 1]
  const gap = accessGapM ?? Math.round(haversineDistanceM(access, targetPos) * 10) / 10
  const walk = gap > 15
    ? `Park at the road access point, ${Math.round(gap)} m from the aircraft, and walk in to avoid prop-wash damage.`
    : 'Approach on foot for final 50m to avoid prop-wash damage.'
  return {
    id,
    droneId,
    position: { lat: start.lat, lng: start.lng },
    targetPosition: { ...targetPos },
    status: 'enroute',
    etaSec: Math.round(route.nominalTotalSec * weather.groundUnitEtaMultiplier),
    routePoints: [{ lat: start.lat, lng: start.lng }, { lat: access.lat, lng: access.lng }],
    weatherRiskNote: recoveryRiskNotes(weather),
    accessNote: walk,
    routeDistM: 0,
    accessGapM: gap,
    headingDeg: route.lengthM > 0 ? Math.round(headingAtDistance(route, 0) * 10) / 10 : 0,
    roadRouted: true,
  }
}

/** Advance a routed team along its road route; `on_scene` means parked at the access point. */
export function tickRoutedRecoveryTeam(
  team: RecoveryTeamState,
  route: RoadRoute,
  weather: WeatherVariantState,
  dt: number,
): RecoveryTeamState {
  if (team.status !== 'enroute' || route.status !== 'ok') return team
  const from = team.routeDistM ?? 0
  const next = Math.min(route.lengthM, from + (speedAt(route, from) / weather.groundUnitEtaMultiplier) * dt)
  const p = pointAtDistance(route, next)
  const heading = route.lengthM > 0 ? Math.round(headingAtDistance(route, next) * 10) / 10 : (team.headingDeg ?? 0)
  const moved = { ...team, position: { lat: p.lat, lng: p.lng }, routeDistM: next, headingDeg: heading }
  if (next >= route.lengthM) return { ...moved, status: 'on_scene', etaSec: 0 }
  return { ...moved, etaSec: Math.round(remainingNominalSec(route, next) * weather.groundUnitEtaMultiplier) }
}

/** A team with no usable road access: frozen at `stagingPos`, no vehicle, legacy completion timing. */
export function createUnroutedRecoveryTeam(
  id: string,
  droneId: string,
  stagingPos: LatLng,
  targetPos: LatLng,
  weather: WeatherVariantState,
  accessGapM: number | null,
): RecoveryTeamState {
  const total = Math.max(0, haversineDistanceM(stagingPos, targetPos) - 15)
  const speed = RECOVERY_SPEED_MPS / weather.groundUnitEtaMultiplier
  const note = accessGapM === null
    ? 'Recovery team en route (no road data)'
    : `Recovery team en route (nearest road ${Math.round(accessGapM)} m)`
  return {
    id,
    droneId,
    position: { ...stagingPos },
    targetPosition: { ...targetPos },
    status: 'enroute',
    etaSec: Math.round(total / speed),
    routePoints: [{ ...stagingPos }, { ...stagingPos }],
    weatherRiskNote: recoveryRiskNotes(weather),
    accessNote: note,
    routeDistM: 0,
    ...(accessGapM !== null ? { accessGapM } : {}),
    roadRouted: false,
  }
}

/**
 * Legacy-timing completion for an unrouted team: `routeDistM` advances as virtual straight-line
 * progress at 5 / multiplier * dt toward max(0, haversine(staging, drone) - 15); the position never
 * moves. Arrival is checked before the step, exactly like tickRecoveryTeam.
 */
export function tickUnroutedRecoveryTeam(team: RecoveryTeamState, weather: WeatherVariantState, dt: number): RecoveryTeamState {
  if (team.status !== 'enroute') return team
  const speed = RECOVERY_SPEED_MPS / weather.groundUnitEtaMultiplier
  const total = Math.max(0, haversineDistanceM(team.position, team.targetPosition) - 15)
  const done = team.routeDistM ?? 0
  if (done >= total) return { ...team, status: 'on_scene', etaSec: 0 }
  const next = done + speed * dt
  return { ...team, routeDistM: next, etaSec: Math.round(Math.max(0, total - next) / speed) }
}
