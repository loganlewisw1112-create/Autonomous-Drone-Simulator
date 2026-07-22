import { platformForDrone } from '@/sim/drone/platformCatalog'
import {
  batteryReservePctForDrone,
  effectiveBatteryDrainRateForDrone,
  rechargeStationsForDrone,
} from '@/sim/mission/rechargeStations'
import { firstBreachedGeofence } from '@/sim/mission/routeAudit'
import { isMobileLaunchSite, resolveLaunchSite, type SiteOverrides } from '@/sim/mission/siteResolver'
import { bearingDeg, haversineDistanceM, offsetLatLng } from '@/utils/geometry'
import type {
  DroneState,
  LatLng,
  LaunchRecoverySite,
  MissionState,
  ScenarioConfig,
  WeatherVariantState,
} from '@/types'

export { isMobileLaunchSite, resolveLaunchSite, type SiteOverrides } from '@/sim/mission/siteResolver'

export interface SiteRepositionInput {
  scenario: ScenarioConfig
  siteId: string
  requestedPosition: LatLng
  overrides?: SiteOverrides
  drones?: Array<Pick<DroneState, 'id' | 'position' | 'batteryPct' | 'missionState'>>
  launchAssignments?: Record<string, string>
  recoveryAssignments?: Record<string, string>
  objectivePosition?: LatLng
  weather?: Pick<WeatherVariantState, 'batteryDrainMultiplier' | 'speedCapMultiplier'>
}

export interface SiteRepositionResult {
  ok: boolean
  siteId: string
  from: LatLng
  requestedPosition: LatLng
  position: LatLng
  clamped: boolean
  distanceFromOriginM: number
  distanceToObjectiveDeltaM: number
  reserveDeltaPct: number
  affectedDrones: string[]
  affectedSiteIds: string[]
  overridePatch: SiteOverrides
  repositionTimeSec: number
  blockers: string[]
  reason?: string
  message: string
}

export interface ClampedSitePosition {
  position: LatLng
  clamped: boolean
  distanceFromOriginM: number
}

const DEFAULT_REPOSITION_TIME_SEC = 120
const RECOVERY_MATCH_TOLERANCE_M = 1
const GROUNDED_STATES = new Set<MissionState>([
  'idle',
  'preflight',
  'landed',
  'recharge',
  'remote_landed',
  'stranded',
  'recovered',
  'unrecoverable_sim',
])

/** Clamp against the authored position so repeated moves cannot ratchet beyond scenario doctrine. */
export function clampSiteReposition(
  authoredSite: LaunchRecoverySite,
  requestedPosition: LatLng,
): ClampedSitePosition {
  const requestedDistanceM = haversineDistanceM(authoredSite.position, requestedPosition)
  const radiusM = authoredSite.repositionRadiusM
  if (radiusM === undefined || requestedDistanceM <= Math.max(0, radiusM)) {
    return {
      position: { ...requestedPosition },
      clamped: false,
      distanceFromOriginM: requestedDistanceM,
    }
  }

  const position = offsetLatLng(
    authoredSite.position,
    bearingDeg(authoredSite.position, requestedPosition),
    Math.max(0, radiusM),
  )
  return {
    position,
    clamped: true,
    distanceFromOriginM: haversineDistanceM(authoredSite.position, position),
  }
}

/**
 * Assess a site move without changing scenario or runtime state. The returned override patch is
 * the only state a caller needs to commit after `ok` becomes true.
 */
export function assessSiteReposition(input: SiteRepositionInput): SiteRepositionResult {
  const authoredSite = input.scenario.launchSites?.[input.siteId]
    ?? input.scenario.recoverySites?.[input.siteId]
    ?? input.scenario.recoverySites?.[input.siteId]
  const currentSite = resolveLaunchSite(input.scenario, input.siteId, input.overrides)
  if (!authoredSite || !currentSite) {
    return failedResult(input, 'Unknown launch site.', input.requestedPosition)
  }

  if (!isMobileLaunchSite(authoredSite)) {
    return failedResult(input, `${authoredSite.label} is a fixed site.`, currentSite.position)
  }

  const clamped = clampSiteReposition(authoredSite, input.requestedPosition)
  const breached = firstBreachedGeofence(clamped.position, 0, input.scenario.geofences)
  const assignments = affectedAssignments(input)
  const affectedDrones = assignments.droneIds
  const affectedSiteIds = associatedSiteIds(
    input.scenario,
    input.siteId,
    affectedDrones,
    assignments.launch,
    assignments.recovery,
  )
  const overridePatch = Object.fromEntries(
    affectedSiteIds.map((siteId) => [siteId, { ...clamped.position }]),
  )
  const objective = input.objectivePosition
    ?? firstObjective(input.scenario, affectedDrones)
    ?? clamped.position
  const distanceToObjectiveDeltaM = round(
    haversineDistanceM(clamped.position, objective) - haversineDistanceM(currentSite.position, objective),
    1,
  )
  const reserveDeltaPct = conservativeReserveDelta(
    input.scenario,
    affectedDrones,
    currentSite.position,
    clamped.position,
    objective,
    input.weather,
  )
  const blockers: string[] = []

  if (breached) blockers.push(`${breached.label} is an active geofence.`)
  blockers.push(...strandingBlockers(input, affectedSiteIds))

  const ok = blockers.length === 0
  const reason = blockers[0]
  return {
    ok,
    siteId: input.siteId,
    from: { ...currentSite.position },
    requestedPosition: { ...input.requestedPosition },
    position: { ...clamped.position },
    clamped: clamped.clamped,
    distanceFromOriginM: round(clamped.distanceFromOriginM, 1),
    distanceToObjectiveDeltaM,
    reserveDeltaPct,
    affectedDrones,
    affectedSiteIds,
    overridePatch,
    repositionTimeSec: Math.max(0, authoredSite.repositionTimeSec ?? DEFAULT_REPOSITION_TIME_SEC),
    blockers,
    reason,
    message: ok
      ? previewMessage(distanceToObjectiveDeltaM, reserveDeltaPct, affectedDrones.length)
      : reason ?? 'Site relocation blocked.',
  }
}

function affectedAssignments(input: SiteRepositionInput): {
  droneIds: string[]
  launch: Record<string, string>
  recovery: Record<string, string>
} {
  const launch = input.launchAssignments ?? input.scenario.defaultLaunchAssignments ?? {}
  const recovery = input.recoveryAssignments ?? input.scenario.defaultRecoveryAssignments ?? {}
  const allDroneIds = new Set([
    ...Object.keys(launch),
    ...Object.keys(recovery),
    ...(input.drones ?? []).map((drone) => drone.id),
  ])
  const droneIds = [...allDroneIds]
    .filter((droneId) => {
      const launchSiteId = launch[droneId]
        ?? (input.scenario.launchSites?.[droneId] ? droneId : undefined)
      const recoverySiteId = recovery[droneId]
        ?? (input.scenario.recoverySites?.[droneId] ? droneId : undefined)
      return launchSiteId === input.siteId || recoverySiteId === input.siteId
    })
    .sort()
  return { droneIds, launch, recovery }
}

function associatedSiteIds(
  scenario: ScenarioConfig,
  launchSiteId: string,
  affectedDrones: string[],
  launchAssignments: Record<string, string>,
  recoveryAssignments: Record<string, string>,
): string[] {
  const launchPosition = scenario.launchSites?.[launchSiteId]?.position
    ?? scenario.recoverySites?.[launchSiteId]?.position
    ?? scenario.recoverySites?.[launchSiteId]?.position
  const ids = new Set([launchSiteId])
  if (!launchPosition) return [...ids]

  for (const droneId of affectedDrones) {
    const assignedLaunchId = launchAssignments[droneId]
      ?? (scenario.launchSites?.[droneId] ? droneId : undefined)
    const assignedLaunch = assignedLaunchId ? scenario.launchSites?.[assignedLaunchId] : undefined
    if (assignedLaunchId && assignedLaunch
      && haversineDistanceM(launchPosition, assignedLaunch.position) <= RECOVERY_MATCH_TOLERANCE_M) {
      ids.add(assignedLaunchId)
    }
    const recoveryId = recoveryAssignments[droneId]
      ?? (scenario.recoverySites?.[droneId] ? droneId : undefined)
    const recovery = recoveryId ? scenario.recoverySites?.[recoveryId] : undefined
    if (recoveryId && recovery
      && haversineDistanceM(launchPosition, recovery.position) <= RECOVERY_MATCH_TOLERANCE_M) {
      ids.add(recoveryId)
    }
  }
  return [...ids].sort()
}

function strandingBlockers(input: SiteRepositionInput, affectedSiteIds: string[]): string[] {
  const recoveryAssignments = input.recoveryAssignments ?? input.scenario.defaultRecoveryAssignments ?? {}
  const activeAffected = (input.drones ?? [])
    .filter((drone) => !GROUNDED_STATES.has(drone.missionState))
    .filter((drone) => {
      const recoveryId = recoveryAssignments[drone.id]
        ?? (input.scenario.recoverySites?.[drone.id] ? drone.id : undefined)
      return recoveryId ? affectedSiteIds.includes(recoveryId) : false
    })
    .filter((drone) => drone.batteryPct < batteryReservePctForDrone(input.scenario, drone.id))
    .sort((a, b) => a.id.localeCompare(b.id))

  return activeAffected.flatMap((drone) => {
    const alternatives = alternativeRecoveryPositions(input.scenario, affectedSiteIds, input.overrides, drone.id)
    const reachable = alternatives.some((position) => canReachRecovery(
      input.scenario,
      drone.id,
      drone.position,
      position,
      drone.batteryPct,
      input.weather,
    ))
    return reachable ? [] : [`${drone.id} has no reachable alternative recovery site.`]
  })
}

function alternativeRecoveryPositions(
  scenario: ScenarioConfig,
  excludedSiteIds: string[],
  overrides: SiteOverrides | undefined,
  droneId: string,
): LatLng[] {
  const recoverySites = Object.keys(scenario.recoverySites ?? {})
    .filter((siteId) => !excludedSiteIds.includes(siteId))
    .sort()
    .map((siteId) => resolveLaunchSite(scenario, siteId, overrides)?.position)
    .filter((position): position is LatLng => Boolean(position))
  const rechargeSites = rechargeStationsForDrone(scenario, droneId).map((station) => station.position)
  return [...recoverySites, ...rechargeSites]
}

function canReachRecovery(
  scenario: ScenarioConfig,
  droneId: string,
  from: LatLng,
  to: LatLng,
  batteryPct: number,
  weather: SiteRepositionInput['weather'],
): boolean {
  const speedMs = Math.max(0.1, platformForDrone(scenario, droneId).maxSpeedMs * (weather?.speedCapMultiplier ?? 1))
  const drainPct = haversineDistanceM(from, to) / speedMs
    * effectiveBatteryDrainRateForDrone(scenario, droneId)
    * (weather?.batteryDrainMultiplier ?? 1)
  return batteryPct - drainPct >= batteryReservePctForDrone(scenario, droneId)
}

function conservativeReserveDelta(
  scenario: ScenarioConfig,
  droneIds: string[],
  from: LatLng,
  to: LatLng,
  objective: LatLng,
  weather: SiteRepositionInput['weather'],
): number {
  if (droneIds.length === 0) return 0
  const deltas = droneIds.map((droneId) => {
    const speedMs = Math.max(0.1, platformForDrone(scenario, droneId).maxSpeedMs * (weather?.speedCapMultiplier ?? 1))
    const drainRate = effectiveBatteryDrainRateForDrone(scenario, droneId)
      * (weather?.batteryDrainMultiplier ?? 1)
    const oldRequired = haversineDistanceM(objective, from) / speedMs * drainRate
    const newRequired = haversineDistanceM(objective, to) / speedMs * drainRate
    return oldRequired - newRequired
  })
  return round(Math.min(...deltas), 1)
}

function firstObjective(scenario: ScenarioConfig, droneIds: string[]): LatLng | undefined {
  for (const droneId of [...droneIds].sort()) {
    const point = scenario.perDroneWaypoints?.[droneId]?.[0]?.position
    if (point) return point
  }
  return scenario.waypoints[0]?.position
}

function previewMessage(distanceDeltaM: number, reserveDeltaPct: number, affectedCount: number): string {
  const distanceKm = distanceDeltaM / 1_000
  const droneWord = affectedCount === 1 ? 'drone' : 'drones'
  return `${signed(distanceKm, 1)} km to sector · ${signed(reserveDeltaPct, 1)}% reserve · ${affectedCount} ${droneWord} re-planned.`
}

function failedResult(
  input: SiteRepositionInput,
  reason: string,
  position: LatLng,
): SiteRepositionResult {
  return {
    ok: false,
    siteId: input.siteId,
    from: { ...position },
    requestedPosition: { ...input.requestedPosition },
    position: { ...position },
    clamped: false,
    distanceFromOriginM: 0,
    distanceToObjectiveDeltaM: 0,
    reserveDeltaPct: 0,
    affectedDrones: [],
    affectedSiteIds: [],
    overridePatch: {},
    repositionTimeSec: 0,
    blockers: [reason],
    reason,
    message: reason,
  }
}

function signed(value: number, digits: number): string {
  const rounded = round(value, digits)
  return `${rounded >= 0 ? '+' : ''}${rounded.toFixed(digits)}`
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}
