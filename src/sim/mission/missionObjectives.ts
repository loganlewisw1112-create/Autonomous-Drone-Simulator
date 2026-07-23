import { buildSectorPodReport } from '@/sim/sensors/podReporting'
import type { ThermalWeather } from '@/sim/sensors/thermalRange'
import type { OcclusionService } from '@/sim/terrain/OcclusionService'
import type {
  DroneState,
  LatLng,
  MissionEvent,
  MissionObjective,
  MissionObjectiveKind,
  ScenarioConfig,
  ThermalContactState,
} from '@/types'
import { haversineDistanceM } from '@/utils/geometry'

const DEFAULT_SECTOR_TARGET = 0.8
const FEATURE_VISIT_RADIUS_M = 75

const DEFAULT_WEIGHTS: Record<MissionObjectiveKind, number> = {
  contact_resolution: 0.30,
  sector_coverage: 0.25,
  tasking_compliance: 0.15,
  containment: 0.15,
  fleet_recovery: 0.15,
}

export interface MissionObjectiveProgress extends MissionObjective {
  completion: number
  completed: number
  total: number
}

export interface MissionProgressInput {
  scenario: ScenarioConfig
  drones?: readonly DroneState[]
  thermalContacts?: readonly ThermalContactState[]
  events?: readonly MissionEvent[]
  positionHistory?: Readonly<Record<string, readonly LatLng[]>>
  elapsedSec?: number
  /** WP-6: shortens the detection radius sector POD is scored against. Omitted ⇒ clear air. */
  weather?: ThermalWeather | null
  /** WP-6: terrain/building occlusion. Omitted ⇒ the swept swath is assumed visible. */
  occlusion?: OcclusionService
}

export interface MissionProgress {
  percent: number
  completion: number
  objectives: MissionObjectiveProgress[]
}

/** Returns authored mission definition or a deterministic fallback for legacy scenarios. */
export function resolveMissionObjectives(scenario: ScenarioConfig): MissionObjective[] {
  if (scenario.missionObjectives?.length) {
    return normalizeObjectives(scenario.missionObjectives)
  }

  const objectives: MissionObjective[] = []
  if (scenario.heatSources.length > 0) {
    objectives.push(defaultObjective('contact_resolution', 'Resolve detected contacts'))
  }
  if ((scenario.searchArea?.length ?? 0) >= 3) {
    objectives.push(defaultObjective('sector_coverage', 'Complete search-area coverage', DEFAULT_SECTOR_TARGET))
  }
  const taskIds = (scenario.dispatchTimeline ?? [])
    .filter((entry) => entry.category === 'operator_task')
    .map((entry) => entry.id)
    .sort()
  if (taskIds.length > 0) {
    objectives.push({ ...defaultObjective('tasking_compliance', 'Complete assigned tasking'), sourceIds: taskIds })
  }
  const containmentIds = (scenario.operationalFeatures ?? [])
    .filter((feature) => feature.type === 'perimeter' || feature.type === 'gate')
    .map((feature) => feature.id)
    .sort()
  if (containmentIds.length > 0) {
    objectives.push({ ...defaultObjective('containment', 'Establish containment'), sourceIds: containmentIds })
  }
  objectives.push(defaultObjective('fleet_recovery', 'Recover the launched fleet'))
  return normalizeObjectives(objectives)
}

/** Computes objective-based progress; route replacement never changes the denominator. */
export function buildMissionProgress(input: MissionProgressInput): MissionProgress {
  const objectives = resolveMissionObjectives(input.scenario)
  const progress = objectives.map((objective) => evaluateObjective(objective, input))
  const completion = clamp01(progress.reduce((sum, objective) => sum + objective.weight * objective.completion, 0))
  return { percent: Math.round(completion * 100), completion, objectives: progress }
}

export function objectiveWeightForKind(scenario: ScenarioConfig, kind: MissionObjectiveKind): number | null {
  const matches = resolveMissionObjectives(scenario).filter((objective) => objective.kind === kind)
  if (matches.length === 0) return null
  return matches.reduce((sum, objective) => sum + objective.weight, 0)
}

function evaluateObjective(objective: MissionObjective, input: MissionProgressInput): MissionObjectiveProgress {
  switch (objective.kind) {
    case 'contact_resolution': return contactProgress(objective, input)
    case 'sector_coverage': return sectorProgress(objective, input)
    case 'tasking_compliance': return taskingProgress(objective, input)
    case 'containment': return containmentProgress(objective, input)
    case 'fleet_recovery': return recoveryProgress(objective, input)
  }
}

function contactProgress(objective: MissionObjective, input: MissionProgressInput): MissionObjectiveProgress {
  const allowed = objective.sourceIds ? new Set(objective.sourceIds) : null
  const sourceIds = input.scenario.heatSources.map((source) => source.id).filter((id) => !allowed || allowed.has(id))
  const contacts = new Map((input.thermalContacts ?? []).map((contact) => [contact.sourceId, contact]))
  const completed = sourceIds.filter((id) => {
    const contact = contacts.get(id)
    return contact?.action !== undefined
  }).length
  return withCompletion(objective, completed, sourceIds.length)
}

/**
 * Sector coverage scored as cumulative POD (WP-6), not as area swept.
 *
 * Delegates wholly to `buildSectorPodReport` so the objective percentage and the READY-tab POD
 * are the same number computed once — an objective that disagreed with the panel reporting it
 * would be worse than either alone. A null cumulative POD means no drone on task has published
 * optics; that scores 0 rather than inventing a detection radius to score against.
 */
function sectorProgress(objective: MissionObjective, input: MissionProgressInput): MissionObjectiveProgress {
  const polygon = input.scenario.searchArea ?? []
  if (polygon.length < 3) return withCompletion(objective, 0, 1)
  const report = buildSectorPodReport({
    scenario: input.scenario,
    drones: input.drones ?? [],
    positionHistory: input.positionHistory ?? {},
    weather: input.weather ?? null,
    occlusion: input.occlusion,
  })
  const pod = report.cumulativePod ?? 0
  const target = positiveTarget(objective.target, DEFAULT_SECTOR_TARGET)
  return { ...objective, completion: clamp01(pod / target), completed: pod, total: target }
}

function taskingProgress(objective: MissionObjective, input: MissionProgressInput): MissionObjectiveProgress {
  const allowed = objective.sourceIds ? new Set(objective.sourceIds) : null
  const due = (input.scenario.dispatchTimeline ?? [])
    .filter((entry) => entry.category === 'operator_task')
    .filter((entry) => entry.timeSec <= (input.elapsedSec ?? 0))
    .filter((entry) => !allowed || allowed.has(entry.id))
  const serviced = new Set<string>()
  for (const event of input.events ?? []) {
    if (event.eventType !== 'operator_command') continue
    const ids = [event.payload.taskId, event.payload.dispatchId, event.payload.objectiveId]
      .filter((value): value is string => typeof value === 'string')
    for (const dueEntry of due) {
      if (ids.some((id) => id === dueEntry.id || id === `dispatch:${dueEntry.id}`)) serviced.add(dueEntry.id)
    }
  }
  return withCompletion(objective, serviced.size, due.length)
}

function containmentProgress(objective: MissionObjective, input: MissionProgressInput): MissionObjectiveProgress {
  const allowed = objective.sourceIds ? new Set(objective.sourceIds) : null
  const features = (input.scenario.operationalFeatures ?? [])
    .filter((feature) => feature.type === 'perimeter' || feature.type === 'gate')
    .filter((feature) => !allowed || allowed.has(feature.id))
  const tracks = Object.values(input.positionHistory ?? {})
  const completed = features.filter((feature) => feature.points.some((point) =>
    tracks.some((track) => track.some((sample) => haversineDistanceM(sample, point) <= FEATURE_VISIT_RADIUS_M)),
  )).length
  return withCompletion(objective, completed, features.length)
}

function recoveryProgress(objective: MissionObjective, input: MissionProgressInput): MissionObjectiveProgress {
  const droneIds = new Set((input.drones ?? []).map((drone) => drone.id))
  const launchedIds = new Set<string>()
  for (const event of input.events ?? []) {
    if ((event.eventType === 'sortie_launch' || event.eventType === 'mission_start') && droneIds.has(event.droneId)) {
      launchedIds.add(event.droneId)
    }
  }
  for (const drone of input.drones ?? []) {
    if (drone.launchTimeSec !== undefined || !['idle', 'preflight'].includes(drone.missionState)) launchedIds.add(drone.id)
  }
  const terminalSafe = new Set(['landed', 'recovered', 'remote_landed'])
  const completed = (input.drones ?? []).filter((drone) => launchedIds.has(drone.id) && terminalSafe.has(drone.missionState)).length
  return withCompletion(objective, completed, launchedIds.size)
}

function withCompletion(
  objective: MissionObjective,
  completed: number,
  total: number,
  emptyCompletion = 0,
): MissionObjectiveProgress {
  const ratio = total > 0 ? completed / total : emptyCompletion
  const target = positiveTarget(objective.target, 1)
  return { ...objective, completion: clamp01(ratio / target), completed, total }
}

function defaultObjective(kind: MissionObjectiveKind, label: string, target?: number): MissionObjective {
  return { id: kind, kind, label, weight: DEFAULT_WEIGHTS[kind], ...(target === undefined ? {} : { target }) }
}

function normalizeObjectives(source: readonly MissionObjective[]): MissionObjective[] {
  const sorted = [...source]
    .filter((objective) => objective.id.trim().length > 0)
    .sort((a, b) => a.id.localeCompare(b.id))
  if (sorted.length === 0) return [defaultObjective('fleet_recovery', 'Recover the launched fleet')]
  const positiveWeight = sorted.reduce((sum, objective) => sum + Math.max(0, objective.weight), 0)
  return sorted.map((objective) => ({
    ...objective,
    weight: positiveWeight > 0 ? Math.max(0, objective.weight) / positiveWeight : 1 / sorted.length,
    target: objective.target === undefined ? undefined : clamp01(objective.target),
    sourceIds: objective.sourceIds ? [...new Set(objective.sourceIds)].sort() : undefined,
  }))
}

function positiveTarget(value: number | undefined, fallback: number): number {
  return value !== undefined && value > 0 ? value : fallback
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
}
