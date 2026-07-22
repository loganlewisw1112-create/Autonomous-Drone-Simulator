import { create } from 'zustand'
import { devtools, subscribeWithSelector } from 'zustand/middleware'
import { buildOperatorCommandRoute, buildRouteSuggestions, validateOperatorRoute } from '@/sim/mission/operatorRoutes'
import { clampAdvisorRoute, hashMissionSituation, routesEqual } from '@/sim/mission/fleetRetaskApply'
import { getMissionSafetyOverride } from '@/sim/mission/MissionManager'
import { batteryReservePctForDrone } from '@/sim/mission/rechargeStations'
import { isRetaskable } from '@/sim/mission/retaskPolicy'
import { MAX_WAYPOINTS_PER_DRONE } from '@/sim/mission/routeLimits'
import { buildMissionSituation, planFleetRetask } from '@/sim/mission/tacticalAdvisor'
import { assessSiteReposition, type SiteRepositionResult } from '@/sim/mission/siteReposition'
import { clearAllSavedWaypointPlans, clearSavedDroneWaypointRoute, saveDroneWaypointRoute, saveFleetWaypointRoutes } from '@/sim/mission/waypointPersistence'
import { hashEvent } from '@/utils/chainOfCustody'
import { getActiveOperator } from '@/store/authStore'
import { getDefaultWeatherState, isWeatherForceRtb } from '@/sim/weather/weatherEngine'
import type {
  DroneState,
  EventType,
  FullMissionFrame,
  MissionEvent,
  MissionCompletionReason,
  MissionReplaySession,
  ScenarioConfig,
  UIState,
  SimSpeed,
  TelemetryPoint,
  ThermalDetection,
  ThermalContactState,
  GroundUnitState,
  RecoveryTeamState,
  WeatherVariantState,
  ScenarioVariantConfig,
  LaunchBayPlan,
  Waypoint,
  OperatorRole,
  MissionMetrics,
  LatLng,
  OperatorRouteCommand,
  RouteSuggestion,
  ThermalAction,
  WaypointSaveSource,
  WaypointSaveStatus,
  InvestorDemoState,
  MissionLifecycleState,
  MissionState,
} from '@/types'
import type { FleetRetaskPlan, TacticalAction } from '@/sim/mission/tacticalAdvisor'

const MAX_TELEMETRY_POINTS = 240
const MAX_POSITION_SAMPLES = 500
// Rolling replay buffer: SNAPSHOT_INTERVAL is 40 ticks → one frame per 2 sim-seconds, so 300
// frames cover the LAST ≈10 minutes of mission time. Longer missions drop their earliest
// frames; ReplayPanel surfaces a truncation note when that happens.
const MAX_FRAMES = 300
export const FLEET_RETASK_COOLDOWN_MS = 5_000
export const FLEET_RETASK_UNDO_WINDOW_MS = 8_000
const MAX_FLEET_RETASK_HISTORY = 20

export interface ParkedLaunchPlacement {
  bay: LatLng
  scheduledLaunchSec: number
}

export interface SiteRelocationState {
  siteId: string
  affectedSiteIds: string[]
  from: LatLng
  to: LatLng
  startedAtSec: number
  availableAtSec: number
  affectedDroneIds: string[]
  reserveDeltaPct: number
}
export { isRetaskable } from '@/sim/mission/retaskPolicy'

const DEFAULT_VARIANT: ScenarioVariantConfig = {
  seed: 1337,
  timeOfDay: 'day',
  season: 'spring',
  weatherSeverity: 0,
  commsDegradation: 0,
  thermalDensity: 1,
  batteryPressure: 0,
  terrainDifficulty: 0,
}
const DEFAULT_INVESTOR_DEMO: InvestorDemoState = {
  enabled: false,
  currentChapterId: null,
  completedChapterIds: [],
  resetCount: 0,
}

const DEMO_CHAPTER_IDS = [
  'mission-brief',
  'launch-and-edit',
  'live-retask',
  'thermal-detection',
  'safe-recovery',
  'after-action',
]

/** Input for emitEvent — prevHash/hash/timestamp are derived inside the reducer. */
export interface EmitEventInput {
  eventType: EventType
  droneId: string
  payload: Record<string, unknown>
  tick?: number
  operatorId?: string
  role?: OperatorRole
}

export interface RouteChangeSnapshotEntry {
  hadRoute: boolean
  route: Waypoint[]
  currentWaypointIndex: number
}

export interface RouteChangeSnapshot {
  scenarioId: string
  changedAt: number
  previous: Record<string, RouteChangeSnapshotEntry>
  source?: 'manual' | 'fleet_retask'
}

export type FleetRetaskEntryStatus = 'applied' | 'held' | 'skipped' | 'failed' | 'warning'
export type FleetRetaskReason =
  | 'not_retaskable'
  | 'critical_battery'
  | 'battery_reserve'
  | 'geofence_breach'
  | 'weather'
  | 'no_viable_assignment'
  | 'advisor_hold'
  | 'cooldown_active'
  | 'route_capped'
  | 'route_safety_rejected'
  | 'route_unchanged'
  | 'route_applied'
  | 'persistence_failed'

export interface FleetRetaskResultEntry {
  droneId: string
  status: FleetRetaskEntryStatus
  reason: FleetRetaskReason
  detail?: string
  action?: TacticalAction
  objectiveId?: string
  waypointCount?: number
}

export interface FleetRetaskApplyResult {
  status: 'applied' | 'no_change' | 'cached' | 'cooldown' | 'failed'
  situationHash: string
  requestedAt: number
  cooldownUntil?: number
  undoUntil?: number
  fromCache: boolean
  changedDroneIds: string[]
  entries: FleetRetaskResultEntry[]
  message?: string
}

export interface FleetRetaskCache {
  situationHash: string
  cooldownUntil: number
  result: FleetRetaskApplyResult
}

export interface FleetRetaskUndoSnapshotEntry extends RouteChangeSnapshotEntry {
  previousMissionState: MissionState
  appliedMissionState: MissionState
  action: TacticalAction
  routeChanged: boolean
}

export interface FleetRetaskUndoSnapshot {
  scenarioId: string
  changedAt: number
  undoUntil: number
  previous: Record<string, FleetRetaskUndoSnapshotEntry>
}

interface DroneStore {
  // Fleet
  drones: DroneState[]
  tick: number
  elapsedSec: number

  // Events / chain of custody
  events: MissionEvent[]
  lastHash: string
  commandActorId: string | null

  // Telemetry history for charts (droneId → rolling buffer)
  telemetryHistory: Record<string, TelemetryPoint[]>

  // SAR per-drone waypoints (populated by SARPlanner at mission start)
  droneWaypoints: Record<string, Waypoint[]>

  // Thermal contacts from IR sensor (enriched with weather confidence + selection state)
  thermalContacts: ThermalContactState[]
  selectedThermalId: string | null

  // Ground units (dispatched to thermal contacts or recovery)
  groundUnits: GroundUnitState[]

  // Recovery teams (dispatched to downed drones)
  recoveryTeams: RecoveryTeamState[]

  // Current scenario
  scenario: ScenarioConfig | null

  // Operator retasking
  routeSuggestions: RouteSuggestion[]
  routeCommandError: string | null
  routeSaveStatuses: Record<string, WaypointSaveStatus>
  lastRouteChange: RouteChangeSnapshot | null
  latestFleetRetaskPlan: FleetRetaskPlan | null
  latestFleetRetaskResult: FleetRetaskApplyResult | null
  fleetRetaskCache: FleetRetaskCache | null
  fleetRetaskHistory: FleetRetaskApplyResult[]
  fleetRetaskUndo: FleetRetaskUndoSnapshot | null

  // Operator role — governs which controls are enabled
  operatorRole: OperatorRole

  // Mission lifecycle FSM — gates record-writing (only 'completed' finalizes a run)
  // and drives Pause/Resume/End Mission button states.
  lifecycle: MissionLifecycleState

  // Investor guided demo overlay and reset state
  investorDemo: InvestorDemoState

  // Accumulated mission metrics
  metrics: MissionMetrics

  // Position history for KML/GeoJSON export (droneId → sampled positions)
  positionHistory: Record<string, LatLng[]>

  // Full replay session (assembled on stopMission)
  replaySession: MissionReplaySession | null
  replayIndex: number

  // Live replay frame buffer (written by sim loop, used to build replaySession)
  replayFrames: FullMissionFrame[]

  // Weather
  weatherState: WeatherVariantState
  scenarioVariant: ScenarioVariantConfig

  // Launch bay planning
  launchPlan: LaunchBayPlan | null

  // Runtime-only station positions. ScenarioConfig remains immutable so a
  // replay/reset can always recover the authored launch and recovery geometry.
  siteOverrides: Record<string, LatLng>
  siteRelocations: Record<string, SiteRelocationState>

  // Sim-time (elapsedSec) at which the launch command was issued. Combined with
  // each drone's scheduledLaunchSec this drives the staggered "hive-mind" takeoff.
  launchCommandedSec: number | null

  // UI
  ui: UIState

  // Map ready flag (set by TacticalMap on map 'load' event)
  mapReady: boolean

  // Actions
  setDrones: (drones: DroneState[]) => void
  updateDrone: (id: string, patch: Partial<DroneState>) => void
  emitEvent: (input: EmitEventInput) => void
  /** Runs a synchronous command with an explicit evidence actor, then restores the prior actor. */
  withCommandActor: <T>(actorId: string, command: () => T) => T
  addTelemetryPoint: (droneId: string, point: TelemetryPoint) => void
  addPositionSample: (droneId: string, pos: LatLng) => void
  addReplayFrame: (frame: FullMissionFrame) => void
  setReplayIndex: (index: number) => void
  finalizeReplaySession: (reason: MissionCompletionReason) => void
  setDroneWaypoints: (droneWaypoints: Record<string, Waypoint[]>) => void
  setRouteSaveStatuses: (statuses: Record<string, WaypointSaveStatus>) => void
  saveDroneRouteDraft: (droneId: string, source?: WaypointSaveSource) => boolean
  clearDroneRouteDraft: (droneId: string) => void
  addThermalContact: (detection: ThermalDetection) => void
  selectThermal: (id: string | null) => void
  dispatchGroundUnit: (thermalId: string, role: GroundUnitState['role'], stagingPos: LatLng) => void
  resolveThermal: (sourceId: string, action: ThermalAction) => void
  addGroundUnit: (unit: GroundUnitState) => void
  updateGroundUnit: (id: string, patch: Partial<GroundUnitState>) => void
  addRecoveryTeam: (team: RecoveryTeamState) => void
  updateRecoveryTeam: (id: string, patch: Partial<RecoveryTeamState>) => void
  setWeatherState: (state: WeatherVariantState) => void
  setScenarioVariant: (variant: ScenarioVariantConfig) => void
  setLaunchPlan: (plan: LaunchBayPlan) => void
  applyParkedLaunchPlan: (plan: LaunchBayPlan, placements: Record<string, ParkedLaunchPlacement>) => boolean
  previewSiteReposition: (siteId: string, requested: LatLng) => SiteRepositionResult
  repositionLaunchSite: (siteId: string, requested: LatLng) => SiteRepositionResult
  setScenario: (scenario: ScenarioConfig) => void
  setOperatorRole: (role: OperatorRole) => void
  setLifecycle: (lifecycle: MissionLifecycleState) => void
  setInvestorDemoEnabled: (enabled: boolean) => void
  advanceInvestorDemoChapter: () => void
  resetInvestorDemo: () => void
  updateMetrics: (patch: Partial<MissionMetrics>) => void
  setDroneRoute: (droneId: string, waypoints: Waypoint[], command?: OperatorRouteCommand) => boolean
  moveDroneWaypoint: (droneId: string, waypointId: string, position: LatLng) => boolean
  commandDroneRoute: (droneId: string, command: OperatorRouteCommand, center?: LatLng) => boolean
  hoverDrone: (droneId: string) => void
  resumeDrone: (droneId: string) => void
  returnDroneToBase: (droneId: string) => void
  remoteLandDrone: (droneId: string) => void
  abortRecovery: (droneId: string) => void
  generateRouteSuggestionsForDrone: (droneId: string) => void
  acceptRouteSuggestion: (suggestionId: string) => boolean
  rejectRouteSuggestion: (suggestionId: string) => void
  undoLastRouteChange: () => boolean
  undoFleetRetask: (nowMs?: number) => boolean
  retaskFleet: (nowMs?: number) => FleetRetaskApplyResult
  incrementTick: () => void
  setRunning: (running: boolean) => void
  setSimSpeed: (speed: SimSpeed) => void
  setSensorMode: (mode: UIState['sensorMode']) => void
  toggleLayer: (key: keyof UIState['layerVisibility']) => void
  setSelectedDrone: (id: string | null) => void
  setRouteEditMode: (editing: boolean) => void
  setShowPreflight: (show: boolean) => void
  setShowLaunchBay: (show: boolean) => void
  setIsReplayMode: (replay: boolean) => void
  resetMission: () => void
  setMapReady: (ready: boolean) => void
  beginLaunchSequence: () => void
}

// ─── Derived getter: thermalDetections for backward compat ────────────────────
// Export functions use ThermalDetection[] — ThermalContactState extends ThermalDetection so
// callers can pass thermalContacts directly without a cast.

export const useDroneStore = create<DroneStore>()(
  devtools(
    subscribeWithSelector((set, get) => {
      const recordOperatorCommand = (droneId: string, command: OperatorRouteCommand, payload: Record<string, unknown> = {}) => {
        get().emitEvent({
          eventType: 'operator_command',
          droneId,
          operatorId: get().commandActorId ?? undefined,
          role: get().operatorRole,
          payload: { command, ...payload },
        })
      }

      const persistDroneRouteDraft = (droneId: string, route: Waypoint[], source: WaypointSaveSource): WaypointSaveStatus => {
        const st = get()
        const now = Date.now()
        const status = st.scenario
          ? saveDroneWaypointRoute({
              scenarioId: st.scenario.id,
              scenarioVariant: st.scenarioVariant,
              droneId,
              route,
              source,
              now,
            }).status
          : { state: 'failed' as const, updatedAt: now, source, message: 'No active scenario' }

        set((s) => ({
          routeSaveStatuses: { ...s.routeSaveStatuses, [droneId]: status },
        }))
        return status
      }

      const snapshotRoutes = (
        state: Pick<DroneStore, 'scenario' | 'droneWaypoints' | 'drones'>,
        droneIds: string[],
        changedAt = Date.now(),
        source: RouteChangeSnapshot['source'] = 'manual',
      ): RouteChangeSnapshot | null => {
        if (!state.scenario) return null
        const previous = Object.fromEntries([...new Set(droneIds)].map((droneId) => {
          const drone = state.drones.find((item) => item.id === droneId)
          const route = state.droneWaypoints[droneId]
          return [droneId, {
            hadRoute: Object.prototype.hasOwnProperty.call(state.droneWaypoints, droneId),
            route: cloneWaypointRoute(route ?? []),
            currentWaypointIndex: drone?.currentWaypointIndex ?? 0,
          }]
        }))
        return { scenarioId: state.scenario.id, changedAt, previous, source }
      }

      const snapshotFleetRetask = (
        state: Pick<DroneStore, 'scenario' | 'droneWaypoints' | 'drones'>,
        changedDroneIds: string[],
        assignments: ReadonlyMap<string, FleetRetaskPlan['assignments'][number]>,
        changedRoutes: Readonly<Record<string, Waypoint[]>>,
        changedAt: number,
      ): FleetRetaskUndoSnapshot | null => {
        if (!state.scenario) return null
        const previous = Object.fromEntries(changedDroneIds.map((droneId) => {
          const drone = state.drones.find((item) => item.id === droneId)
          const assignment = assignments.get(droneId)
          if (!drone || !assignment) return [droneId, null]
          return [droneId, {
            hadRoute: Object.prototype.hasOwnProperty.call(state.droneWaypoints, droneId),
            route: cloneWaypointRoute(state.droneWaypoints[droneId] ?? []),
            currentWaypointIndex: drone.currentWaypointIndex,
            previousMissionState: drone.missionState,
            appliedMissionState: missionStateForFleetAction(assignment.action),
            action: assignment.action,
            routeChanged: Boolean(changedRoutes[droneId]),
          }]
        }).filter((entry): entry is [string, FleetRetaskUndoSnapshotEntry] => entry[1] !== null))
        return {
          scenarioId: state.scenario.id,
          changedAt,
          undoUntil: changedAt + FLEET_RETASK_UNDO_WINDOW_MS,
          previous,
        }
      }

      const setDroneRouteValidated = (
        droneId: string,
        waypoints: Waypoint[],
        command: OperatorRouteCommand = 'set_route',
        saveSource: WaypointSaveSource = 'operator_edit',
      ) => {
        const st = get()
        if (!st.scenario) return false
        const drone = st.drones.find((item) => item.id === droneId)
        const validation = validateOperatorRoute(st.scenario, droneId, waypoints, drone?.position)
        if (!validation.accepted) {
          set({
            routeCommandError: `${droneId.toUpperCase()} route rejected: ${validation.findings[0]?.geofenceLabel ?? 'route safety violation'}`,
          })
          return false
        }
        set((s) => ({
          droneWaypoints: { ...s.droneWaypoints, [droneId]: validation.route },
          routeCommandError: null,
          lastRouteChange: snapshotRoutes(s, [droneId]),
          latestFleetRetaskPlan: null,
          latestFleetRetaskResult: null,
          fleetRetaskCache: null,
          fleetRetaskUndo: null,
          drones: s.drones.map((d) => (
            d.id === droneId && isRetaskable(d)
              ? { ...d, currentWaypointIndex: 0, missionState: 'navigate' }
              : d
          )),
        }))
        persistDroneRouteDraft(droneId, validation.route, saveSource)
        recordOperatorCommand(droneId, command, {
          waypointCount: validation.route.length,
          route: validation.route.map((wp) => ({ id: wp.id, label: wp.label, position: wp.position, altitudeFt: wp.altitudeFt })),
        })
        return true
      }

      return ({
        drones: [],
        tick: 0,
        elapsedSec: 0,
        events: [],
        lastHash: '0'.repeat(64),
        commandActorId: null,
        telemetryHistory: {},
        droneWaypoints: {},
        thermalContacts: [],
        selectedThermalId: null,
        groundUnits: [],
        recoveryTeams: [],
        scenario: null,
        routeSuggestions: [],
        routeCommandError: null,
        routeSaveStatuses: {},
        lastRouteChange: null,
        latestFleetRetaskPlan: null,
        latestFleetRetaskResult: null,
        fleetRetaskCache: null,
        fleetRetaskHistory: [],
        fleetRetaskUndo: null,
        operatorRole: 'pic',
        lifecycle: 'idle',
        investorDemo: DEFAULT_INVESTOR_DEMO,
        metrics: {
          totalFlightDistanceM: 0,
          waypointsReached: 0,
          conflictsDetected: 0,
          thermalContacts: 0,
          geofenceBreaches: 0,
          rtbTriggers: 0,
          recoveryDispatches: 0,
          groundUnitDispatch: 0,
        },
        positionHistory: {},
        replaySession: null,
        replayIndex: 0,
        replayFrames: [],
        weatherState: getDefaultWeatherState(1337),
        scenarioVariant: DEFAULT_VARIANT,
        launchPlan: null,
        siteOverrides: {},
        siteRelocations: {},
        launchCommandedSec: null,
        mapReady: false,
        ui: {
          selectedDroneId: null,
          sensorMode: 'eo',
          simSpeed: 1,
          isRunning: false,
          isReplayMode: false,
          showPreflight: false,
          showLaunchBay: false,
          showEventLog: true,
          routeEditMode: false,
          layerVisibility: {
            relays: true, gates: true, recharge: true,
            traffic: true, thermal: true, irFootprints: true,
          },
        },

        setDrones: (drones) => set({ drones }),

        updateDrone: (id, patch) =>
          set((s) => ({
            drones: s.drones.map((d) => (d.id === id ? { ...d, ...patch } : d)),
          })),

        // The ONLY way events enter the chain. prevHash is read and the new hash committed
        // inside one reducer pass, so links can never fork — even when many events are
        // emitted within a single sim tick. (See chainOfCustody.ts for why hashing is sync.)
        emitEvent: (input) =>
          set((s) => {
            const partial = {
              tick: input.tick ?? s.tick,
              timestamp: Date.now(),
              droneId: input.droneId,
              operatorId: input.operatorId ?? getActiveOperator().operatorId,
              role: input.role ?? ('pic' as OperatorRole),
              eventType: input.eventType,
              payload: input.payload,
              prevHash: s.lastHash,
            }
            const hash = hashEvent(s.lastHash, partial)
            const event: MissionEvent = { ...partial, hash }
            return { events: [...s.events, event], lastHash: hash }
          }),

        withCommandActor: (actorId, command) => {
          const previous = get().commandActorId
          set({ commandActorId: actorId })
          try {
            return command()
          } finally {
            set({ commandActorId: previous })
          }
        },

        addTelemetryPoint: (droneId, point) =>
          set((s) => {
            const existing = s.telemetryHistory[droneId] ?? []
            const next = existing.length >= MAX_TELEMETRY_POINTS
              ? [...existing.slice(1), point]
              : [...existing, point]
            return { telemetryHistory: { ...s.telemetryHistory, [droneId]: next } }
          }),

        addPositionSample: (droneId, pos) =>
          set((s) => {
            const existing = s.positionHistory[droneId] ?? []
            const next = existing.length >= MAX_POSITION_SAMPLES
              ? [...existing.slice(1), pos]
              : [...existing, pos]
            return { positionHistory: { ...s.positionHistory, [droneId]: next } }
          }),

        addReplayFrame: (frame) =>
          set((s) => {
            const next = s.replayFrames.length >= MAX_FRAMES
              ? [...s.replayFrames.slice(1), frame]
              : [...s.replayFrames, frame]
            return { replayFrames: next }
          }),

        setReplayIndex: (index) =>
          set((s) => {
            const session = s.replaySession
            if (!session) return { replayIndex: index }
            const frame = session.frames[index]
            if (!frame) return { replayIndex: index }
            return {
              replayIndex: index,
              drones: frame.drones,
              thermalContacts: frame.thermalContacts,
              groundUnits: frame.groundUnits,
              recoveryTeams: frame.recoveryTeams,
              weatherState: frame.weatherState,
            }
          }),

        finalizeReplaySession: (reason) =>
          set((s) => {
            if (!s.scenario) return {}
            const session: MissionReplaySession = {
              scenarioId: s.scenario.id,
              scenarioVariant: s.scenarioVariant,
              launchPlan: s.launchPlan,
              frames: s.replayFrames,
              events: s.events,
              metrics: s.metrics,
              completedAt: Date.now(),
              completionReason: reason,
              // Snapshot the true end-of-mission state. Replay scrubbing overwrites the live
              // drones/thermalContacts/etc., so exports read these finals instead.
              finalDrones: s.drones.map((d) => ({ ...d })),
              finalThermalContacts: s.thermalContacts.map((c) => ({ ...c })),
              finalGroundUnits: s.groundUnits.map((u) => ({ ...u })),
              finalRecoveryTeams: s.recoveryTeams.map((t) => ({ ...t })),
              finalWeatherState: { ...s.weatherState },
            }
            return { replaySession: session }
          }),

        setDroneWaypoints: (droneWaypoints) => set({ droneWaypoints }),

        setRouteSaveStatuses: (statuses) => set({ routeSaveStatuses: statuses }),

        saveDroneRouteDraft: (droneId, source = 'manual_save') => {
          const route = get().droneWaypoints[droneId]
          if (!route) return false
          return persistDroneRouteDraft(droneId, route, source).state !== 'failed'
        },

        clearDroneRouteDraft: (droneId) => {
          const st = get()
          const status = st.scenario
            ? clearSavedDroneWaypointRoute(undefined, st.scenario.id, st.scenarioVariant, droneId)
            : { state: 'failed' as const, updatedAt: Date.now(), message: 'No active scenario' }
          set((s) => ({
            routeSaveStatuses: { ...s.routeSaveStatuses, [droneId]: status },
          }))
        },

        addThermalContact: (detection) =>
          set((s) => {
            const existing = s.thermalContacts.find((c) => c.sourceId === detection.sourceId)
            const weather = s.weatherState
            const adjusted = detection.confidence * weather.sensorConfidenceFactor
            const contact: ThermalContactState = {
              ...detection,
              confidence: adjusted,
              weatherAdjustedConfidence: adjusted,
              selected: existing?.selected ?? false,
              action: existing?.action,
              groundUnitId: existing?.groundUnitId,
              resolvedAt: existing?.resolvedAt,
            }
            const filtered = s.thermalContacts.filter((c) => c.sourceId !== detection.sourceId)
            return { thermalContacts: [...filtered, contact] }
          }),

        selectThermal: (id) => set({ selectedThermalId: id }),

        dispatchGroundUnit: (thermalId, role, stagingPos) =>
          set((s) => {
            const contact = s.thermalContacts.find((c) => c.sourceId === thermalId)
            if (!contact || contact.groundUnitId) return {}
            // Deterministic id: one dispatch per contact (guarded above), keyed by sim tick.
            const unitId = `gu-${thermalId}-t${s.tick}`
            const newUnit: GroundUnitState = {
              id: unitId,
              role,
              position: { ...stagingPos },
              status: 'enroute',
              targetThermalId: thermalId,
              weatherRiskNote: s.weatherState.activeHazards.length > 0
                ? s.weatherState.activeHazards.join(', ')
                : undefined,
            }
            const updatedContacts = s.thermalContacts.map((c) =>
              c.sourceId === thermalId
                ? { ...c, action: 'dispatch_unit' as ThermalAction, groundUnitId: unitId }
                : c
            )
            return {
              thermalContacts: updatedContacts,
              groundUnits: [...s.groundUnits, newUnit],
              metrics: {
                ...s.metrics,
                groundUnitDispatch: s.metrics.groundUnitDispatch + 1,
              },
            }
          }),

        resolveThermal: (sourceId, action) =>
          set((s) => ({
            thermalContacts: s.thermalContacts.map((c) =>
              c.sourceId === sourceId
                ? { ...c, action, resolvedAt: s.tick, selected: false }
                : c
            ),
            selectedThermalId: s.selectedThermalId === sourceId ? null : s.selectedThermalId,
          })),

        addGroundUnit: (unit) =>
          set((s) => ({ groundUnits: [...s.groundUnits, unit] })),

        updateGroundUnit: (id, patch) =>
          set((s) => ({
            groundUnits: s.groundUnits.map((u) => (u.id === id ? { ...u, ...patch } : u)),
          })),

        addRecoveryTeam: (team) =>
          set((s) => ({
            recoveryTeams: [...s.recoveryTeams, team],
            metrics: { ...s.metrics, recoveryDispatches: s.metrics.recoveryDispatches + 1 },
          })),

        updateRecoveryTeam: (id, patch) =>
          set((s) => ({
            recoveryTeams: s.recoveryTeams.map((t) => (t.id === id ? { ...t, ...patch } : t)),
          })),

        setWeatherState: (state) => set((current) => ({
          weatherState: state,
          latestFleetRetaskPlan: null,
          latestFleetRetaskResult: null,
          fleetRetaskCache: null,
          fleetRetaskUndo: null,
          lastRouteChange: current.lastRouteChange?.source === 'fleet_retask' ? null : current.lastRouteChange,
        })),

        setScenarioVariant: (variant) => set((current) => ({
          scenarioVariant: variant,
          latestFleetRetaskPlan: null,
          latestFleetRetaskResult: null,
          fleetRetaskCache: null,
          fleetRetaskUndo: null,
          lastRouteChange: current.lastRouteChange?.source === 'fleet_retask' ? null : current.lastRouteChange,
        })),

        setLaunchPlan: (plan) => set({ launchPlan: plan }),

        applyParkedLaunchPlan: (plan, placements) => {
          let applied = false
          set((state) => {
            const parked = (state.lifecycle === 'idle' || state.lifecycle === 'preflight')
              && !state.ui.isRunning
              && state.drones.length > 0
              && state.drones.every((drone) => drone.missionState === 'idle' && drone.altitudeFt === 0 && placements[drone.id])
            if (!parked || !plan.readyToLaunch) return {}
            applied = true
            return {
              launchPlan: plan,
              drones: state.drones.map((drone) => ({
                ...drone,
                position: { ...placements[drone.id].bay },
                scheduledLaunchSec: placements[drone.id].scheduledLaunchSec,
              })),
            }
          })
          return applied
        },

        previewSiteReposition: (siteId, requested) => {
          const state = get()
          if (!state.scenario) return unavailableSiteReposition(siteId, requested, 'No active scenario')
          const assessed = assessSiteReposition({
            scenario: state.scenario,
            siteId,
            requestedPosition: requested,
            overrides: state.siteOverrides,
            drones: state.drones,
            launchAssignments: state.launchPlan?.assignments ?? state.scenario.defaultLaunchAssignments,
            recoveryAssignments: state.scenario.defaultRecoveryAssignments,
            weather: state.weatherState,
          })
          return withRuntimeRepositionTiming(assessed, state.lifecycle)
        },

        repositionLaunchSite: (siteId, requested) => {
          let result: SiteRepositionResult | null = null
          set((state) => {
            if (!state.scenario) {
              result = unavailableSiteReposition(siteId, requested, 'No active scenario')
              return {}
            }

            const assessed = withRuntimeRepositionTiming(assessSiteReposition({
              scenario: state.scenario,
              siteId,
              requestedPosition: requested,
              overrides: state.siteOverrides,
              drones: state.drones,
              launchAssignments: state.launchPlan?.assignments ?? state.scenario.defaultLaunchAssignments,
              recoveryAssignments: state.scenario.defaultRecoveryAssignments,
              weather: state.weatherState,
            }), state.lifecycle)
            result = assessed
            if (!assessed.ok) return {}

            const relocation: SiteRelocationState = {
              siteId: assessed.siteId,
              affectedSiteIds: [...assessed.affectedSiteIds],
              from: { ...assessed.from },
              to: { ...assessed.position },
              startedAtSec: state.elapsedSec,
              availableAtSec: state.elapsedSec + assessed.repositionTimeSec,
              affectedDroneIds: [...assessed.affectedDrones],
              reserveDeltaPct: assessed.reserveDeltaPct,
            }
            const siteRelocations = { ...state.siteRelocations }
            assessed.affectedSiteIds.forEach((affectedSiteId) => {
              siteRelocations[affectedSiteId] = relocation
            })

            const partial = {
              tick: state.tick,
              timestamp: Date.now(),
              droneId: 'system',
              operatorId: getActiveOperator().operatorId,
              role: state.operatorRole,
              eventType: 'launch_site_repositioned' as EventType,
              payload: {
                siteId: assessed.siteId,
                from: assessed.from,
                to: assessed.position,
                affected: assessed.affectedDrones,
                reserveDeltaPct: assessed.reserveDeltaPct,
                repositionTimeSec: assessed.repositionTimeSec,
              },
              prevHash: state.lastHash,
            }
            const hash = hashEvent(state.lastHash, partial)
            const event: MissionEvent = { ...partial, hash }

            return {
              siteOverrides: { ...state.siteOverrides, ...assessed.overridePatch },
              siteRelocations,
              events: [...state.events, event],
              lastHash: hash,
              latestFleetRetaskPlan: null,
              latestFleetRetaskResult: null,
              fleetRetaskCache: null,
              fleetRetaskUndo: null,
              lastRouteChange: state.lastRouteChange?.source === 'fleet_retask' ? null : state.lastRouteChange,
            }
          })

          const applied = result ?? unavailableSiteReposition(siteId, requested, 'Site reposition was not applied')
          const nextState = get()
          if (applied.ok && (nextState.lifecycle === 'running' || nextState.lifecycle === 'paused') && nextState.scenario) {
            const situation = buildMissionSituation({
              scenario: nextState.scenario,
              drones: nextState.drones,
              droneWaypoints: nextState.droneWaypoints,
              tick: nextState.tick,
              elapsedSec: nextState.elapsedSec,
              unresolvedContacts: nextState.thermalContacts,
              groundUnits: nextState.groundUnits,
              weather: nextState.weatherState,
              positionHistory: nextState.positionHistory,
              siteOverrides: nextState.siteOverrides,
            })
            set({ latestFleetRetaskPlan: planFleetRetask(situation) })
          }
          return applied
        },

        setOperatorRole: (role) => set({ operatorRole: role }),

        setLifecycle: (lifecycle) => set({ lifecycle }),

        setInvestorDemoEnabled: (enabled) =>
          set((s) => ({
            investorDemo: {
              ...s.investorDemo,
              enabled,
              currentChapterId: enabled ? (s.investorDemo.currentChapterId ?? 'mission-brief') : null,
              completedChapterIds: enabled ? s.investorDemo.completedChapterIds : [],
            },
          })),

        advanceInvestorDemoChapter: () =>
          set((s) => {
            const current = s.investorDemo.currentChapterId ?? DEMO_CHAPTER_IDS[0]
            const currentIndex = Math.max(0, DEMO_CHAPTER_IDS.indexOf(current))
            const nextChapterId = DEMO_CHAPTER_IDS[Math.min(currentIndex + 1, DEMO_CHAPTER_IDS.length - 1)]
            const completed = new Set(s.investorDemo.completedChapterIds)
            completed.add(current)
            return {
              investorDemo: {
                ...s.investorDemo,
                enabled: true,
                currentChapterId: nextChapterId,
                completedChapterIds: Array.from(completed),
              },
            }
          }),

        resetInvestorDemo: () => {
          clearAllSavedWaypointPlans()
          set((s) => ({
            tick: 0,
            elapsedSec: 0,
            events: [],
            lastHash: '0'.repeat(64),
            commandActorId: null,
            telemetryHistory: {},
            droneWaypoints: {},
            thermalContacts: [],
            selectedThermalId: null,
            groundUnits: [],
            recoveryTeams: [],
            routeSuggestions: [],
            routeCommandError: null,
            routeSaveStatuses: {},
            lastRouteChange: null,
            latestFleetRetaskPlan: null,
            latestFleetRetaskResult: null,
            fleetRetaskCache: null,
            fleetRetaskHistory: [],
            fleetRetaskUndo: null,
            positionHistory: {},
            replaySession: null,
            replayIndex: 0,
            replayFrames: [],
            launchPlan: null,
            siteOverrides: {},
            siteRelocations: {},
            lifecycle: 'idle',
            ui: {
              ...s.ui,
              selectedDroneId: null,
              isRunning: false,
              isReplayMode: false,
              showPreflight: false,
              showLaunchBay: false,
              routeEditMode: false,
            },
            investorDemo: {
              enabled: true,
              currentChapterId: 'mission-brief',
              completedChapterIds: [],
              resetCount: s.investorDemo.resetCount + 1,
              lastResetAt: Date.now(),
            },
            metrics: {
              totalFlightDistanceM: 0,
              waypointsReached: 0,
              conflictsDetected: 0,
              thermalContacts: 0,
              geofenceBreaches: 0,
              rtbTriggers: 0,
              recoveryDispatches: 0,
              groundUnitDispatch: 0,
            },
          }))
        },

        updateMetrics: (patch) =>
          set((s) => ({ metrics: { ...s.metrics, ...patch } })),

        setDroneRoute: (droneId, waypoints, command = 'set_route') =>
          setDroneRouteValidated(droneId, waypoints, command, 'operator_edit'),

        moveDroneWaypoint: (droneId, waypointId, position) => {
          const route = get().droneWaypoints[droneId] ?? []
          const next = route.map((wp) => (wp.id === waypointId ? { ...wp, position } : wp))
          return setDroneRouteValidated(droneId, next, 'set_route', 'operator_edit')
        },

        commandDroneRoute: (droneId, command, center) => {
          const state = get()
          const scenario = state.scenario
          if (!scenario) return false
          if (!['deep_scan', 'street_sweep', 'perimeter_orbit', 'expanding_search', 'standoff_observe', 'route_lkl'].includes(command)) return false
          const drone = state.drones.find((item) => item.id === droneId)
          const route = buildOperatorCommandRoute({
            command: command as 'deep_scan' | 'street_sweep' | 'perimeter_orbit' | 'expanding_search' | 'standoff_observe' | 'route_lkl',
            scenario,
            droneId,
            center,
            fromPosition: drone?.position,
          })
          return setDroneRouteValidated(droneId, route, command, 'command_route')
        },

        hoverDrone: (droneId) => {
          set((s) => ({
            drones: s.drones.map((d) => (d.id === droneId ? { ...d, missionState: 'hover', hoverStartSec: s.elapsedSec } : d)),
            ...invalidateFleetUndoForDrone(s, droneId),
          }))
          recordOperatorCommand(droneId, 'hover')
        },

        resumeDrone: (droneId) => {
          const THERMAL_HOLD_MIN_SEC = 10
          set((s) => ({
            drones: s.drones.map((d) => {
              if (d.id !== droneId) return d
              if (
                d.missionState === 'thermal_hold' &&
                d.thermalHoldStartSec !== undefined &&
                s.elapsedSec - d.thermalHoldStartSec < THERMAL_HOLD_MIN_SEC
              ) return d
              const returnState = d.missionState === 'thermal_hold'
                ? (d.inspectReturnState ?? 'navigate')
                : 'navigate'
              return { ...d, missionState: returnState, hoverStartSec: undefined, inspectStartSec: undefined, inspectReturnState: undefined, thermalHoldStartSec: undefined }
            }),
            ...invalidateFleetUndoForDrone(s, droneId),
          }))
          recordOperatorCommand(droneId, 'resume')
        },

        returnDroneToBase: (droneId) => {
          set((s) => ({
            drones: s.drones.map((d) => (d.id === droneId ? { ...d, missionState: 'return_to_base', currentWaypointIndex: 0 } : d)),
            ...invalidateFleetUndoForDrone(s, droneId),
          }))
          recordOperatorCommand(droneId, 'rtb')
        },

        remoteLandDrone: (droneId) => {
          set((s) => ({
            drones: s.drones.map((d) => (d.id === droneId ? { ...d, missionState: 'remote_landed' } : d)),
          }))
          recordOperatorCommand(droneId, 'remote_land')
        },

        abortRecovery: (droneId) => {
          set((s) => ({
            drones: s.drones.map((d) => (d.id === droneId
              ? { ...d, missionState: 'landed', emergencyStartSec: undefined, commsLostSec: 0 }
              : d)),
            recoveryTeams: s.recoveryTeams.filter((t) => t.droneId !== droneId),
          }))
          recordOperatorCommand(droneId, 'abort_recovery')
        },

        generateRouteSuggestionsForDrone: (droneId) => {
          const st = get()
          if (!st.scenario) return
          const drone = st.drones.find((d) => d.id === droneId)
          const warnings = [
            drone?.geofenceBreachFlag && 'geofence',
            drone?.signalDbm !== undefined && drone.signalDbm < -80 && 'comms_degraded',
            st.thermalContacts.length > 0 && 'thermal_contact',
          ].filter((w): w is string => !!w)
          const suggestions = buildRouteSuggestions({
            scenario: st.scenario,
            droneId,
            elapsedSec: st.elapsedSec,
            thermalDetections: st.thermalContacts,
            warnings,
            sortieCount: drone?.sortieCount,
            currentWaypointIndex: drone?.currentWaypointIndex,
            fromPosition: drone?.position,
          })
          set((s) => {
            const byId = new Map(s.routeSuggestions.map((suggestion) => [suggestion.id, suggestion]))
            suggestions.forEach((suggestion) => byId.set(suggestion.id, suggestion))
            return { routeSuggestions: Array.from(byId.values()) }
          })
        },

        acceptRouteSuggestion: (suggestionId) => {
          const suggestion = get().routeSuggestions.find((item) => item.id === suggestionId)
          if (!suggestion) return false
          const ok = setDroneRouteValidated(suggestion.droneId, suggestion.route, 'set_route', 'route_suggestion')
          if (ok) {
            set((s) => ({ routeSuggestions: s.routeSuggestions.filter((item) => item.id !== suggestionId) }))
          }
          return ok
        },

        rejectRouteSuggestion: (suggestionId) => {
          const suggestion = get().routeSuggestions.find((item) => item.id === suggestionId)
          set((s) => ({ routeSuggestions: s.routeSuggestions.filter((item) => item.id !== suggestionId) }))
          if (suggestion) recordOperatorCommand(suggestion.droneId, 'set_route', { rejectedSuggestionId: suggestionId })
        },

        retaskFleet: (nowMs = Date.now()) => {
          const state = get()
          if (!state.scenario) {
            const result: FleetRetaskApplyResult = {
              status: 'failed',
              situationHash: 'no-scenario',
              requestedAt: nowMs,
              fromCache: false,
              changedDroneIds: [],
              entries: [],
              message: 'No active scenario',
            }
            set({ latestFleetRetaskPlan: null, latestFleetRetaskResult: result })
            return result
          }

          const situation = buildMissionSituation({
            scenario: state.scenario,
            drones: state.drones,
            droneWaypoints: state.droneWaypoints,
            tick: state.tick,
            elapsedSec: state.elapsedSec,
            unresolvedContacts: state.thermalContacts,
            groundUnits: state.groundUnits,
            weather: state.weatherState,
            positionHistory: state.positionHistory,
            siteOverrides: state.siteOverrides,
          })
          const situationHash = hashMissionSituation(situation)
          const cached = state.fleetRetaskCache
          if (cached && nowMs < cached.cooldownUntil) {
            if (cached.situationHash === situationHash) {
              const result: FleetRetaskApplyResult = {
                ...cached.result,
                status: 'cached',
                requestedAt: nowMs,
                fromCache: true,
                entries: cached.result.entries.map((entry) => ({ ...entry })),
                changedDroneIds: [...cached.result.changedDroneIds],
              }
              set({ latestFleetRetaskResult: result })
              return result
            }

            const result: FleetRetaskApplyResult = {
              status: 'cooldown',
              situationHash,
              requestedAt: nowMs,
              cooldownUntil: cached.cooldownUntil,
              fromCache: false,
              changedDroneIds: [],
              entries: [...state.drones]
                .sort((left, right) => left.id.localeCompare(right.id))
                .map((drone) => ({
                  droneId: drone.id,
                  status: 'warning',
                  reason: 'cooldown_active',
                })),
              message: 'Fleet retask cooldown is active',
            }
            set({ latestFleetRetaskResult: result })
            return result
          }

          const plan = planFleetRetask(situation)
          const entries: FleetRetaskResultEntry[] = []
          const routesToSave: Record<string, Waypoint[]> = {}
          const affectedDroneIds = new Set<string>()
          const assignmentsByDrone = new Map(plan.assignments.map((assignment) => [assignment.droneId, assignment]))

          plan.skippedDrones.forEach(({ droneId, reason }) => {
            entries.push({ droneId, status: 'skipped', reason })
          })
          plan.unassignedDroneIds.forEach((droneId) => {
            entries.push({ droneId, status: 'failed', reason: 'no_viable_assignment' })
          })

          for (const assignment of plan.assignments) {
            const drone = state.drones.find((item) => item.id === assignment.droneId)
            if (!drone || !isRetaskable(drone)) {
              entries.push({
                droneId: assignment.droneId,
                status: 'skipped',
                reason: 'not_retaskable',
                action: assignment.action,
                objectiveId: assignment.objectiveId,
              })
              continue
            }
            if (assignment.action === 'hold_station') {
              entries.push({
                droneId: assignment.droneId,
                status: 'held',
                reason: 'advisor_hold',
                action: assignment.action,
                objectiveId: assignment.objectiveId,
                waypointCount: 0,
              })
              continue
            }

            const cappedRoute = clampAdvisorRoute(assignment.route)
            if (assignment.route.length > MAX_WAYPOINTS_PER_DRONE) {
              entries.push({
                droneId: assignment.droneId,
                status: 'warning',
                reason: 'route_capped',
                action: assignment.action,
                objectiveId: assignment.objectiveId,
                waypointCount: MAX_WAYPOINTS_PER_DRONE,
              })
            }
            const validation = validateOperatorRoute(state.scenario, assignment.droneId, cappedRoute, drone.position)
            if (!validation.accepted || validation.route.length === 0) {
              entries.push({
                droneId: assignment.droneId,
                status: 'failed',
                reason: 'route_safety_rejected',
                detail: validation.findings[0]?.geofenceLabel,
                action: assignment.action,
                objectiveId: assignment.objectiveId,
              })
              continue
            }
            const routeChanged = !routesEqual(state.droneWaypoints[assignment.droneId], validation.route)
            const targetMissionState = missionStateForFleetAction(assignment.action)
            const stateChanged = drone.missionState !== targetMissionState || drone.currentWaypointIndex !== 0
            if (!routeChanged && !stateChanged) {
              entries.push({
                droneId: assignment.droneId,
                status: 'held',
                reason: 'route_unchanged',
                action: assignment.action,
                objectiveId: assignment.objectiveId,
                waypointCount: validation.route.length,
              })
              continue
            }

            if (routeChanged) routesToSave[assignment.droneId] = cloneWaypointRoute(validation.route)
            affectedDroneIds.add(assignment.droneId)
            entries.push({
              droneId: assignment.droneId,
              status: 'applied',
              reason: 'route_applied',
              action: assignment.action,
              objectiveId: assignment.objectiveId,
              waypointCount: validation.route.length,
            })
          }

          const routeChangedDroneIds = Object.keys(routesToSave).sort()
          const changedDroneIds = [...affectedDroneIds].sort()
          const sortedEntries = sortFleetRetaskEntries(entries)
          const persisted = routeChangedDroneIds.length > 0
            ? saveFleetWaypointRoutes({
                scenarioId: state.scenario.id,
                scenarioVariant: state.scenarioVariant,
                routes: routesToSave,
                source: 'fleet_retask',
                now: nowMs,
              })
            : { ok: true, statuses: {} }

          if (!persisted.ok) {
            const result: FleetRetaskApplyResult = {
              status: 'failed',
              situationHash,
              requestedAt: nowMs,
              fromCache: false,
              changedDroneIds: [],
              entries: sortFleetRetaskEntries(sortedEntries.map((entry) => (
                entry.status === 'applied'
                  ? { ...entry, status: 'failed' as const, reason: 'persistence_failed' }
                  : entry
              ))),
              message: 'Fleet route persistence failed',
            }
            set((current) => ({
              latestFleetRetaskPlan: plan,
              latestFleetRetaskResult: result,
              routeSaveStatuses: { ...current.routeSaveStatuses, ...persisted.statuses },
            }))
            return result
          }

          const cooldownUntil = nowMs + FLEET_RETASK_COOLDOWN_MS
          const undoUntil = changedDroneIds.length > 0 ? nowMs + FLEET_RETASK_UNDO_WINDOW_MS : undefined
          const result: FleetRetaskApplyResult = {
            status: changedDroneIds.length > 0 ? 'applied' : 'no_change',
            situationHash,
            requestedAt: nowMs,
            cooldownUntil,
            undoUntil,
            fromCache: false,
            changedDroneIds,
            entries: sortedEntries,
          }
          const snapshot = changedDroneIds.length > 0
            ? snapshotRoutes(state, changedDroneIds, nowMs, 'fleet_retask')
            : (state.lastRouteChange?.source === 'fleet_retask' ? null : state.lastRouteChange)
          const fleetRetaskUndo = changedDroneIds.length > 0
            ? snapshotFleetRetask(state, changedDroneIds, assignmentsByDrone, routesToSave, nowMs)
            : null
          const cache: FleetRetaskCache = { situationHash, cooldownUntil, result }

          set((current) => ({
            droneWaypoints: changedDroneIds.length > 0
              ? { ...current.droneWaypoints, ...cloneWaypointRoutes(routesToSave) }
              : current.droneWaypoints,
            drones: changedDroneIds.length > 0
              ? current.drones.map((drone) => (
                  affectedDroneIds.has(drone.id) && isRetaskable(drone)
                    ? {
                        ...drone,
                        currentWaypointIndex: 0,
                        missionState: missionStateForFleetAction(assignmentsByDrone.get(drone.id)?.action),
                      }
                    : drone
                ))
              : current.drones,
            lastRouteChange: snapshot,
            routeCommandError: null,
            routeSaveStatuses: { ...current.routeSaveStatuses, ...persisted.statuses },
            latestFleetRetaskPlan: plan,
            latestFleetRetaskResult: result,
            fleetRetaskCache: cache,
            fleetRetaskHistory: [...current.fleetRetaskHistory, result].slice(-MAX_FLEET_RETASK_HISTORY),
            fleetRetaskUndo,
          }))

          changedDroneIds.forEach((droneId) => {
            const assignment = assignmentsByDrone.get(droneId)
            recordOperatorCommand(droneId, 'set_route', {
              source: 'fleet_retask',
              tacticalAction: assignment?.action,
              objectiveId: assignment?.objectiveId,
              situationHash,
              waypointCount: routesToSave[droneId]?.length ?? assignmentsByDrone.get(droneId)?.route.length ?? 0,
            })
          })
          return result
        },

        undoFleetRetask: (nowMs = Date.now()) => {
          const state = get()
          const snapshot = state.fleetRetaskUndo
          if (!snapshot || !state.scenario || snapshot.scenarioId !== state.scenario.id) return false
          if (nowMs > snapshot.undoUntil) {
            set((current) => ({
              fleetRetaskUndo: null,
              lastRouteChange: current.lastRouteChange?.source === 'fleet_retask' ? null : current.lastRouteChange,
            }))
            return false
          }

          const routesToSave: Record<string, Waypoint[]> = {}
          const removedDroneIds: string[] = []
          Object.entries(snapshot.previous).forEach(([droneId, previous]) => {
            if (!previous.routeChanged) return
            if (previous.hadRoute) routesToSave[droneId] = cloneWaypointRoute(previous.route)
            else removedDroneIds.push(droneId)
          })
          const persisted = Object.keys(routesToSave).length > 0 || removedDroneIds.length > 0
            ? saveFleetWaypointRoutes({
                scenarioId: state.scenario.id,
                scenarioVariant: state.scenarioVariant,
                routes: routesToSave,
                removedDroneIds,
                source: 'route_undo',
                now: nowMs,
              })
            : { ok: true, statuses: {} }
          if (!persisted.ok) {
            set((current) => ({
              routeSaveStatuses: { ...current.routeSaveStatuses, ...persisted.statuses },
            }))
            return false
          }

          set((current) => {
            const droneWaypoints = { ...current.droneWaypoints }
            Object.entries(snapshot.previous).forEach(([droneId, previous]) => {
              if (!previous.routeChanged) return
              if (previous.hadRoute) droneWaypoints[droneId] = cloneWaypointRoute(previous.route)
              else delete droneWaypoints[droneId]
            })
            return {
              droneWaypoints,
              drones: current.drones.map((drone) => {
                const previous = snapshot.previous[drone.id]
                if (!previous) return drone
                const safetyOverride = getMissionSafetyOverride(
                  { ...drone, missionState: previous.previousMissionState },
                  {
                    batteryReservePct: batteryReservePctForDrone(current.scenario!, drone.id),
                    weatherForceRtb: isWeatherForceRtb(current.weatherState),
                  },
                )
                const transitionedToSafety = drone.missionState === 'emergency'
                  || (drone.missionState === 'return_to_base' && previous.appliedMissionState !== 'return_to_base')
                const maxIndex = Math.max(0, previous.route.length - 1)
                return {
                  ...drone,
                  currentWaypointIndex: Math.min(previous.currentWaypointIndex, maxIndex),
                  missionState: safetyOverride?.nextState
                    ?? (transitionedToSafety ? drone.missionState : previous.previousMissionState),
                }
              }),
              lastRouteChange: null,
              fleetRetaskUndo: null,
              latestFleetRetaskPlan: null,
              latestFleetRetaskResult: null,
              fleetRetaskCache: null,
              routeCommandError: null,
              routeSaveStatuses: { ...current.routeSaveStatuses, ...persisted.statuses },
            }
          })
          return true
        },

        undoLastRouteChange: () => {
          const state = get()
          const snapshot = state.lastRouteChange
          if (!snapshot || !state.scenario || snapshot.scenarioId !== state.scenario.id) return false
          if (snapshot.source === 'fleet_retask') return get().undoFleetRetask()

          const routesToSave: Record<string, Waypoint[]> = {}
          const removedDroneIds: string[] = []
          Object.entries(snapshot.previous).forEach(([droneId, previous]) => {
            if (previous.hadRoute) routesToSave[droneId] = cloneWaypointRoute(previous.route)
            else removedDroneIds.push(droneId)
          })

          const persisted = saveFleetWaypointRoutes({
            scenarioId: state.scenario.id,
            scenarioVariant: state.scenarioVariant,
            routes: routesToSave,
            removedDroneIds,
            source: 'route_undo',
          })
          if (!persisted.ok) {
            set((s) => ({ routeSaveStatuses: { ...s.routeSaveStatuses, ...persisted.statuses } }))
            return false
          }

          set((s) => {
            const droneWaypoints = { ...s.droneWaypoints }
            Object.entries(snapshot.previous).forEach(([droneId, previous]) => {
              if (previous.hadRoute) droneWaypoints[droneId] = cloneWaypointRoute(previous.route)
              else delete droneWaypoints[droneId]
            })
            return {
              droneWaypoints,
              lastRouteChange: null,
              routeCommandError: null,
              routeSaveStatuses: { ...s.routeSaveStatuses, ...persisted.statuses },
              // Preserve live position and mission state, including any safety
              // transition raised after the route change.
              drones: s.drones.map((drone) => {
                const previous = snapshot.previous[drone.id]
                if (!previous) return drone
                const maxIndex = Math.max(0, previous.route.length - 1)
                return { ...drone, currentWaypointIndex: Math.min(previous.currentWaypointIndex, maxIndex) }
              }),
            }
          })
          return true
        },

        setScenario: (scenario) => set({
          scenario,
          siteOverrides: {},
          siteRelocations: {},
          lastRouteChange: null,
          latestFleetRetaskPlan: null,
          latestFleetRetaskResult: null,
          fleetRetaskCache: null,
          fleetRetaskHistory: [],
          fleetRetaskUndo: null,
        }),

        incrementTick: () =>
          set((s) => ({
            tick: s.tick + 1,
            elapsedSec: s.elapsedSec + 0.05,
          })),

        setRunning: (running) =>
          set((s) => ({ ui: { ...s.ui, isRunning: running } })),

        // Issue the coordinated launch command: stamp the launch epoch (current
        // sim time) and move parked drones into the 'preflight' hold. Each drone
        // then lifts off when elapsedSec − launchCommandedSec ≥ scheduledLaunchSec
        // (evaluated in MissionManager), producing the staggered takeoff.
        beginLaunchSequence: () =>
          set((s) => ({
            launchCommandedSec: s.elapsedSec,
            lifecycle: 'running',
            drones: s.drones.map((d) =>
              d.missionState === 'idle' || d.missionState === 'landed'
                ? { ...d, missionState: 'preflight', launchTimeSec: undefined }
                : d,
            ),
          })),

        setSimSpeed: (speed) =>
          set((s) => ({ ui: { ...s.ui, simSpeed: speed } })),

        setSensorMode: (mode) =>
          set((s) => ({ ui: { ...s.ui, sensorMode: mode } })),

        toggleLayer: (key) =>
          set((s) => ({
            ui: { ...s.ui, layerVisibility: { ...s.ui.layerVisibility, [key]: !s.ui.layerVisibility[key] } },
          })),

        // Deselecting (or switching to another drone) always exits route edit mode —
        // edit mode is meaningless without a subject, and leaving it latched would
        // let a later selection start in an unexpected state.
        setSelectedDrone: (id) =>
          set((s) => ({
            ui: { ...s.ui, selectedDroneId: id, routeEditMode: id === null ? false : s.ui.routeEditMode },
          })),

        setRouteEditMode: (editing) =>
          set((s) => ({ ui: { ...s.ui, routeEditMode: editing && s.ui.selectedDroneId !== null } })),

        setShowPreflight: (show) =>
          set((s) => ({ ui: { ...s.ui, showPreflight: show } })),

        setShowLaunchBay: (show) =>
          set((s) => ({ ui: { ...s.ui, showLaunchBay: show } })),

        setIsReplayMode: (replay) =>
          set((s) => ({ ui: { ...s.ui, isReplayMode: replay } })),

        setMapReady: (ready) => set({ mapReady: ready }),

        resetMission: () =>
          set((s) => ({
            // Route editing is a live-map mode; a reset must not leave it latched.
            ui: { ...s.ui, routeEditMode: false },
            tick: 0, elapsedSec: 0, events: [], lastHash: '0'.repeat(64),
            commandActorId: null,
            telemetryHistory: {}, droneWaypoints: {}, thermalContacts: [],
            selectedThermalId: null, groundUnits: [], recoveryTeams: [],
            routeSuggestions: [], routeCommandError: null, routeSaveStatuses: {}, lastRouteChange: null,
            latestFleetRetaskPlan: null, latestFleetRetaskResult: null,
            fleetRetaskCache: null, fleetRetaskHistory: [],
            fleetRetaskUndo: null,
            positionHistory: {}, replaySession: null, replayIndex: 0, replayFrames: [],
            launchPlan: null, siteOverrides: {}, siteRelocations: {}, launchCommandedSec: null, lifecycle: 'idle',
            metrics: {
              totalFlightDistanceM: 0, waypointsReached: 0, conflictsDetected: 0,
              thermalContacts: 0, geofenceBreaches: 0, rtbTriggers: 0,
              recoveryDispatches: 0, groundUnitDispatch: 0,
            },
          })),
      })
    }),
    { name: 'DroneOpsStore' },
  ),
)

function cloneWaypointRoute(route: Waypoint[]): Waypoint[] {
  return route.map((waypoint) => ({
    ...waypoint,
    position: { ...waypoint.position },
  }))
}

function unavailableSiteReposition(siteId: string, requested: LatLng, reason: string): SiteRepositionResult {
  return {
    ok: false,
    siteId,
    from: { ...requested },
    requestedPosition: { ...requested },
    position: { ...requested },
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

function withRuntimeRepositionTiming(
  result: SiteRepositionResult,
  lifecycle: MissionLifecycleState,
): SiteRepositionResult {
  return lifecycle === 'running' || lifecycle === 'paused'
    ? result
    : { ...result, repositionTimeSec: 0 }
}

function cloneWaypointRoutes(routes: Record<string, Waypoint[]>): Record<string, Waypoint[]> {
  return Object.fromEntries(
    Object.entries(routes).map(([droneId, route]) => [droneId, cloneWaypointRoute(route)]),
  )
}

function missionStateForFleetAction(action: TacticalAction | undefined): MissionState {
  return action === 'rtb_now' ? 'return_to_base' : 'navigate'
}

function invalidateFleetUndoForDrone(
  state: Pick<
    DroneStore,
    | 'fleetRetaskUndo'
    | 'lastRouteChange'
    | 'latestFleetRetaskPlan'
    | 'latestFleetRetaskResult'
    | 'fleetRetaskCache'
  >,
  droneId: string,
): Pick<
  DroneStore,
  | 'fleetRetaskUndo'
  | 'lastRouteChange'
  | 'latestFleetRetaskPlan'
  | 'latestFleetRetaskResult'
  | 'fleetRetaskCache'
> {
  if (!state.fleetRetaskUndo?.previous[droneId]) {
    return {
      fleetRetaskUndo: state.fleetRetaskUndo,
      lastRouteChange: state.lastRouteChange,
      latestFleetRetaskPlan: state.latestFleetRetaskPlan,
      latestFleetRetaskResult: state.latestFleetRetaskResult,
      fleetRetaskCache: state.fleetRetaskCache,
    }
  }
  return {
    fleetRetaskUndo: null,
    lastRouteChange: state.lastRouteChange?.source === 'fleet_retask' ? null : state.lastRouteChange,
    latestFleetRetaskPlan: null,
    latestFleetRetaskResult: null,
    fleetRetaskCache: null,
  }
}

function sortFleetRetaskEntries(entries: FleetRetaskResultEntry[]): FleetRetaskResultEntry[] {
  const statusRank: Record<FleetRetaskEntryStatus, number> = {
    warning: 0,
    applied: 1,
    held: 2,
    skipped: 3,
    failed: 4,
  }
  return [...entries].sort((left, right) => (
    left.droneId.localeCompare(right.droneId)
      || statusRank[left.status] - statusRank[right.status]
      || left.reason.localeCompare(right.reason)
  ))
}
