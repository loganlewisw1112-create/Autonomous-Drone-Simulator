import {
  auditScenarioRoutes,
  auditTerrainClearance,
  buildSafeRouteFromWaypoints,
  defaultDroneStartPosition,
  droneIdForIndex,
} from '@/sim/mission/routeAudit'
import { selectRechargeStationForDrone } from '@/sim/mission/rechargeStations'
import { offsetLatLng } from '@/utils/geometry'
import type { DispatchPriority, LatLng, RouteSuggestion, ScenarioConfig, ThermalDetection, Waypoint } from '@/types'

export interface OperatorRouteValidation {
  accepted: boolean
  findings: ReturnType<typeof auditScenarioRoutes>
  terrainWarnings: ReturnType<typeof auditTerrainClearance>
  route: Waypoint[]
}

export interface OperatorCommandRouteInput {
  command: 'deep_scan' | 'street_sweep' | 'perimeter_orbit' | 'expanding_search' | 'standoff_observe' | 'route_lkl'
  scenario: ScenarioConfig
  droneId: string
  center?: LatLng
  altitudeFt?: number
  fromPosition?: LatLng
}

export interface RouteSuggestionInput {
  scenario: ScenarioConfig
  droneId: string
  elapsedSec: number
  thermalDetections: ThermalDetection[]
  warnings: readonly string[]
  sortieCount?: number
  currentWaypointIndex?: number
  fromPosition?: LatLng
}

export function validateOperatorRoute(
  scenario: ScenarioConfig,
  droneId: string,
  route: Waypoint[],
  fromPosition?: LatLng,
): OperatorRouteValidation {
  const findings = auditScenarioRoutes(scenario, {
    routes: { [droneId]: route },
    includeRtb: false,
    startPositions: fromPosition ? { [droneId]: fromPosition } : undefined,
  })
    .filter((finding) => finding.droneId === droneId)
  const parsedDroneIndex = Number(droneId.slice(-2))
  const droneIndex = Number.isFinite(parsedDroneIndex) ? Math.max(0, parsedDroneIndex - 1) : 0
  const terrainWarnings = auditTerrainClearance(scenario.id, droneId, route, {
    fromPosition: fromPosition ?? defaultDroneStartPosition(scenario, droneIndex),
  })

  return {
    // Terrain coverage/clearance remains advisory. Only the established geofence audit rejects.
    accepted: findings.length === 0,
    findings,
    terrainWarnings,
    route,
  }
}

/** Altitude band an operator-authored waypoint must fall within: 20–400 ft AGL (inclusive).
 *  Used by the custom-mission designer to reject waypoints below rooftop clearance or above
 *  the Part 107 ceiling before a mission is compiled. */
export const MIN_OPERATOR_ALTITUDE_FT = 20
export const MAX_OPERATOR_ALTITUDE_FT = 400

export function validateAltitude(altFt: number): boolean {
  return altFt >= MIN_OPERATOR_ALTITUDE_FT && altFt <= MAX_OPERATOR_ALTITUDE_FT
}

export function buildOperatorCommandRoute(input: OperatorCommandRouteInput): Waypoint[] {
  const altitudeFt = input.altitudeFt ?? defaultAltitudeFor(input.scenario, input.droneId)
  const center = input.center ?? firstOperationalCue(input.scenario)
  let draft: Waypoint[]

  switch (input.command) {
    case 'street_sweep':
      draft = buildStreetSweep(input.scenario, altitudeFt)
      break
    case 'perimeter_orbit':
      draft = buildOrbit(center, altitudeFt, 90, `${input.droneId}-orbit`)
      break
    case 'expanding_search':
      draft = buildExpandingSearch(center, altitudeFt, `${input.droneId}-expand`)
      break
    case 'standoff_observe':
      draft = [
        {
          id: `${input.droneId}-standoff-observe`,
          label: 'Standoff Observe',
          position: offsetLatLng(center, 270, 90),
          altitudeFt,
          dwellTimeSec: 20,
        },
      ]
      break
    case 'route_lkl':
      draft = [
        {
          id: `${input.droneId}-last-known`,
          label: 'Last Known Location',
          position: center,
          altitudeFt,
          dwellTimeSec: 20,
        },
      ]
      break
    case 'deep_scan':
    default:
      draft = buildDeepScan(center, altitudeFt, `${input.droneId}-deep`)
      break
  }

  const droneIndex = Math.max(0, Number(input.droneId.slice(-2)) - 1)
  const start = input.fromPosition ?? defaultDroneStartPosition(input.scenario, droneIndex)
  return buildSafeRouteFromWaypoints(input.scenario, input.droneId, start, draft)
}

export function buildRouteSuggestions(input: RouteSuggestionInput): RouteSuggestion[] {
  const suggestions: RouteSuggestion[] = []
  const bucket = Math.floor(input.elapsedSec / 15) * 15
  const latestThermal = [...input.thermalDetections].sort((a, b) => b.tick - a.tick)[0]

  if (latestThermal || input.warnings.includes('thermal_contact')) {
    const center = latestThermal?.position ?? firstOperationalCue(input.scenario)
    suggestions.push(makeSuggestion({
      input,
      bucket,
      idPart: latestThermal?.sourceId ?? 'thermal',
      title: 'Thermal follow-up scan',
      rationale: 'Thermal cue requires a tight scan box and ground-team vector check before the contact ages out.',
      priority: 'urgent',
      route: buildOperatorCommandRoute({ command: 'deep_scan', scenario: input.scenario, droneId: input.droneId, center, fromPosition: input.fromPosition }),
    }))
  }

  if (input.warnings.includes('comms_degraded')) {
    suggestions.push(makeSuggestion({
      input,
      bucket,
      idPart: 'relay',
      title: 'Relay reposition',
      rationale: 'Signal degradation detected; move selected drone to a high standoff relay point with line-of-sight coverage.',
      priority: 'advisory',
      route: buildOperatorCommandRoute({ command: 'standoff_observe', scenario: input.scenario, droneId: input.droneId, center: firstRelayCue(input.scenario), altitudeFt: 220, fromPosition: input.fromPosition }),
    }))
  }

  if (input.warnings.includes('geofence') || input.warnings.includes('route_risk')) {
    const route = input.scenario.perDroneWaypoints?.[input.droneId] ?? []
    suggestions.push(makeSuggestion({
      input,
      bucket,
      idPart: 'safe-route',
      title: 'Safer reroute',
      rationale: 'Route audit flagged a safety risk; use a detoured route around active geofence and hazard zones.',
      priority: 'critical',
      route: buildSafeRouteFromWaypoints(input.scenario, input.droneId, input.fromPosition ?? firstOperationalCue(input.scenario), route),
    }))
  }

  if (suggestions.length === 0 && input.scenario.rechargeStations?.length) {
    const selection = selectRechargeStationForDrone({
      scenario: input.scenario,
      droneId: input.droneId,
      sortieCount: input.sortieCount ?? 0,
      currentWaypointIndex: input.currentWaypointIndex ?? 0,
    })
    if (selection) {
      const droneIndex = Math.max(0, Number(input.droneId.slice(-2)) - 1)
      const route = buildSafeRouteFromWaypoints(
        input.scenario,
        input.droneId,
        input.fromPosition ?? defaultDroneStartPosition(input.scenario, droneIndex),
        [{
          id: `${input.droneId}-${selection.station.id}`,
          label: `Forward Recharge: ${selection.station.label}`,
          position: selection.position,
          altitudeFt: defaultAltitudeFor(input.scenario, input.droneId),
          dwellTimeSec: 20,
        }],
      )
      suggestions.push(makeSuggestion({
        input,
        bucket,
        idPart: `recharge-${selection.station.id}`,
        title: 'Forward recharge staging',
        rationale: `${selection.station.label} is the next forward mobile support node on ${selection.station.road}; use it for reserve management instead of routing backward.`,
        priority: 'advisory',
        route,
      }))
    }
  }

  if (suggestions.length === 0) {
    suggestions.push(makeSuggestion({
      input,
      bucket,
      idPart: 'sector-sweep',
      title: 'Sector sweep refinement',
      rationale: 'No active hazard; tighten the selected drone route around the most relevant operational feature.',
      priority: 'routine',
      route: buildOperatorCommandRoute({ command: 'street_sweep', scenario: input.scenario, droneId: input.droneId, fromPosition: input.fromPosition }),
    }))
  }

  return suggestions.filter((suggestion) => validateOperatorRoute(input.scenario, input.droneId, suggestion.route, input.fromPosition).accepted)
}

function makeSuggestion(args: {
  input: RouteSuggestionInput
  bucket: number
  idPart: string
  title: string
  rationale: string
  priority: DispatchPriority
  route: Waypoint[]
}): RouteSuggestion {
  return {
    id: `${args.input.scenario.id}-${args.input.droneId}-${args.idPart}-${args.bucket}`,
    droneId: args.input.droneId,
    source: 'ROUTE ADVISOR',
    priority: args.priority,
    title: args.title,
    rationale: args.rationale,
    riskLevel: args.priority,
    route: args.route,
    requiresApproval: true,
    createdAtSec: args.bucket,
  }
}

function buildDeepScan(center: LatLng, altitudeFt: number, prefix: string): Waypoint[] {
  const points = [
    offsetLatLng(center, 315, 55),
    offsetLatLng(center, 45, 55),
    offsetLatLng(center, 135, 55),
    offsetLatLng(center, 225, 55),
    center,
  ]
  return points.map((position, index) => ({
    id: `${prefix}-${index + 1}`,
    label: index === points.length - 1 ? 'Deep Scan Center' : `Deep Scan ${index + 1}`,
    position,
    altitudeFt,
    dwellTimeSec: index === points.length - 1 ? 14 : 6,
  }))
}

function buildOrbit(center: LatLng, altitudeFt: number, radiusM: number, prefix: string): Waypoint[] {
  return [0, 90, 180, 270, 0].map((bearing, index) => ({
    id: `${prefix}-${index + 1}`,
    label: `Perimeter Orbit ${index + 1}`,
    position: offsetLatLng(center, bearing, radiusM),
    altitudeFt,
    dwellTimeSec: index === 0 ? 8 : 5,
  }))
}

function buildExpandingSearch(center: LatLng, altitudeFt: number, prefix: string): Waypoint[] {
  return [35, 65, 95, 130, 165].map((radius, index) => ({
    id: `${prefix}-${index + 1}`,
    label: `Expanding Search ${index + 1}`,
    position: offsetLatLng(center, (index * 72) % 360, radius),
    altitudeFt,
    dwellTimeSec: 6,
  }))
}

function buildStreetSweep(scenario: ScenarioConfig, altitudeFt: number): Waypoint[] {
  const feature = scenario.operationalFeatures?.find((f) =>
    ['street', 'alley', 'shoreline', 'bridge', 'search_sector'].includes(f.type) && f.points.length > 1
  )
  const points = feature?.points.slice(0, 8) ?? (scenario.perDroneWaypoints?.[droneIdForIndex(0)] ?? scenario.waypoints).map((wp) => wp.position)
  return points.slice(0, 6).map((position, index) => ({
    id: `street-sweep-${index + 1}`,
    label: `${feature?.label ?? 'Street/Area'} ${index + 1}`,
    position,
    altitudeFt,
    dwellTimeSec: 5,
  }))
}

function defaultAltitudeFor(scenario: ScenarioConfig, droneId: string): number {
  const route = scenario.perDroneWaypoints?.[droneId]
  if (route?.[0]) return route[0].altitudeFt
  const idx = Math.max(0, Number(droneId.slice(-2)) - 1)
  return 100 + idx * 20
}

function firstOperationalCue(scenario: ScenarioConfig): LatLng {
  return scenario.operationalFeatures?.find((f) => ['last_known', 'search_sector', 'gate'].includes(f.type))?.points[0]
    ?? scenario.heatSources[0]?.position
    ?? scenario.waypoints[0]?.position
    ?? scenario.startPosition
}

function firstRelayCue(scenario: ScenarioConfig): LatLng {
  return scenario.operationalFeatures?.find((f) => f.type === 'relay')?.points[0]
    ?? scenario.startPosition
}
