import { create } from 'zustand'
import { devtools, subscribeWithSelector } from 'zustand/middleware'
import { buildOperatorCommandRoute, buildRouteSuggestions, validateOperatorRoute } from '@/sim/mission/operatorRoutes'
import { isRetaskable } from '@/sim/mission/retaskPolicy'
import { clearAllSavedWaypointPlans, clearSavedDroneWaypointRoute, saveDroneWaypointRoute, saveFleetWaypointRoutes } from '@/sim/mission/waypointPersistence'
import { hashEvent } from '@/utils/chainOfCustody'
import { getActiveOperator } from '@/store/authStore'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
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
} from '@/types'

const MAX_TELEMETRY_POINTS = 240
const MAX_POSITION_SAMPLES = 500
// Rolling replay buffer: SNAPSHOT_INTERVAL is 40 ticks → one frame per 2 sim-seconds, so 300
// frames cover the LAST ≈10 minutes of mission time. Longer missions drop their earliest
// frames; ReplayPanel surfaces a truncation note when that happens.
const MAX_FRAMES = 300
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
}

interface DroneStore {
  // Fleet
  drones: DroneState[]
  tick: number
  elapsedSec: number

  // Events / chain of custody
  events: MissionEvent[]
  lastHash: string

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
        return { scenarioId: state.scenario.id, changedAt: Date.now(), previous }
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

        setWeatherState: (state) => set({ weatherState: state }),

        setScenarioVariant: (variant) => set({ scenarioVariant: variant }),

        setLaunchPlan: (plan) => set({ launchPlan: plan }),

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
            positionHistory: {},
            replaySession: null,
            replayIndex: 0,
            replayFrames: [],
            launchPlan: null,
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
          }))
          recordOperatorCommand(droneId, 'resume')
        },

        returnDroneToBase: (droneId) => {
          set((s) => ({
            drones: s.drones.map((d) => (d.id === droneId ? { ...d, missionState: 'return_to_base', currentWaypointIndex: 0 } : d)),
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

        undoLastRouteChange: () => {
          const state = get()
          const snapshot = state.lastRouteChange
          if (!snapshot || !state.scenario || snapshot.scenarioId !== state.scenario.id) return false

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

        setScenario: (scenario) => set({ scenario, lastRouteChange: null }),

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
            telemetryHistory: {}, droneWaypoints: {}, thermalContacts: [],
            selectedThermalId: null, groundUnits: [], recoveryTeams: [],
            routeSuggestions: [], routeCommandError: null, routeSaveStatuses: {}, lastRouteChange: null,
            positionHistory: {}, replaySession: null, replayIndex: 0, replayFrames: [],
            launchPlan: null, launchCommandedSec: null, lifecycle: 'idle',
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
