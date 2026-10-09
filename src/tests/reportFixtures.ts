import { vi } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { buildAfterActionPackage } from '@/sim/demo/missionReport'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import { buildEvent, getGenesisHash } from '@/utils/chainOfCustody'
import type { LiveReportState } from '@/sim/demo/reportAdapters'
import type { StoredRunDetailV2, StoredRunSummary } from '@/account/types'
import type {
  AfterActionPackage,
  DroneState,
  EventType,
  FullMissionFrame,
  LatLng,
  MissionEvent,
  MissionMetrics,
  MissionReplaySession,
  ScenarioConfig,
  ScenarioVariantConfig,
  ThermalContactState,
} from '@/types'

export const FIXED_ISO = '2026-10-09T12:00:00.000Z'
const FIXED_MS = Date.parse(FIXED_ISO)

export const scenario: ScenarioConfig = ALL_SCENARIOS[0]

export const variant: ScenarioVariantConfig = {
  seed: 1, timeOfDay: 'day', season: 'spring', weatherSeverity: 0, commsDegradation: 0,
  thermalDensity: 1, batteryPressure: 0, terrainDifficulty: 0,
}

export const METRICS: MissionMetrics = {
  totalFlightDistanceM: 1200, waypointsReached: 3, conflictsDetected: 0, thermalContacts: 1,
  geofenceBreaches: 0, rtbTriggers: 0, recoveryDispatches: 1, groundUnitDispatch: 1,
}

export function makeDrone(id: string, patch: Partial<DroneState> = {}): DroneState {
  return {
    id, label: id.toUpperCase(), color: id === 'uav-01' ? '#00d4ff' : '#44ff88',
    position: { lat: scenario.startPosition.lat + 0.001, lng: scenario.startPosition.lng + 0.001 },
    altitudeFt: 100, headingDeg: 0, speedMs: 0, batteryPct: 60, signalDbm: -60,
    missionState: 'landed', currentWaypointIndex: 1, conflictFlag: false, geofenceBreachFlag: false,
    bvlosFlag: false, sortieCount: 1, ...patch,
  }
}

export type EventSpec = [tick: number, droneId: string, type: EventType, payload?: Record<string, unknown>]

/** Hash-chained events with a fixed wall-clock timestamp, so snapshots are deterministic. */
export function chainFrom(specs: EventSpec[]): MissionEvent[] {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(FIXED_MS)
  try {
    const events: MissionEvent[] = []
    let prev = getGenesisHash()
    for (const [tick, droneId, type, payload] of specs) {
      const event = buildEvent(prev, tick, droneId, 'operator-1', 'pic', type, payload ?? {})
      events.push(event)
      prev = event.hash
    }
    return events
  } finally {
    spy.mockRestore()
  }
}

export const EVENT_SPECS: EventSpec[] = [
  [0, 'system', 'preflight_complete'],
  [0, 'uav-01', 'mission_start'],
  [10, 'uav-01', 'waypoint_reached', { waypointId: 'wp-1' }],
  [20, 'uav-01', 'sortie_launch'],
  [20, 'uav-02', 'sortie_launch'],
  [400, 'uav-01', 'thermal_detection', { class: 'generic-person', sourceId: 'hs-1' }],
  [450, 'uav-01', 'operator_command', { command: 'hover' }],
  [800, 'uav-02', 'drone_recovery_requested', { roadAccess: 'none' }],
  [900, 'system', 'ground_unit_on_scene', { unitId: 'gu-1', thermalId: 'hs-1', etaWas: 60 }],
  [1000, 'uav-02', 'ground_unit_on_scene', { teamId: 'rt-1' }],
  [1100, 'uav-02', 'operator_command', { command: 'abort_recovery' }],
  [1200, 'uav-02', 'drone_recovered', { teamId: 'rt-1' }],
  [1400, 'system', 'mission_complete'],
]

export function makeContact(sourceId = 'hs-1'): ThermalContactState {
  return {
    sourceId, class: 'generic-person',
    position: { lat: scenario.startPosition.lat + 0.002, lng: scenario.startPosition.lng + 0.0015 },
    confidence: 80, weatherAdjustedConfidence: 80, tick: 400, selected: false, action: 'resolve',
  }
}

export function makeHistory(): Record<string, LatLng[]> {
  const s = scenario.startPosition
  return {
    'uav-01': [s, { lat: s.lat + 0.0005, lng: s.lng + 0.0004 }, { lat: s.lat + 0.001, lng: s.lng + 0.001 }],
    'uav-02': [s, { lat: s.lat - 0.0004, lng: s.lng + 0.0006 }, { lat: s.lat - 0.0008, lng: s.lng + 0.001 }],
  }
}

export interface Fixture {
  events: MissionEvent[]
  drones: DroneState[]
  contacts: ThermalContactState[]
  history: Record<string, LatLng[]>
  pkg: AfterActionPackage
  session: MissionReplaySession
  live: LiveReportState
  summary: StoredRunSummary
  detail: StoredRunDetailV2
}

export function makeFixture(specs: EventSpec[] = EVENT_SPECS): Fixture {
  const events = chainFrom(specs)
  const drones = [makeDrone('uav-01'), makeDrone('uav-02', { missionState: 'recovered' })]
  const contacts = [makeContact()]
  const history = makeHistory()
  const weather = getDefaultWeatherState(scenario.seed)
  const frame: FullMissionFrame = {
    tick: 1400, elapsedSec: 70, drones, thermalContacts: contacts, groundUnits: [], recoveryTeams: [],
    weatherState: weather, activeEventIds: [],
  }
  const session: MissionReplaySession = {
    scenarioId: scenario.id, scenarioVariant: variant, launchPlan: null, frames: [frame], events, metrics: METRICS,
    completedAt: FIXED_MS, completionReason: 'operator_ended', finalDrones: drones, finalThermalContacts: contacts,
    finalGroundUnits: [], finalRecoveryTeams: [], finalWeatherState: weather,
  }
  const live: LiveReportState = {
    scenario, scenarioVariant: variant, drones, metrics: METRICS, thermalContacts: contacts, groundUnits: [],
    recoveryTeams: [], events, elapsedSec: 70, positionHistory: history, replaySession: session,
  }
  const pkg: AfterActionPackage = {
    ...buildAfterActionPackage({
      scenario, scenarioVariant: variant, drones, metrics: METRICS, thermalContacts: contacts, events,
      elapsedSec: 70, replayFrameCount: 1, positionHistory: history, replaySession: session,
    }),
    generatedAt: FIXED_ISO,
  }
  const lastHash = events.at(-1)?.hash ?? null
  const summary: StoredRunSummary = {
    scenarioId: scenario.id, scenarioVariant: variant, completedAt: FIXED_MS, durationSec: 70, metrics: METRICS,
    eventCount: events.length, firstHash: events[0]?.hash ?? null, lastHash, chainVerified: true,
    droneOutcomes: drones.map((d) => ({ id: d.id, missionState: d.missionState, batteryPct: d.batteryPct })),
  }
  const detail = {
    scenario, scenarioVariant: variant, launchPlan: null, routes: {}, finalDrones: drones, events,
    evidence: { eventCount: events.length, firstHash: summary.firstHash, lastHash, verified: true },
    report: pkg, replayFrames: [frame], replayCoverage: { startSec: 0, endSec: 70, truncated: false },
    positionHistory: history, telemetryHistory: {},
  } as StoredRunDetailV2
  return { events, drones, contacts, history, pkg, session, live, summary, detail }
}
