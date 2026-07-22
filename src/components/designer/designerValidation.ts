import { auditScenarioRoutes } from '@/sim/mission/routeAudit'
import { MAX_OPERATOR_ALTITUDE_FT, MIN_OPERATOR_ALTITUDE_FT, validateAltitude } from '@/sim/mission/operatorRoutes'
import { MAX_WAYPOINTS_PER_DRONE } from '@/sim/mission/routeLimits'
import type { CustomMissionDefinition, LaunchRecoverySite, ScenarioConfig, Waypoint } from '@/types'

export const MAX_CUSTOM_DRONES = 8
export { MAX_WAYPOINTS_PER_DRONE } from '@/sim/mission/routeLimits'

export interface DesignerValidationResult {
  valid: boolean
  errors: string[]
  scenario: ScenarioConfig | null
}

export function customDroneId(index: number): string {
  return `uav-${String(index + 1).padStart(2, '0')}`
}

export function validCoordinate(position: { lat: number; lng: number }): boolean {
  return Number.isFinite(position.lat)
    && Number.isFinite(position.lng)
    && position.lat >= -90
    && position.lat <= 90
    && position.lng >= -180
    && position.lng <= 180
}

function stableSeed(id: string): number {
  let value = 2166136261
  for (const char of id) value = Math.imul(value ^ char.charCodeAt(0), 16777619)
  return Math.abs(value) || 1
}

function toSite(site: CustomMissionDefinition['sites'][number]): LaunchRecoverySite {
  return {
    kind: site.kind,
    label: site.label,
    agency: 'Operator-authored mission',
    position: site.position,
    surfaceNote: 'Operator-verified launch and recovery surface',
    capacityDrones: site.capacityDrones ?? 1,
  }
}

export function compileCustomMission(definition: CustomMissionDefinition): ScenarioConfig {
  const launchSites: Record<string, LaunchRecoverySite> = {}
  const recoverySites: Record<string, LaunchRecoverySite> = {}
  const perDroneStartPositions: ScenarioConfig['perDroneStartPositions'] = {}
  const defaultLaunchAssignments: Record<string, string> = {}

  for (let index = 0; index < definition.droneCount; index++) {
    const droneId = customDroneId(index)
    const launchId = definition.launchAssignments[droneId]
    const recoveryId = definition.recoveryAssignments[droneId]
    const launch = definition.sites.find((site) => site.id === launchId)
    const recovery = definition.sites.find((site) => site.id === recoveryId)
    if (launch) {
      launchSites[droneId] = toSite(launch)
      perDroneStartPositions[droneId] = launch.position
      // Scenario launch sites are normalized as one keyed site per drone. The
      // launch plan therefore assigns the drone to that normalized key, while
      // the saved definition retains the operator's original shared site id.
      defaultLaunchAssignments[droneId] = droneId
    }
    if (recovery) recoverySites[droneId] = { ...toSite(recovery), isPrimaryRecovery: true }
  }

  const firstRoute = definition.routes[customDroneId(0)] ?? []
  return {
    id: `custom-${definition.id}`,
    name: definition.name.trim(),
    description: `${definition.purpose.trim()} End goal: ${definition.endGoal.trim()}`,
    seed: stableSeed(definition.id),
    droneCount: definition.droneCount,
    missionType: 'waypoint',
    startPosition: launchSites[customDroneId(0)]?.position ?? definition.center,
    waypoints: firstRoute,
    perDroneWaypoints: definition.routes,
    geofences: [],
    heatSources: [],
    batteryStartPct: 100,
    batteryDrainRatePerSec: 0.035,
    commsLossWindows: [],
    rechargeTimeSec: 25,
    maxSorties: 2,
    perDroneStartPositions,
    launchSites,
    recoverySites,
    missionBrief: {
      agencies: ['Operator-defined response team'],
      situation: definition.purpose.trim(),
      commandIntent: definition.endGoal.trim(),
      coordinationModel: 'Operator-defined launch, recovery, and per-drone routes',
      primaryObjective: definition.purpose.trim(),
      successCondition: definition.endGoal.trim(),
      operationalConstraints: [
        `Location: ${definition.locationLabel.trim()}`,
        `${MIN_OPERATOR_ALTITUDE_FT}-${MAX_OPERATOR_ALTITUDE_FT} ft AGL waypoint envelope`,
      ],
    },
    weatherProfile: {
      locationTag: 'generic',
      baseConditions: { windKts: 4, gustKts: 7, visibilityMi: 10, ceilingFt: 5000, tempF: 68 },
      possibleHazards: ['rain', 'fog', 'rf_shadow'],
    },
    isCustom: true,
    authoredRoutes: definition.routes,
    defaultLaunchAssignments,
  }
}

function validateAssignments(
  label: 'Launch' | 'Recovery',
  definition: CustomMissionDefinition,
  assignments: Record<string, string>,
  errors: string[],
) {
  const usage = new Map<string, number>()
  for (let index = 0; index < definition.droneCount; index++) {
    const droneId = customDroneId(index)
    const siteId = assignments[droneId]
    const site = definition.sites.find((candidate) => candidate.id === siteId)
    if (!site) {
      errors.push(`${label} site is required for ${droneId.toUpperCase()}.`)
      continue
    }
    usage.set(siteId, (usage.get(siteId) ?? 0) + 1)
  }
  for (const [siteId, count] of usage) {
    const site = definition.sites.find((candidate) => candidate.id === siteId)
    if (site && count > (site.capacityDrones ?? 1)) {
      errors.push(`${label} site “${site.label}” is assigned to ${count} drones but has capacity ${site.capacityDrones ?? 1}.`)
    }
  }
}

function validateRoute(droneId: string, route: Waypoint[] | undefined, errors: string[]) {
  if (!route?.length) {
    errors.push(`${droneId.toUpperCase()} needs at least one waypoint.`)
    return
  }
  if (route.length > MAX_WAYPOINTS_PER_DRONE) {
    errors.push(`${droneId.toUpperCase()} has ${route.length} waypoints; the maximum is ${MAX_WAYPOINTS_PER_DRONE}.`)
  }
  route.forEach((waypoint, index) => {
    if (!validCoordinate(waypoint.position)) errors.push(`${droneId.toUpperCase()} waypoint ${index + 1} has invalid coordinates.`)
    if (!validateAltitude(waypoint.altitudeFt)) {
      errors.push(`${droneId.toUpperCase()} waypoint ${index + 1} must be ${MIN_OPERATOR_ALTITUDE_FT}-${MAX_OPERATOR_ALTITUDE_FT} ft AGL.`)
    }
  })
}

export function validateCustomMission(definition: CustomMissionDefinition): DesignerValidationResult {
  const errors: string[] = []
  if (!definition.name.trim()) errors.push('Mission name is required.')
  if (!definition.locationLabel.trim()) errors.push('Location name is required.')
  if (!definition.purpose.trim()) errors.push('Mission purpose is required.')
  if (!definition.endGoal.trim()) errors.push('Mission end goal is required.')
  if (!validCoordinate(definition.center)) errors.push('Mission center coordinates are invalid.')
  if (!Number.isInteger(definition.droneCount) || definition.droneCount < 1 || definition.droneCount > MAX_CUSTOM_DRONES) {
    errors.push(`Fleet size must be between 1 and ${MAX_CUSTOM_DRONES} drones.`)
  }
  if (!definition.sites.length) errors.push('Add at least one launch/recovery site.')
  definition.sites.forEach((site, index) => {
    if (!site.label.trim()) errors.push(`Site ${index + 1} needs a label.`)
    if (!validCoordinate(site.position)) errors.push(`Site ${index + 1} has invalid coordinates.`)
    if (!Number.isInteger(site.capacityDrones) || (site.capacityDrones ?? 0) < 1 || (site.capacityDrones ?? 0) > MAX_CUSTOM_DRONES) {
      errors.push(`Site “${site.label || index + 1}” capacity must be 1-${MAX_CUSTOM_DRONES}.`)
    }
  })

  validateAssignments('Launch', definition, definition.launchAssignments, errors)
  validateAssignments('Recovery', definition, definition.recoveryAssignments, errors)
  for (let index = 0; index < definition.droneCount; index++) {
    const droneId = customDroneId(index)
    validateRoute(droneId, definition.routes[droneId], errors)
  }

  let scenario: ScenarioConfig | null = null
  if (errors.length === 0) {
    scenario = compileCustomMission(definition)
    const findings = auditScenarioRoutes(scenario, { routes: definition.routes, includeRtb: false })
    for (const finding of findings) errors.push(`${finding.droneId.toUpperCase()}: ${finding.reason}`)
  }
  return { valid: errors.length === 0, errors, scenario: errors.length === 0 ? scenario : null }
}
