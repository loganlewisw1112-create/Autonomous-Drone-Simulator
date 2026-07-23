import { buildMissionProgress, type MissionObjectiveProgress } from '@/sim/mission/missionObjectives'
import { scoreLane, type LaneScore } from '@/sim/mission/laneScoring'
import { laneForScenario } from '@/scenarios/nistLanes'
import { batteryReservePctForDrone } from '@/sim/mission/rechargeStations'
import { verifyChain } from '@/utils/chainOfCustody'
import type {
  DroneState,
  GroundUnitState,
  LatLng,
  MissionEvent,
  MissionMetrics,
  ScenarioConfig,
  ThermalContactState,
} from '@/types'

export type AssessmentSeverity = 'none' | 'minor' | 'major' | 'critical'
export type AssessmentBand = 'A' | 'B' | 'C' | 'D' | 'F'
export type LifeSafetyFindingCode =
  | 'CONTACT_UNACTIONED'
  | 'HOLD_ABANDONED'
  | 'THIRD_PARTY_RISK'
  | 'CONTACT_RESPONSE_SLOW'
  | 'PROPERTY_BEFORE_LIFE'
  | 'UNCONTROLLED_DESCENT'
  | 'FLEW_INTO_FORCE_RTB'
  | 'GROUND_UNIT_LATENCY'

export interface AssessmentFinding {
  code: LifeSafetyFindingCode
  severity: Exclude<AssessmentSeverity, 'none'>
  message: string
  droneId?: string
  sourceId?: string
  tick?: number
}

export interface AssessmentIntervention {
  actorId: string
  droneId: string
  eventType: MissionEvent['eventType']
  tick: number
  command?: string
}

export interface LifeSafetyAssessment {
  status: 'pass' | 'fail'
  severity: AssessmentSeverity
  cap: 100 | 79 | 59 | 39
  findings: AssessmentFinding[]
}

export interface MissionAssessment {
  progressPercent: number
  objectives: MissionObjectiveProgress[]
  lifeSafety: LifeSafetyAssessment
  tier1: number
  tier2: number
  uncappedTotal: number
  total: number
  band: AssessmentBand
  interventions: AssessmentIntervention[]
  /**
   * NIST lane result (WP-9), present only on lane trials.
   *
   * Reported ALONGSIDE `total`, never folded into it. The two are different kinds of claim: the
   * mission score is this project's own rubric and stays advisory, while the lane score is a
   * published, standards-referenced number. Averaging them would contaminate the one figure that
   * can survive a training officer's scrutiny.
   */
  nistLane?: LaneScore
}

export interface MissionAssessmentInput {
  scenario: ScenarioConfig
  drones: readonly DroneState[]
  thermalContacts: readonly ThermalContactState[]
  groundUnits?: readonly GroundUnitState[]
  events: readonly MissionEvent[]
  metrics: MissionMetrics
  positionHistory?: Readonly<Record<string, readonly LatLng[]>>
  elapsedSec: number
  isFinal?: boolean
  /** Events issued by an actor id with this prefix are interventions, never participant credit. */
  interventionActorPrefix: string
  evidenceVerified?: boolean
}

const TICKS_PER_SEC = 20
const RESPONSE_MAJOR_SEC = 120
const CONTACT_CRITICAL_SEC = 300
const GROUND_UNIT_MINOR_SEC = 180

const SEVERITY_RANK: Record<AssessmentSeverity, number> = { none: 0, minor: 1, major: 2, critical: 3 }
const CAP_BY_SEVERITY: Record<AssessmentSeverity, 100 | 79 | 59 | 39> = {
  none: 100,
  minor: 79,
  major: 59,
  critical: 39,
}

export function buildMissionAssessment(input: MissionAssessmentInput): MissionAssessment {
  const interventions = input.events
    .filter((event) => isIntervention(event, input.interventionActorPrefix))
    .map((event) => ({
      actorId: event.operatorId,
      droneId: event.droneId,
      eventType: event.eventType,
      tick: event.tick,
      command: typeof event.payload.command === 'string' ? event.payload.command : undefined,
    }))
  const participantEvents = input.events.filter((event) => !isIntervention(event, input.interventionActorPrefix))
  const interventionSources = new Set(input.events
    .filter((event) => isIntervention(event, input.interventionActorPrefix))
    .map(eventSourceId)
    .filter((value): value is string => value !== null))
  const participantSources = new Set(participantEvents.map(eventSourceId).filter((value): value is string => value !== null))
  const participantContacts = input.thermalContacts.map((contact) => (
    interventionSources.has(contact.sourceId) && !participantSources.has(contact.sourceId)
      ? { ...contact, action: undefined, resolvedAt: undefined, groundUnitId: undefined }
      : { ...contact }
  ))

  const progress = buildMissionProgress({
    scenario: input.scenario,
    drones: input.drones,
    thermalContacts: participantContacts,
    events: participantEvents,
    positionHistory: input.positionHistory,
    elapsedSec: input.elapsedSec,
  })
  const findings = deriveFindings(input, participantEvents, participantContacts)
  const severity = findings.reduce<AssessmentSeverity>((worst, finding) => (
    SEVERITY_RANK[finding.severity] > SEVERITY_RANK[worst] ? finding.severity : worst
  ), 'none')
  const cap = CAP_BY_SEVERITY[severity]
  const tier1 = scoreIncidentStabilization(progress.objectives, findings, input.metrics)
  const tier2 = scoreResourceStewardship(input, progress.objectives)
  const uncappedTotal = clampScore(tier1 + tier2, 100)
  const total = Math.min(uncappedTotal, cap)

  // Lane scoring folds the participant's own evidence events, so an instructor intervention
  // cannot inflate a standards-referenced score.
  const lane = laneForScenario(input.scenario.id)
  const nistLane = lane ? scoreLane(lane, participantEvents, input.elapsedSec) : undefined

  return {
    progressPercent: progress.percent,
    objectives: progress.objectives,
    lifeSafety: { status: severity === 'none' ? 'pass' : 'fail', severity, cap, findings },
    tier1,
    tier2,
    uncappedTotal,
    total,
    band: bandFor(total),
    interventions,
    ...(nistLane ? { nistLane } : {}),
  }
}

function deriveFindings(
  input: MissionAssessmentInput,
  events: readonly MissionEvent[],
  contacts: readonly ThermalContactState[],
): AssessmentFinding[] {
  const findings: AssessmentFinding[] = []
  const maxTick = Math.max(Math.round(input.elapsedSec * TICKS_PER_SEC), ...events.map((event) => event.tick), 0)
  const actionTickBySource = new Map<string, number>()
  for (const event of events) {
    const sourceId = eventSourceId(event)
    if (!sourceId || !isContactAction(event)) continue
    const prior = actionTickBySource.get(sourceId)
    if (prior === undefined || event.tick < prior) actionTickBySource.set(sourceId, event.tick)
  }

  for (const contact of [...contacts].sort((a, b) => a.sourceId.localeCompare(b.sourceId))) {
    if (contact.confidence < 0.75) continue
    const actionTick = actionTickBySource.get(contact.sourceId)
    const actioned = contact.action !== undefined || actionTick !== undefined
    const ageSec = Math.max(0, maxTick - contact.tick) / TICKS_PER_SEC
    if (!actioned && (input.isFinal || ageSec >= CONTACT_CRITICAL_SEC)) {
      findings.push({
        code: 'CONTACT_UNACTIONED', severity: 'critical', sourceId: contact.sourceId, tick: contact.tick,
        message: `High-confidence contact ${contact.sourceId} was not actioned.`,
      })
    } else if (actionTick !== undefined && (actionTick - contact.tick) / TICKS_PER_SEC > RESPONSE_MAJOR_SEC) {
      findings.push({
        code: 'CONTACT_RESPONSE_SLOW', severity: 'major', sourceId: contact.sourceId, tick: actionTick,
        message: `Response to contact ${contact.sourceId} exceeded ${RESPONSE_MAJOR_SEC} seconds.`,
      })
    }
  }

  for (const hold of events.filter((event) => event.eventType === 'state_change' && event.payload.to === 'thermal_hold')) {
    const abandonment = events.find((event) => event.droneId === hold.droneId && event.tick > hold.tick
      && event.eventType === 'operator_command'
      && ['resume', 'rtb', 'set_route'].includes(String(event.payload.command)))
    if (!abandonment) continue
    const actionBeforeAbandonment = events.some((event) => event.tick >= hold.tick && event.tick <= abandonment.tick && isContactAction(event))
    if (actionBeforeAbandonment) continue
    const sourceId = contacts
      .filter((contact) => contact.confidence >= 0.75 && contact.tick <= hold.tick)
      .sort((a, b) => b.tick - a.tick || a.sourceId.localeCompare(b.sourceId))[0]?.sourceId
    findings.push({
      code: 'HOLD_ABANDONED', severity: 'critical', droneId: hold.droneId, sourceId, tick: abandonment.tick,
      message: `${hold.droneId} left thermal hold before the contact was actioned.`,
    })
  }

  const featureById = new Map((input.scenario.operationalFeatures ?? []).map((feature) => [feature.id, feature]))
  const lifeFeatureIds = new Set((input.scenario.operationalFeatures ?? [])
    .filter((feature) => feature.type === 'last_known' || feature.type === 'search_sector')
    .map((feature) => feature.id))
  const propertyServices = events.filter((event) => {
    if (event.eventType !== 'operator_command' || typeof event.payload.objectiveId !== 'string') return false
    const match = /^feature:(.+)$/.exec(event.payload.objectiveId)
    return !!match && !lifeFeatureIds.has(match[1]) && featureById.has(match[1])
  })
  for (const service of propertyServices) {
    const openContact = contacts.some((contact) => contact.confidence >= 0.75 && contact.tick <= service.tick
      && (actionTickBySource.get(contact.sourceId) ?? Number.POSITIVE_INFINITY) > service.tick)
    const unservicedLifeFeature = [...lifeFeatureIds].some((featureId) => !events.some((event) => (
      event.tick <= service.tick && event.eventType === 'operator_command'
      && event.payload.objectiveId === `feature:${featureId}`
    )))
    if (!openContact && !unservicedLifeFeature) continue
    findings.push({
      code: 'PROPERTY_BEFORE_LIFE', severity: 'major', droneId: service.droneId, tick: service.tick,
      message: 'A lower-priority feature was serviced while a life-safety objective remained open.',
    })
  }

  const criticalGeofences = new Set(input.scenario.geofences.filter((zone) => zone.lifeCritical).map((zone) => zone.id))
  for (const event of events) {
    if (event.eventType === 'geofence_breach' && typeof event.payload.geofenceId === 'string'
      && criticalGeofences.has(event.payload.geofenceId)) {
      findings.push({
        code: 'THIRD_PARTY_RISK', severity: 'critical', droneId: event.droneId, tick: event.tick,
        message: `Aircraft entered life-critical zone ${event.payload.geofenceId}.`,
      })
    }
    if (event.eventType === 'weather_divert') {
      const laterRoute = events.find((candidate) => candidate.tick >= event.tick
        && candidate.droneId === event.droneId && candidate.eventType === 'operator_command'
        && ['set_route', 'append_waypoint'].includes(String(candidate.payload.command)))
      if (laterRoute) findings.push({
        code: 'FLEW_INTO_FORCE_RTB', severity: 'major', droneId: event.droneId, tick: laterRoute.tick,
        message: 'Route command was issued after weather forced return-to-base.',
      })
    }
  }

  for (const drone of input.drones) {
    if (drone.missionState !== 'emergency' && drone.missionState !== 'unrecoverable_sim') continue
    const emergencyTick = events.find((event) => event.droneId === drone.id && event.eventType === 'emergency_land')?.tick ?? maxTick
    const priorRtb = events.some((event) => event.droneId === drone.id && event.tick < emergencyTick
      && event.eventType === 'operator_command' && event.payload.command === 'rtb')
    if (!priorRtb) findings.push({
      code: 'UNCONTROLLED_DESCENT', severity: 'major', droneId: drone.id, tick: emergencyTick,
      message: 'Aircraft reached emergency descent without a prior return-to-base command.',
    })
  }

  const dispatchTickBySource = new Map<string, number>()
  for (const event of events) {
    if (event.eventType !== 'ground_unit_dispatched') continue
    const sourceId = eventSourceId(event)
    if (sourceId) dispatchTickBySource.set(sourceId, event.tick)
  }
  for (const event of events) {
    if (event.eventType !== 'ground_unit_on_scene') continue
    const sourceId = eventSourceId(event)
    const dispatchTick = sourceId ? dispatchTickBySource.get(sourceId) : undefined
    if (sourceId && dispatchTick !== undefined && (event.tick - dispatchTick) / TICKS_PER_SEC > GROUND_UNIT_MINOR_SEC) {
      findings.push({
        code: 'GROUND_UNIT_LATENCY', severity: 'minor', sourceId, tick: event.tick,
        message: `Ground-unit response to ${sourceId} exceeded ${GROUND_UNIT_MINOR_SEC} seconds.`,
      })
    }
  }

  return uniqueFindings(findings)
}

function scoreIncidentStabilization(
  objectives: readonly MissionObjectiveProgress[],
  findings: readonly AssessmentFinding[],
  metrics: MissionMetrics,
): number {
  const operational = objectives.filter((objective) => objective.kind !== 'fleet_recovery')
  const completion = operational.length > 0
    ? operational.reduce((sum, objective) => sum + objective.completion, 0) / operational.length
    : 1
  const airspace = metrics.geofenceBreaches === 0 ? 10 : 0
  const timely = findings.some((finding) => finding.code === 'CONTACT_RESPONSE_SLOW' || finding.code === 'GROUND_UNIT_LATENCY') ? 0 : 5
  return clampScore(Math.round(completion * 45) + airspace + timely, 60)
}

function scoreResourceStewardship(
  input: MissionAssessmentInput,
  objectives: readonly MissionObjectiveProgress[],
): number {
  const recovery = objectives.find((objective) => objective.kind === 'fleet_recovery')?.completion ?? 0
  const reserve = input.drones.length === 0 ? 0 : Math.min(...input.drones.map((drone) => (
    drone.batteryPct / Math.max(1, batteryReservePctForDrone(input.scenario, drone.id))
  )))
  const usefulProgress = objectives.length === 0 ? 0
    : objectives.reduce((sum, objective) => sum + objective.completion, 0) / objectives.length
  const evidenceOk = input.evidenceVerified ?? (input.events.length > 0 && verifyChain([...input.events]))
  return clampScore(
    Math.round(recovery * 15)
    + Math.round(Math.min(1, reserve) * 10)
    + Math.round(usefulProgress * 5)
    + (evidenceOk ? 10 : 0),
    40,
  )
}

function isIntervention(event: MissionEvent, prefix: string): boolean {
  return prefix.length > 0 && event.operatorId.startsWith(prefix)
}

function eventSourceId(event: MissionEvent): string | null {
  for (const key of ['sourceId', 'thermalId', 'targetThermalId']) {
    const value = event.payload[key]
    if (typeof value === 'string') return value
  }
  return null
}

function isContactAction(event: MissionEvent): boolean {
  return event.eventType === 'ground_unit_dispatched'
    || (event.eventType === 'operator_command' && eventSourceId(event) !== null)
}

function uniqueFindings(findings: readonly AssessmentFinding[]): AssessmentFinding[] {
  const seen = new Set<string>()
  return [...findings]
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
      || a.code.localeCompare(b.code) || (a.sourceId ?? a.droneId ?? '').localeCompare(b.sourceId ?? b.droneId ?? ''))
    .filter((finding) => {
      const key = `${finding.code}:${finding.sourceId ?? finding.droneId ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function bandFor(total: number): AssessmentBand {
  if (total >= 90) return 'A'
  if (total >= 80) return 'B'
  if (total >= 70) return 'C'
  if (total >= 60) return 'D'
  return 'F'
}

function clampScore(value: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(Number.isFinite(value) ? value : 0)))
}
