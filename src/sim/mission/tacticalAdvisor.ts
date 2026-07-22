import { platformForDrone } from '@/sim/drone/platformCatalog'
import { getMissionSafetyOverride } from '@/sim/mission/MissionManager'
import { buildOperatorCommandRoute, validateOperatorRoute } from '@/sim/mission/operatorRoutes'
import { buildSafeRouteFromWaypoints } from '@/sim/mission/routeAudit'
import {
  batteryReservePctForDrone,
  effectiveBatteryDrainRateForDrone,
  rechargeStationsForDrone,
  selectRechargeStationForDrone,
} from '@/sim/mission/rechargeStations'
import { isRetaskable } from '@/sim/mission/retaskPolicy'
import { cumulativePod, probabilityOfDetection } from '@/sim/sensors/sweepWidth'
import { platformTaskRanges } from '@/sim/sensors/thermalRange'
import { isWeatherForceRtb } from '@/sim/weather/weatherEngine'
import { haversineDistanceM } from '@/utils/geometry'
import { recoverySiteForDrone } from '@/sim/mission/siteAssignments'
import type {
  DispatchFeedEntry,
  DispatchPriority,
  DroneState,
  GroundUnitState,
  LatLng,
  OperationalFeatureType,
  ScenarioConfig,
  ThermalDetection,
  Waypoint,
  WeatherVariantState,
} from '@/types'

const MAX_CANDIDATES_PER_DRONE = 8
const MAX_CONTACT_CANDIDATES = 2
const DEFAULT_DETECTION_RADIUS_M = 60
const COVERAGE_RADIUS_M = 250
const CRUISE_SPEED_FACTOR = 0.65
const REDUNDANCY_PENALTY = 30

export type TacticalObjectiveKind = 'contact' | 'feature' | 'dispatch' | 'recharge'

export type TacticalAction =
  | 'hold_station'
  | 'route_recharge'
  | 'rtb_now'
  | 'deep_scan'
  | 'street_sweep'
  | 'perimeter_orbit'
  | 'expanding_search'
  | 'standoff_observe'
  | 'route_lkl'

type RoutePattern = Exclude<TacticalAction, 'hold_station' | 'route_recharge' | 'rtb_now'>

export interface UnresolvedContact extends ThermalDetection {
  resolvedAt?: number
}

export interface MissionSituationInput {
  scenario: ScenarioConfig
  drones: readonly DroneState[]
  droneWaypoints?: Readonly<Record<string, readonly Waypoint[]>>
  tick: number
  elapsedSec: number
  unresolvedContacts?: readonly UnresolvedContact[]
  dispatchEntries?: readonly DispatchFeedEntry[]
  groundUnits?: readonly GroundUnitState[]
  weather?: WeatherVariantState
  positionHistory?: Readonly<Record<string, readonly LatLng[]>>
}

export interface TacticalObjective {
  id: string
  kind: TacticalObjectiveKind
  label: string
  position: LatLng
  priority: DispatchPriority
  value: number
  coverage: number
  featureType?: OperationalFeatureType
  linkedDroneId?: string
}

export interface MissionSituation {
  scenario: ScenarioConfig
  drones: readonly DroneState[]
  objectives: readonly TacticalObjective[]
  droneWaypoints: Readonly<Record<string, readonly Waypoint[]>>
  tick: number
  elapsedSec: number
  groundUnits: readonly GroundUnitState[]
  weather: WeatherVariantState | undefined
  weatherForceRtb: boolean
  positionHistory: Readonly<Record<string, readonly LatLng[]>>
}

export interface TacticalScoreBreakdown {
  valueGain: number
  transitCost: number
  riskPenalty: number
  continuityPenalty: number
  redundancyPenalty: number
  total: number
}

export interface TacticalCandidate {
  id: string
  droneId: string
  action: TacticalAction
  objectiveId: string
  objectiveLabel: string
  route: Waypoint[]
  requiredBatteryPct: number
  reservePct: number
  score: TacticalScoreBreakdown
}

export interface FleetRetaskAssignment extends TacticalCandidate {
  rank: number
}

export interface FleetRetaskPlan {
  assignments: FleetRetaskAssignment[]
  candidatesByDrone: Record<string, TacticalCandidate[]>
  skippedDrones: Array<{
    droneId: string
    reason: 'not_retaskable' | 'critical_battery' | 'battery_reserve' | 'geofence_breach' | 'weather'
  }>
  unassignedDroneIds: string[]
}

/**
 * Normalizes live mission inputs into stable tactical objectives. Coverage is estimated from
 * rolling position-history track effort. Published platform thermal geometry supplies the
 * detection radius when available; otherwise the planner deliberately falls back to a
 * conservative fixed 60 m radius. Geofence proximity is never scored: a clean route audit is
 * a binary eligibility gate in planFleetRetask.
 */
export function buildMissionSituation(input: MissionSituationInput): MissionSituation {
  const scenario = canonicalScenario(input.scenario)
  const drones = [...input.drones].sort(byId).map(cloneDrone)
  const droneWaypoints = cloneWaypointMap(input.droneWaypoints)
  const positionHistory = clonePositionHistory(input.positionHistory)
  const coverageAt = (position: LatLng) => estimateCoverage(position, drones, positionHistory, scenario)
  const objectives: TacticalObjective[] = []

  for (const contact of [...(input.unresolvedContacts ?? [])]
    .filter((item) => item.resolvedAt === undefined)
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId))) {
    objectives.push({
      id: `contact:${contact.sourceId}`,
      kind: 'contact',
      label: `Thermal contact ${contact.sourceId}`,
      position: clonePosition(contact.position),
      priority: 'urgent',
      value: round(65 + clamp01(contact.confidence) * 25 + contactRecencyValue(input.tick, contact.tick)),
      coverage: coverageAt(contact.position),
    })
  }

  for (const feature of scenario.operationalFeatures ?? []) {
    const position = feature.points[0]
    if (!position) continue
    const priority = feature.priority ?? priorityForFeature(feature.type)
    objectives.push({
      id: `feature:${feature.id}`,
      kind: 'feature',
      label: feature.label,
      position: clonePosition(position),
      priority,
      value: round(featureValue(feature.type) + priorityRank(priority) * 5),
      coverage: coverageAt(position),
      featureType: feature.type,
    })
  }

  const dispatchEntries = input.dispatchEntries
    ?? authoredDispatchEntries(scenario)
  for (const entry of [...dispatchEntries]
    .filter((entry) => entry.timeSec <= input.elapsedSec)
    .filter(isActionableDispatch)
    .sort((a, b) => a.id.localeCompare(b.id))) {
    const linkedDrone = drones.find((drone) => drone.id === entry.linkedDroneId)
    const position = linkedDrone?.position ?? firstScenarioCue(scenario)
    objectives.push({
      id: `dispatch:${entry.id}`,
      kind: 'dispatch',
      label: entry.message,
      position: clonePosition(position),
      priority: entry.priority,
      value: 35 + priorityRank(entry.priority) * 12,
      coverage: coverageAt(position),
      linkedDroneId: entry.linkedDroneId,
    })
  }

  for (const station of scenario.rechargeStations ?? []) {
    objectives.push({
      id: `recharge:${station.id}`,
      kind: 'recharge',
      label: station.label,
      position: clonePosition(station.position),
      priority: station.priority ?? 'advisory',
      value: 35,
      coverage: 0,
    })
  }

  return {
    scenario,
    drones,
    objectives: dedupeObjectives(objectives).sort(compareObjectives),
    droneWaypoints,
    tick: input.tick,
    elapsedSec: input.elapsedSec,
    groundUnits: [...(input.groundUnits ?? [])].sort(byId).map((unit) => ({
      ...unit,
      position: clonePosition(unit.position),
    })),
    weather: input.weather,
    weatherForceRtb: input.weather ? isWeatherForceRtb(input.weather) : false,
    positionHistory,
  }
}

export function planFleetRetask(situation: MissionSituation): FleetRetaskPlan {
  const candidatesByDrone: Record<string, TacticalCandidate[]> = {}
  const skippedDrones: FleetRetaskPlan['skippedDrones'] = []
  const eligibleDrones: DroneState[] = []

  for (const drone of [...situation.drones].sort(byId)) {
    if (!isRetaskable(drone)) {
      skippedDrones.push({ droneId: drone.id, reason: 'not_retaskable' })
      candidatesByDrone[drone.id] = []
      continue
    }
    const reservePct = batteryReservePctForDrone(situation.scenario, drone.id)
    const safetyOverride = getMissionSafetyOverride(drone, {
      batteryReservePct: reservePct,
      weatherForceRtb: situation.weatherForceRtb,
    })
    if (safetyOverride) {
      skippedDrones.push({ droneId: drone.id, reason: safetyOverride.reason })
      candidatesByDrone[drone.id] = []
      continue
    }

    eligibleDrones.push(drone)
    candidatesByDrone[drone.id] = buildCandidatesForDrone(situation, drone, reservePct)
  }

  const selected = greedyAssignments(eligibleDrones, candidatesByDrone)
  improveAssignments(selected, candidatesByDrone)
  const assignments = finalizeAssignments(selected)
  const assignedIds = new Set(assignments.map((assignment) => assignment.droneId))

  return {
    assignments,
    candidatesByDrone,
    skippedDrones: skippedDrones.sort((a, b) => a.droneId.localeCompare(b.droneId)),
    unassignedDroneIds: eligibleDrones.map((drone) => drone.id).filter((id) => !assignedIds.has(id)),
  }
}

function buildCandidatesForDrone(
  situation: MissionSituation,
  drone: DroneState,
  reservePct: number,
): TacticalCandidate[] {
  const reserved: TacticalCandidate[] = []
  const contactCandidates: TacticalCandidate[] = []
  const patterns: Array<{ affinity: number; candidate: TacticalCandidate }> = []

  const holdObjective: TacticalObjective = {
    id: `hold:${drone.id}`,
    kind: 'feature',
    label: 'Hold current station',
    position: drone.position,
    priority: 'routine',
    value: 18,
    coverage: 0,
  }
  reserved.push(makeHoldCandidate(situation, drone, reservePct, holdObjective))

  const rechargeSelection = selectRechargeStationForDrone({
    scenario: situation.scenario,
    droneId: drone.id,
    sortieCount: drone.sortieCount,
    currentWaypointIndex: drone.currentWaypointIndex,
  })
  if (rechargeSelection) {
    const rechargeObjective = situation.objectives.find((objective) => objective.id === `recharge:${rechargeSelection.station.id}`) ?? {
      id: `recharge:${rechargeSelection.station.id}`,
      kind: 'recharge' as const,
      label: rechargeSelection.station.label,
      position: rechargeSelection.position,
      priority: rechargeSelection.station.priority ?? 'advisory' as const,
      value: 35,
      coverage: 0,
    }
    const recharge = makeCandidate(situation, drone, reservePct, 'route_recharge', rechargeObjective)
    if (recharge) reserved.push(recharge)
  }

  const recovery = recoveryPosition(situation.scenario, drone.id)
  const rtb = makeCandidate(situation, drone, reservePct, 'rtb_now', {
    id: `rtb:${drone.id}`,
    kind: 'recharge',
    label: 'Return to recovery site',
    position: recovery,
    priority: 'advisory',
    value: 24,
    coverage: 0,
  })
  if (rtb) reserved.push(rtb)

  const contacts = situation.objectives
    .filter((objective) => objective.kind === 'contact')
    .sort(compareObjectives)
    .slice(0, MAX_CONTACT_CANDIDATES)
  for (const objective of contacts) {
    const candidate = makeCandidate(situation, drone, reservePct, 'deep_scan', objective)
    if (candidate) contactCandidates.push(candidate)
  }

  for (const action of ROUTE_PATTERNS) {
    const rankedObjectives = situation.objectives
      .filter((objective) => objective.kind !== 'recharge')
      .map((objective) => ({ objective, affinity: objectiveAffinity(action, objective) }))
      .sort((a, b) => b.affinity - a.affinity || compareObjectives(a.objective, b.objective))
    const best = rankedObjectives[0]
    if (!best) continue
    const candidate = makeCandidate(situation, drone, reservePct, action, best.objective)
    if (candidate && !contactCandidates.some((item) => item.id === candidate.id)) {
      patterns.push({ affinity: best.affinity, candidate })
    }
  }

  const retained = [
    ...reserved,
    ...contactCandidates,
    ...patterns
      .sort((a, b) => b.affinity - a.affinity || a.candidate.id.localeCompare(b.candidate.id))
      .map(({ candidate }) => candidate),
  ]

  return dedupeCandidates(retained).slice(0, MAX_CANDIDATES_PER_DRONE)
}

const ROUTE_PATTERNS: readonly RoutePattern[] = [
  'deep_scan',
  'street_sweep',
  'perimeter_orbit',
  'expanding_search',
  'standoff_observe',
  'route_lkl',
]

function makeCandidate(
  situation: MissionSituation,
  drone: DroneState,
  reservePct: number,
  action: TacticalAction,
  objective: TacticalObjective,
): TacticalCandidate | null {
  const altitudeFt = Math.max(20, drone.altitudeFt || defaultAltitude(situation.scenario, drone.id))
  const route = action === 'route_recharge' || action === 'rtb_now'
    ? buildSafeRouteFromWaypoints(situation.scenario, drone.id, drone.position, [{
        id: `${drone.id}-${action}`,
        label: objective.label,
        position: objective.position,
        altitudeFt,
      }])
    : buildOperatorCommandRoute({
        command: action as RoutePattern,
        scenario: situation.scenario,
        droneId: drone.id,
        center: objective.position,
        altitudeFt,
        fromPosition: drone.position,
      })
  if (!validateOperatorRoute(situation.scenario, drone.id, route, drone.position).accepted) return null

  const requiredBatteryPct = routeBatteryRequirementPct(
    situation,
    drone,
    route,
    action !== 'route_recharge' && action !== 'rtb_now',
  )
  if (drone.batteryPct - requiredBatteryPct < reservePct) return null

  const score = scoreCandidate(situation, drone, objective, route, action)
  return {
    id: `${drone.id}|${action}|${objective.id}`,
    droneId: drone.id,
    action,
    objectiveId: objective.id,
    objectiveLabel: objective.label,
    route,
    requiredBatteryPct,
    reservePct,
    score,
  }
}

function makeHoldCandidate(
  situation: MissionSituation,
  drone: DroneState,
  reservePct: number,
  objective: TacticalObjective,
): TacticalCandidate {
  return {
    id: `${drone.id}|hold_station|${objective.id}`,
    droneId: drone.id,
    action: 'hold_station',
    objectiveId: objective.id,
    objectiveLabel: objective.label,
    route: [],
    requiredBatteryPct: 0,
    reservePct,
    score: scoreCandidate(situation, drone, objective, [], 'hold_station'),
  }
}

function routeBatteryRequirementPct(
  situation: MissionSituation,
  drone: DroneState,
  route: readonly Waypoint[],
  includeRecovery: boolean,
): number {
  const durationSec = routeDurationSec(situation, drone, route, includeRecovery)
  const drainMultiplier = situation.weather?.batteryDrainMultiplier ?? 1
  const drainRate = effectiveBatteryDrainRateForDrone(situation.scenario, drone.id) * drainMultiplier
  return round(durationSec * drainRate)
}

function routeDurationSec(
  situation: MissionSituation,
  drone: DroneState,
  route: readonly Waypoint[],
  includeRecovery: boolean,
): number {
  const recovery = recoveryPosition(situation.scenario, drone.id)
  let from = drone.position
  let distanceM = 0
  let dwellSec = 0
  for (const waypoint of route) {
    distanceM += haversineDistanceM(from, waypoint.position)
    dwellSec += waypoint.dwellTimeSec ?? 0
    from = waypoint.position
  }
  if (includeRecovery) distanceM += haversineDistanceM(from, recovery)

  const platform = platformForDrone(situation.scenario, drone.id)
  const speedMultiplier = situation.weather?.speedCapMultiplier ?? 1
  const cruiseSpeedMs = Math.max(1, platform.maxSpeedMs * speedMultiplier * CRUISE_SPEED_FACTOR)
  return distanceM / cruiseSpeedMs + dwellSec
}

function scoreCandidate(
  situation: MissionSituation,
  drone: DroneState,
  objective: TacticalObjective,
  route: readonly Waypoint[],
  action: TacticalAction,
): TacticalScoreBreakdown {
  const remainingRoute = (situation.droneWaypoints[drone.id] ?? []).slice(drone.currentWaypointIndex)
  const continuityDistanceM = remainingRoute.length > 0
    ? Math.min(...remainingRoute.map((waypoint) => haversineDistanceM(waypoint.position, objective.position)))
    : 0
  const sensorFactor = objective.kind === 'contact'
    ? situation.weather?.sensorConfidenceFactor ?? 1
    : 1
  const valueGain = round(objective.value * sensorFactor * (1 - objective.coverage * 0.45))
  const transitSec = action === 'hold_station' ? 0 : routeDurationSec(situation, drone, route, false)
  const transitCost = round(Math.min(35, transitSec / 10))
  const riskPenalty = round(
    (drone.signalDbm < -85 ? 12 : drone.signalDbm < -75 ? 5 : 0)
    + (drone.conflictFlag ? 10 : 0)
    + (1 - (situation.weather?.commsReliabilityFactor ?? 1)) * 8
    + (situation.weather?.activeHazards.length ?? 0) * 1.5,
  )
  const continuityPenalty = action === 'hold_station'
    ? 0
    : round(Math.min(18, continuityDistanceM / 100))
  return {
    valueGain,
    transitCost,
    riskPenalty,
    continuityPenalty,
    redundancyPenalty: 0,
    total: round(valueGain - transitCost - riskPenalty - continuityPenalty),
  }
}

function greedyAssignments(
  drones: readonly DroneState[],
  candidatesByDrone: Readonly<Record<string, readonly TacticalCandidate[]>>,
): Map<string, TacticalCandidate> {
  const selected = new Map<string, TacticalCandidate>()
  const objectiveCounts = new Map<string, number>()
  const remaining = new Set(drones.map((drone) => drone.id))

  while (remaining.size > 0) {
    const available = [...remaining].flatMap((droneId) => candidatesByDrone[droneId] ?? [])
    const best = available.sort((a, b) => {
      const aAdjusted = a.score.total - (objectiveCounts.get(a.objectiveId) ?? 0) * REDUNDANCY_PENALTY
      const bAdjusted = b.score.total - (objectiveCounts.get(b.objectiveId) ?? 0) * REDUNDANCY_PENALTY
      return bAdjusted - aAdjusted || a.id.localeCompare(b.id)
    })[0]
    if (!best) break
    selected.set(best.droneId, best)
    remaining.delete(best.droneId)
    objectiveCounts.set(best.objectiveId, (objectiveCounts.get(best.objectiveId) ?? 0) + 1)
  }

  return selected
}

/** Exactly two deterministic pairwise-swap passes; bounded independently of fleet size. */
function improveAssignments(
  selected: Map<string, TacticalCandidate>,
  candidatesByDrone: Readonly<Record<string, readonly TacticalCandidate[]>>,
): void {
  const droneIds = [...selected.keys()].sort()
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < droneIds.length; i++) {
      for (let j = i + 1; j < droneIds.length; j++) {
        const aId = droneIds[i]
        const bId = droneIds[j]
        const aCandidates = [...(candidatesByDrone[aId] ?? [])].sort((a, b) => a.id.localeCompare(b.id))
        const bCandidates = [...(candidatesByDrone[bId] ?? [])].sort((a, b) => a.id.localeCompare(b.id))
        let bestTotal = fleetAdjustedTotal(selected)
        let bestPair: [TacticalCandidate, TacticalCandidate] | null = null

        for (const aCandidate of aCandidates) {
          for (const bCandidate of bCandidates) {
            const trial = new Map(selected)
            trial.set(aId, aCandidate)
            trial.set(bId, bCandidate)
            const trialTotal = fleetAdjustedTotal(trial)
            if (trialTotal > bestTotal) {
              bestTotal = trialTotal
              bestPair = [aCandidate, bCandidate]
            }
          }
        }

        if (bestPair) {
          selected.set(aId, bestPair[0])
          selected.set(bId, bestPair[1])
        }
      }
    }
  }
}

function fleetAdjustedTotal(selected: ReadonlyMap<string, TacticalCandidate>): number {
  const objectiveCounts = new Map<string, number>()
  let total = 0
  selected.forEach((candidate) => {
    total += candidate.score.total
    objectiveCounts.set(candidate.objectiveId, (objectiveCounts.get(candidate.objectiveId) ?? 0) + 1)
  })
  objectiveCounts.forEach((count) => {
    total -= Math.max(0, count - 1) * REDUNDANCY_PENALTY
  })
  return round(total)
}

function finalizeAssignments(selected: ReadonlyMap<string, TacticalCandidate>): FleetRetaskAssignment[] {
  const objectiveCounts = new Map<string, number>()
  selected.forEach((candidate) => {
    objectiveCounts.set(candidate.objectiveId, (objectiveCounts.get(candidate.objectiveId) ?? 0) + 1)
  })

  return [...selected.values()]
    .sort((a, b) => a.droneId.localeCompare(b.droneId))
    .map((candidate, index) => {
      const count = objectiveCounts.get(candidate.objectiveId) ?? 1
      const redundancy = round(-REDUNDANCY_PENALTY * (count - 1) / count)
      return {
        ...candidate,
        route: candidate.route.map(cloneWaypoint),
        score: {
          ...candidate.score,
          redundancyPenalty: -redundancy,
          total: round(candidate.score.total + redundancy),
        },
        rank: index + 1,
      }
    })
}

function estimateCoverage(
  objectivePosition: LatLng,
  drones: readonly DroneState[],
  positionHistory: Readonly<Record<string, readonly LatLng[]>>,
  scenario: ScenarioConfig,
): number {
  const pods = drones.map((drone) => {
    const history = positionHistory[drone.id] ?? []
    let effortM = 0
    for (let index = 1; index < history.length; index++) {
      const from = history[index - 1]
      const to = history[index]
      if (
        haversineDistanceM(from, objectivePosition) <= COVERAGE_RADIUS_M
        || haversineDistanceM(to, objectivePosition) <= COVERAGE_RADIUS_M
      ) {
        effortM += haversineDistanceM(from, to)
      }
    }
    const platform = platformForDrone(scenario, drone.id)
    const detectionRadiusM = platformTaskRanges(platform.thermal, 0.5)?.detectionM ?? DEFAULT_DETECTION_RADIUS_M
    return probabilityOfDetection({
      detectionRadiusM,
      trackLengthM: effortM,
      sectorAreaM2: Math.PI * COVERAGE_RADIUS_M ** 2,
    }).pod
  })
  return round(cumulativePod(pods))
}

function objectiveAffinity(action: RoutePattern, objective: TacticalObjective): number {
  const type = objective.featureType
  switch (action) {
    case 'deep_scan':
      return objective.kind === 'contact' ? 100 : ['last_known', 'search_sector'].includes(type ?? '') ? 80 : 30
    case 'street_sweep':
      return ['street', 'alley', 'shoreline', 'bridge'].includes(type ?? '') ? 100 : type === 'search_sector' ? 70 : 20
    case 'perimeter_orbit':
      return ['perimeter', 'fireline', 'gate', 'hazard'].includes(type ?? '') ? 100 : 25
    case 'expanding_search':
      return objective.kind === 'contact' || ['last_known', 'search_sector'].includes(type ?? '') ? 95 : 35
    case 'standoff_observe':
      return ['relay', 'standoff', 'hazard'].includes(type ?? '') ? 100 : objective.kind === 'dispatch' ? 70 : 20
    case 'route_lkl':
      return objective.kind === 'contact' || type === 'last_known' ? 100 : objective.kind === 'dispatch' ? 75 : 25
  }
}

function compareObjectives(a: TacticalObjective, b: TacticalObjective): number {
  return b.value - a.value || priorityRank(b.priority) - priorityRank(a.priority) || a.id.localeCompare(b.id)
}

function isActionableDispatch(entry: DispatchFeedEntry): boolean {
  return entry.category === 'operator_task'
    || entry.priority === 'urgent'
    || entry.priority === 'critical'
}

function authoredDispatchEntries(scenario: ScenarioConfig): DispatchFeedEntry[] {
  return (scenario.dispatchTimeline ?? []).map((entry) => ({
    ...entry,
    kind: 'authored',
    category: entry.category ?? 'dispatch',
  }))
}

function contactRecencyValue(currentTick: number, contactTick: number): number {
  const ageTicks = Math.max(0, currentTick - contactTick)
  return round(15 * Math.max(0, 1 - ageTicks / 1_200))
}

function firstScenarioCue(scenario: ScenarioConfig): LatLng {
  return [...(scenario.operationalFeatures ?? [])].sort(byId)[0]?.points[0]
    ?? scenario.heatSources.slice().sort(byId)[0]?.position
    ?? scenario.waypoints[0]?.position
    ?? scenario.startPosition
}

function recoveryPosition(scenario: ScenarioConfig, droneId: string): LatLng {
  const recharge = rechargeStationsForDrone(scenario, droneId)
  return recoverySiteForDrone(scenario, droneId)?.position
    ?? recharge[recharge.length - 1]?.position
    ?? scenario.startPosition
}

function defaultAltitude(scenario: ScenarioConfig, droneId: string): number {
  return scenario.perDroneWaypoints?.[droneId]?.[0]?.altitudeFt ?? scenario.waypoints[0]?.altitudeFt ?? 120
}

function priorityForFeature(type: OperationalFeatureType): DispatchPriority {
  if (['hazard', 'last_known', 'fireline'].includes(type)) return 'urgent'
  if (['search_sector', 'gate', 'relay', 'standoff'].includes(type)) return 'advisory'
  return 'routine'
}

function featureValue(type: OperationalFeatureType): number {
  if (['last_known', 'hazard', 'fireline'].includes(type)) return 62
  if (['search_sector', 'gate', 'relay', 'standoff', 'perimeter'].includes(type)) return 50
  return 40
}

function priorityRank(priority: DispatchPriority): number {
  switch (priority) {
    case 'critical': return 4
    case 'urgent': return 3
    case 'advisory': return 2
    case 'routine': return 1
  }
}

function cloneDrone(drone: DroneState): DroneState {
  return {
    ...drone,
    position: clonePosition(drone.position),
    lastKnownPosition: drone.lastKnownPosition ? clonePosition(drone.lastKnownPosition) : undefined,
    geofenceBreach: drone.geofenceBreach ? { ...drone.geofenceBreach } : undefined,
  }
}

function canonicalScenario(scenario: ScenarioConfig): ScenarioConfig {
  return {
    ...scenario,
    operationalFeatures: scenario.operationalFeatures
      ? [...scenario.operationalFeatures].sort(byId).map((feature) => ({
          ...feature,
          points: feature.points.map(clonePosition),
        }))
      : undefined,
    rechargeStations: scenario.rechargeStations
      ? [...scenario.rechargeStations].sort(byId).map((station) => ({
          ...station,
          position: clonePosition(station.position),
        }))
      : undefined,
    geofences: [...scenario.geofences].sort(byId).map((geofence) => ({
      ...geofence,
      polygon: geofence.polygon.map(clonePosition),
    })),
    heatSources: [...scenario.heatSources].sort(byId).map((source) => ({
      ...source,
      position: clonePosition(source.position),
    })),
    dispatchTimeline: scenario.dispatchTimeline
      ? [...scenario.dispatchTimeline].sort(byId).map((entry) => ({ ...entry }))
      : undefined,
  }
}

function clonePositionHistory(
  history: MissionSituationInput['positionHistory'],
): Record<string, readonly LatLng[]> {
  return Object.fromEntries(
    Object.entries(history ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([droneId, positions]) => [droneId, positions.map(clonePosition)]),
  )
}

function cloneWaypointMap(
  routes: MissionSituationInput['droneWaypoints'],
): Record<string, readonly Waypoint[]> {
  return Object.fromEntries(
    Object.entries(routes ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([droneId, waypoints]) => [droneId, waypoints.map(cloneWaypoint)]),
  )
}

function dedupeObjectives(objectives: readonly TacticalObjective[]): TacticalObjective[] {
  const seen = new Set<string>()
  return objectives.filter((objective) => {
    if (seen.has(objective.id)) return false
    seen.add(objective.id)
    return true
  })
}

function dedupeCandidates(candidates: readonly TacticalCandidate[]): TacticalCandidate[] {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    if (seen.has(candidate.id)) return false
    seen.add(candidate.id)
    return true
  })
}

function clonePosition(position: LatLng): LatLng {
  return { lat: position.lat, lng: position.lng }
}

function cloneWaypoint(waypoint: Waypoint): Waypoint {
  return { ...waypoint, position: clonePosition(waypoint.position) }
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id.localeCompare(b.id)
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function round(value: number): number {
  return Number(value.toFixed(4))
}
