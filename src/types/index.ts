import type { PlatformId } from '@/sim/drone/platformCatalog'

// ─── Geographic ────────────────────────────────────────────────────────────────
export interface LatLng {
  lat: number
  lng: number
}

export interface Waypoint {
  id: string
  position: LatLng
  altitudeFt: number
  label?: string
  dwellTimeSec?: number
}

// ─── Drone ─────────────────────────────────────────────────────────────────────
export type MissionState =
  | 'idle'
  | 'preflight'
  | 'launch'
  | 'navigate'
  | 'sar_grid'
  | 'hover'
  | 'inspect'
  | 'thermal_hold'
  | 'route_complete_loiter'
  | 'avoid'
  | 'return_to_base'
  | 'emergency'
  | 'landed'
  | 'recharge'
  | 'remote_landed'
  | 'stranded'
  | 'recovery_requested'
  | 'recovery_enroute'
  | 'recovered'
  | 'unrecoverable_sim'

export interface DroneState {
  id: string
  label: string
  color: string          // hex color for map marker
  position: LatLng
  altitudeFt: number
  headingDeg: number     // 0–360
  speedMs: number
  batteryPct: number
  signalDbm: number      // -30 (great) to -100 (lost)
  missionState: MissionState
  currentWaypointIndex: number
  conflictFlag: boolean
  geofenceBreachFlag: boolean
  geofenceBreach?: GeofenceBreachInfo
  bvlosFlag: boolean
  hoverStartSec?: number
  sortieCount: number
  platformId?: PlatformId
  rechargeStartSec?: number
  sortieResumeWpIdx?: number
  scheduledLaunchSec?: number  // sim-seconds after the launch command this drone lifts off (staggered)
  launchTimeSec?: number  // elapsedSec when drone first transitions to 'launch'
  weatherDivertFlag?: boolean
  commsLostSec?: number   // elapsedSec when comms first dropped below -90 dBm
  lastKnownPosition?: LatLng  // snapshotted at first comms dropout; cleared on restore
  emergencyStartSec?: number  // elapsedSec when drone first entered 'emergency'
  inspectStartSec?: number    // elapsedSec when drone entered 'inspect' for a thermal contact
  inspectReturnState?: MissionState  // missionState to restore once inspect dwell completes
  thermalHoldStartSec?: number  // sim-time when drone entered 'thermal_hold'
  avoidStartSec?: number        // elapsedSec when drone entered 'avoid' for a traffic conflict
  avoidHeadingDeg?: number      // divergence heading held during the avoid maneuver
  avoidReturnState?: MissionState  // missionState to restore once the conflict clears

  // ─── GNSS (REALISM_ROADMAP WP-7) ───────────────────────────────────────────
  // `position` above stays GROUND TRUTH and is what the sim flies. These describe what the
  // aircraft's receiver *reports*, which is all an operator ever sees. Absent when the
  // scenario has no committed constellation fixture — never defaulted to a fake good fix.
  reportedPosition?: LatLng     // truth perturbed by the GNSS error model; held during no_fix
  hdop?: number | null          // horizontal dilution of precision; null when there is no fix
  satsVisible?: number          // satellites above the mask AND unoccluded
  satsInView?: number           // satellites above the mask before occlusion (open-sky count)
  gnssHorizontalErrorM?: number | null  // 1σ horizontal error, σ_H = HDOP × σ_UERE
  fixQuality?: GnssFixQuality

  // ─── RF link budget (REALISM_ROADMAP WP-8) ─────────────────────────────────
  // `signalDbm` above is now the computed RSSI rather than a scripted ramp. These expose the
  // terms behind it so the operator can see WHY the link is what it is.
  linkMarginDb?: number         // rssi − receiver sensitivity; negative cannot close the link
  linkPacketLossPct?: number
  linkLatencyMs?: number
  linkViaRelayId?: string | null  // aircraft carrying the hop, or null when direct to the GCS
  linkLos?: boolean             // false when terrain/structures block the path (NLOS penalty applied)
}

/** WP-7 receiver fix state. Mirrors `src/sim/nav/gnss.ts`, declared here to keep types leaf-level. */
export type GnssFixQuality = 'fix' | 'degraded' | 'no_fix'

/** WP-8 RF clutter class (§18.4). Mirrors `src/sim/safety/commsModel.ts`, kept leaf-level. */
export type ClutterClass = 'open' | 'rural' | 'suburban' | 'urban' | 'dense_urban'

export interface DroneCmd {
  targetHeadingDeg?: number
  throttle?: number       // 0–1
  targetAltitudeFt?: number
  batteryDrainRatePerSec?: number
}

// ─── Mission ────────────────────────────────────────────────────────────────────
export type MissionType = 'waypoint' | 'sar_parallel' | 'sar_expanding' | 'perimeter' | 'inspection'

export interface Mission {
  id: string
  type: MissionType
  waypoints: Waypoint[]
  searchAreaPolygon?: LatLng[]   // for SAR missions
  trackSpacingFt?: number        // for parallel track SAR
}

// ─── Geofence ──────────────────────────────────────────────────────────────────
export interface Geofence {
  id: string
  label: string
  polygon: LatLng[]
  maxAltitudeFt: number
  type: 'no_fly' | 'restricted'
  bypassForMission?: boolean  // task force authorization — zone visible on map but never triggers RTB
  lifeCritical?: boolean      // breach risks people or occupied critical infrastructure
}

export interface GeofenceBreachInfo {
  id: string
  label: string
  type: Geofence['type']
  maxAltitudeFt: number
}

// ─── Mission Brief / Dispatch / Operational Geometry ─────────────────────────
export type DispatchPriority = 'routine' | 'advisory' | 'urgent' | 'critical'
export type DispatchTimelineCategory = 'dispatch' | 'field_unit' | 'operator_task' | 'agency_update' | 'safety'

export type LaunchRecoverySiteKind =
  | 'building_rooftop'
  | 'rooftop'
  | 'police_rooftop'
  | 'police_station'
  | 'fire_station'
  | 'mobile_command'
  | 'field_icp'
  | 'vessel'
  | 'helipad'

export type LaunchSiteExposure = 'sheltered' | 'semi' | 'exposed'

export interface LaunchRecoverySite {
  /** Stable pool identifier. Legacy scenarios derive this from the record key. */
  id?: string
  kind: LaunchRecoverySiteKind
  label: string
  agency: string
  position: LatLng
  surfaceNote: string
  isPrimaryRecovery?: boolean
  capacityDrones?: number   // simultaneous launch slots at this surface (default 2)
  exposure?: LaunchSiteExposure
  /** Explicit override; mobile command, field ICP, and vessel sites default to mobile. */
  mobile?: boolean
  /** Maximum displacement from the authored scenario position. */
  repositionRadiusM?: number
  /** Vehicle transit and setup time once a live relocation starts. */
  repositionTimeSec?: number
  padFootprintM?: number
}

export interface MissionBrief {
  agencies: string[]
  situation: string
  commandIntent: string
  coordinationModel: string
  primaryObjective: string
  successCondition: string
  operationalConstraints: string[]
}

export interface DispatchTimelineEntry {
  id: string
  timeSec: number
  source: string
  priority: DispatchPriority
  category?: DispatchTimelineCategory
  message: string
  linkedDroneId?: string
}

export type OperationalFeatureType =
  | 'street'
  | 'alley'
  | 'shoreline'
  | 'bridge'
  | 'fireline'
  | 'perimeter'
  | 'gate'
  | 'search_sector'
  | 'relay'
  | 'lz'
  | 'hazard'
  | 'last_known'
  | 'standoff'
  | 'recharge_station'

export interface OperationalFeature {
  id: string
  type: OperationalFeatureType
  label: string
  points: LatLng[]
  priority?: DispatchPriority
}

export interface DroneRouteBrief {
  role: string
  launchRationale: string
  routePattern: string
  altitudeBand: string
  standoffOrRelayLogic: string
  recoveryPlan: string
}

export interface BatteryProfile {
  id: string
  label: string
  capacityWh: number
  enduranceMultiplier: number
  reservePct: number
  chargeRateMultiplier?: number
  notes: string
}

export interface RechargeStation {
  id: string
  label: string
  position: LatLng
  road: string
  agency: string
  notes?: string
  priority?: DispatchPriority
}

export type DispatchFeedKind = 'authored' | 'derived' | 'warning'

export interface DispatchFeedEntry {
  id: string
  timeSec: number
  source: string
  priority: DispatchPriority
  message: string
  linkedDroneId?: string
  kind: DispatchFeedKind
  category: DispatchTimelineCategory
}

export type OperatorRouteCommand =
  | 'set_route'
  | 'append_waypoint'
  | 'hover'
  | 'resume'
  | 'rtb'
  | 'recharge'
  | 'route_lkl'
  | 'deep_scan'
  | 'street_sweep'
  | 'perimeter_orbit'
  | 'expanding_search'
  | 'standoff_observe'
  | 'remote_land'
  | 'abort_recovery'

export interface RouteSuggestion {
  id: string
  droneId: string
  source: string
  priority: DispatchPriority
  title: string
  rationale: string
  riskLevel: DispatchPriority
  route: Waypoint[]
  requiresApproval: boolean
  createdAtSec: number
}

export type WaypointSaveSource =
  | 'operator_edit'
  | 'manual_save'
  | 'command_route'
  | 'route_suggestion'
  | 'route_undo'
  | 'fleet_retask'

export type WaypointSaveState = 'autosaved' | 'restored' | 'failed' | 'cleared'

export interface WaypointSaveStatus {
  state: WaypointSaveState
  updatedAt: number
  source?: WaypointSaveSource
  message?: string
}

export interface SavedDroneWaypointRoute {
  schemaVersion: 1
  scenarioId: string
  scenarioVariant: ScenarioVariantConfig
  droneId: string
  route: Waypoint[]
  updatedAt: number
  source: WaypointSaveSource
}

export interface SavedMissionWaypointPlan {
  schemaVersion: 1
  scenarioId: string
  scenarioVariant: ScenarioVariantConfig
  updatedAt: number
  routes: Record<string, SavedDroneWaypointRoute>
}

// ─── Events / Chain of Custody ─────────────────────────────────────────────────
export type EventType =
  | 'mission_start'
  | 'mission_complete'
  | 'route_complete'
  | 'weather_divert'
  | 'mission_abort'
  | 'state_change'
  | 'waypoint_reached'
  | 'low_battery'
  | 'rtb_triggered'
  | 'emergency_land'
  | 'avoidance_start'
  | 'avoidance_complete'
  | 'geofence_breach'
  | 'comms_degraded'
  | 'comms_lost'
  | 'comms_restored'
  | 'conflict_detected'
  | 'conflict_resolved'
  | 'thermal_detection'
  | 'preflight_complete'
  | 'operator_command'
  | 'recharge_start'
  | 'sortie_launch'
  | 'ground_unit_dispatched'
  | 'ground_unit_on_scene'
  | 'drone_recovery_requested'
  | 'drone_recovered'
  | 'launch_site_repositioned'
  | 'gnss_fix_lost'
  | 'gnss_fix_changed'

export interface MissionEvent {
  tick: number
  timestamp: number      // ms since epoch
  droneId: string
  operatorId: string
  role: OperatorRole
  eventType: EventType
  payload: Record<string, unknown>
  prevHash: string
  hash: string           // SHA-256(prevHash + JSON(rest))
}

// ─── Operators / Roles ─────────────────────────────────────────────────────────
export type OperatorRole = 'pic' | 'mission_commander' | 'observer'

export interface Operator {
  id: string
  name: string
  role: OperatorRole
}

// ─── Thermal / Sensors ─────────────────────────────────────────────────────────
export type HeatSourceClass = 'generic-person' | 'vehicle' | 'heat-source' | 'campfire'

export interface HeatSource {
  id: string
  class: HeatSourceClass
  position: LatLng
  tempC: number
  radiusM: number
  /** Johnson-model critical target dimension; class/footprint geometry is the fallback. */
  criticalDimensionM?: number
  /** Thermal aim-point height above local ground. */
  heightAglM?: number
  /** Authored local background temperature; live weather temperature is the fallback. */
  backgroundTempC?: number
}

export interface ThermalDetection {
  sourceId: string
  class: HeatSourceClass
  position: LatLng
  confidence: number
  tick: number
}

export type ThermalAction =
  | 'focused_scan'
  | 'hover_hold'
  | 'dispatch_unit'
  | 'mark_false_positive'
  | 'escalate'
  | 'resolve'
  | 'clear'

export interface ThermalContactState extends ThermalDetection {
  selected: boolean
  action?: ThermalAction
  groundUnitId?: string
  resolvedAt?: number
  weatherAdjustedConfidence: number
}

// ─── Ground Units ───────────────────────────────────────────────────────────────
export type GroundUnitRole = 'intervention' | 'medical' | 'fire' | 'law_enforcement' | 'maintenance' | 'recovery'

export interface GroundUnitState {
  id: string
  role: GroundUnitRole
  position: LatLng
  status: 'standby' | 'enroute' | 'on_scene' | 'returning'
  targetThermalId?: string
  targetDroneId?: string
  etaSec?: number
  etaComputed?: boolean   // true once the initial route ETA has been calculated
  weatherRiskNote?: string
}

// ─── Recovery Teams ─────────────────────────────────────────────────────────────
export interface RecoveryTeamState {
  id: string
  droneId: string
  position: LatLng
  targetPosition: LatLng
  status: 'dispatched' | 'enroute' | 'on_scene' | 'extracted'
  etaSec: number
  routePoints: LatLng[]
  weatherRiskNote?: string
  accessNote?: string
  outcome?: 'recovered' | 'unrecoverable'
}

// ─── Launch Bay Planning ────────────────────────────────────────────────────────
export interface LaunchBayStatus {
  siteId: string
  capacityDrones: number
  assignedDroneIds: string[]
  weatherClosed: boolean
  closureReason?: string
  exposure?: LaunchSiteExposure
  effectiveCapacityDrones?: number
}

export type MissionObjectiveKind =
  | 'contact_resolution'
  | 'sector_coverage'
  | 'tasking_compliance'
  | 'containment'
  | 'fleet_recovery'

/** Mission definition shared by every simulator shell. Runtime scoring stays outside this type. */
export interface MissionObjective {
  id: string
  kind: MissionObjectiveKind
  label: string
  weight: number
  /** Completion target expressed as a 0..1 ratio. Sector coverage defaults to 0.80. */
  target?: number
  /** Optional source ids narrow a declared objective to contacts, tasks, or operational features. */
  sourceIds?: string[]
}

export type LaunchDoctrineRejectCode =
  | 'missing_route'
  | 'missing_recovery'
  | 'unreachable'
  | 'launch_geofence'
  | 'climbout_geofence'
  | 'weather_exposure'
  | 'capacity'
  | 'pad_footprint'

export interface LaunchDoctrineScore {
  transitEfficiency: number
  doctrineFit: number
  recoverySymmetry: number
  authoredIntent: number
  dispersionPenalty: number
  total: number
}

export interface LaunchDoctrineCandidate {
  id: string
  droneId: string
  siteId: string
  recoverySiteId: string | null
  launchPosition: LatLng
  firstTaskDistanceM: number
  transitSec: number
  routeDistanceM: number
  batteryRequiredPct: number
  reserveMarginPct: number
  score: LaunchDoctrineScore
  rejectedBy: LaunchDoctrineRejectCode[]
  rationale: string
}

export interface LaunchDoctrineAssignmentDetail extends LaunchDoctrineCandidate {
  rank: number
  bay: LatLng
}

export interface LaunchBayPlan {
  assignments: Record<string, string>   // droneId → siteId
  bayStatuses: LaunchBayStatus[]
  readyToLaunch: boolean
  blockers: string[]
  assignmentDetails?: Record<string, LaunchDoctrineAssignmentDetail>
  candidatesByDrone?: Record<string, LaunchDoctrineCandidate[]>
  rejectedByDrone?: Record<string, LaunchDoctrineCandidate[]>
}

// ─── Full Mission Replay ────────────────────────────────────────────────────────
export interface FullMissionFrame {
  tick: number
  elapsedSec: number
  drones: DroneState[]
  thermalContacts: ThermalContactState[]
  groundUnits: GroundUnitState[]
  recoveryTeams: RecoveryTeamState[]
  weatherState: WeatherVariantState
  activeEventIds: string[]
}

// Why a run ended: the whole fleet reached idle/landed on its own (tick-driven,
// SimulationLoop's terminal auto-complete), or the operator tapped End Mission
// while the fleet was still active (including after an RTB-ALL abort).
export type MissionCompletionReason = 'all_drones_complete' | 'operator_ended'

export interface MissionReplaySession {
  scenarioId: string
  scenarioVariant: ScenarioVariantConfig
  launchPlan: LaunchBayPlan | null
  frames: FullMissionFrame[]
  events: MissionEvent[]
  metrics: MissionMetrics
  completedAt: number
  completionReason: MissionCompletionReason
  // Final mission state, snapshotted at stop time. Replay scrubbing overwrites the live store's
  // drones/thermalContacts/etc., so exports MUST read these instead of live fields — otherwise an
  // after-action generated mid-scrub mixes an old frame's fleet state with final metrics.
  finalDrones: DroneState[]
  finalThermalContacts: ThermalContactState[]
  finalGroundUnits: GroundUnitState[]
  finalRecoveryTeams: RecoveryTeamState[]
  finalWeatherState: WeatherVariantState
}

// ─── Weather / Procedural Variants ─────────────────────────────────────────────
export type WeatherLocationTag = 'coastal' | 'urban' | 'wildfire' | 'mountain' | 'desert_border' | 'generic'
export type WeatherHazard =
  | 'fog'
  | 'marine_layer'
  | 'rain'
  | 'smoke'
  | 'heat'
  | 'cold'
  | 'thermal_updraft'
  | 'dust'
  | 'snow_ice'
  | 'canyon_gusts'
  | 'rf_shadow'

// Real observed weather frozen from a fixture (REALISM_ROADMAP WP-2). When a scenario has one,
// these values become the baseline that the seeded variant dials perturb around. Sourced from
// Open-Meteo ERA5 at authoring time; visibility/ceiling are absent from ERA5 so they stay from
// the profile. A scenario with no fixture is unaffected (bit-identical to prior behaviour).
export interface ObservedWeather {
  windKts: number
  gustKts: number
  tempF: number
  cloudCoverPct?: number
}

// Real published FAA UAS Facility Map ceilings frozen from a fixture (REALISM_ROADMAP WP-3).
//
// REAL DATA, SIMULATED AUTHORISATION — and the roadmap is emphatic that those are different
// claims (§WP-3, §17). The grid below is the FAA's published maximum altitude for *automatic*
// Part 107 authorisation through LAANC; nothing here authorises anything. The simulator's
// authorisation state stays entirely simulated and the disclaimer in complianceEngine.ts keeps
// its full "no real FAA, LAANC, USS, or drone broadcast integration" wording.
//
// Coverage is partial by design: cells exist only under charted facility maps, so 10 of the 21
// catalog scenarios have a fixture and the rest genuinely have no published grid. A scenario
// with no fixture is untouched and behaves bit-identically to pre-WP-3.
export interface AirspaceCeilingCell {
  /** Published ceiling for this grid square, feet AGL. 0 means no automatic authorisation here. */
  ceilingFt: number
  /**
   * [west, south, east, north] in degrees — the 30 x 30 arc-second UASFM grid square.
   * A plain array rather than a 4-tuple because these are imported straight from JSON, where
   * TypeScript infers `number[]`; the fetcher asserts the length and the axis-aligned shape.
   */
  bounds: number[]
}

export interface ObservedAirspace {
  source: string
  /** MAP_EFF — the FAA edition date(s). Surfaced in the UI so a stale fixture is visible (§WP-3). */
  mapEffective: string
  unit: string
  facilities: string[]
  airspaceClasses: string[]
  /** [xmin, ymin, xmax, ymax] — the AO envelope the grid was clipped to. */
  bbox: number[]
  minCeilingFt: number | null
  maxCeilingFt: number | null
  cells: AirspaceCeilingCell[]
}

export interface ScenarioWeatherProfile {
  locationTag: WeatherLocationTag
  baseConditions: {
    windKts: number
    gustKts: number
    visibilityMi: number
    ceilingFt: number
    tempF: number
  }
  possibleHazards: WeatherHazard[]
}

export interface WeatherVariantState {
  seed: number
  activeHazards: WeatherHazard[]
  windKts: number
  gustKts: number
  visibilityMi: number
  ceilingFt: number
  tempF: number
  batteryDrainMultiplier: number
  speedCapMultiplier: number
  hoverStabilityFactor: number
  sensorConfidenceFactor: number
  commsReliabilityFactor: number
  commsSignalCeilingDbm: number   // max recoverable signal; higher (less negative) in urban environments
  launchBayAvailability: Record<string, boolean>
  groundUnitEtaMultiplier: number
}

export interface ScenarioVariantConfig {
  seed: number
  timeOfDay: 'dawn' | 'day' | 'dusk' | 'night'
  season: 'spring' | 'summer' | 'fall' | 'winter'
  weatherSeverity: 0 | 1 | 2 | 3
  commsDegradation: 0 | 1 | 2
  thermalDensity: 0 | 1 | 2
  batteryPressure: 0 | 1 | 2
  terrainDifficulty: 0 | 1 | 2
}

// ─── Scenario ──────────────────────────────────────────────────────────────────
export interface ScenarioConfig {
  id: string
  name: string
  description: string
  seed: number
  droneCount: number
  missionType: MissionType
  startPosition: LatLng
  waypoints: Waypoint[]
  searchArea?: LatLng[]
  perDroneWaypoints?: Record<string, Waypoint[]>
  geofences: Geofence[]
  heatSources: HeatSource[]
  batteryStartPct: number
  batteryDrainRatePerSec: number  // % per second at cruise
  commsLossWindows: Array<{ startSec: number; durationSec: number }>
  rechargeTimeSec?: number
  maxSorties?: number
  batteryProfile?: BatteryProfile
  droneBatteryProfiles?: Record<string, BatteryProfile>
  dronePlatforms?: Record<string, PlatformId>
  rechargeStations?: RechargeStation[]
  perDroneMissionRoles?: Record<string, string>
  perDroneRechargeStations?: Record<string, LatLng[]>
  perDroneRechargeStationIds?: Record<string, string[]>
  perDroneStartPositions?: Record<string, LatLng>
  launchSites?: Record<string, LaunchRecoverySite>
  recoverySites?: Record<string, LaunchRecoverySite>
  missionBrief?: MissionBrief
  dispatchTimeline?: DispatchTimelineEntry[]
  droneRouteBriefs?: Record<string, DroneRouteBrief>
  operationalFeatures?: OperationalFeature[]
  missionObjectives?: MissionObjective[]
  weatherProfile?: ScenarioWeatherProfile
  /**
   * WP-8 RF clutter class (§18.4). Omitted ⇒ derived from `weatherProfile.locationTag`, which is
   * defensible for most scenarios; set explicitly where that tag is too coarse — Times Square and
   * the Financial District are dense urban, not the plain 'urban' their weather tag implies.
   */
  rfClutter?: ClutterClass
  // ── Custom-mission authoring (designer) ──
  // When true, enhanceScenarioForOperations preserves `authoredRoutes` as the
  // per-drone waypoints instead of overwriting them with derived safe routes.
  isCustom?: boolean
  authoredRoutes?: Record<string, Waypoint[]>       // droneId → operator-authored waypoints
  defaultLaunchAssignments?: Record<string, string> // droneId → siteId, seeds the launch plan
  defaultRecoveryAssignments?: Record<string, string> // droneId → recovery siteId
}

// ─── Mission lifecycle ───────────────────────────────────────────────────────────
// Explicit finite-state machine gating the sim loop and the run recorder.
// Only `completed` (via End Mission or a genuine terminal auto-complete) persists
// an immutable run record — pause/RTB/reset/scenario-browse never do.
export type MissionLifecycleState = 'idle' | 'preflight' | 'running' | 'paused' | 'completed'

// ─── Mobile shell surfaces ─────────────────────────────────────────────────────
// One mutually-exclusive surface is open at a time (opening one closes the prior).
// `null` (no surface) is represented at the store field, not in this union.
export type ActiveMobileSurface =
  | 'fleet'
  | 'ops'
  | 'telemetry'
  | 'evidence'
  | 'scenario'
  | 'mission'
  | 'more'
  | 'dispatch'
  | 'replay'
  | 'exports'
  | 'account'
  | 'analytics'
  | 'settings'

// ─── Custom mission definition (designer output, pre-compile) ───────────────────
export interface CustomMissionSite {
  id: string
  kind: LaunchRecoverySiteKind
  label: string
  position: LatLng
  capacityDrones?: number
}

export interface CustomMissionDefinition {
  id: string
  name: string
  locationLabel: string
  purpose: string
  endGoal: string
  center: LatLng
  droneCount: number                            // 1–8
  sites: CustomMissionSite[]
  launchAssignments: Record<string, string>     // droneId → siteId
  recoveryAssignments: Record<string, string>   // droneId → siteId
  routes: Record<string, Waypoint[]>            // droneId → authored waypoints (≤24 each)
  createdAt: number
  updatedAt: number
}

// ─── UI State ──────────────────────────────────────────────────────────────────
export type SensorMode = 'eo' | 'ir'
export type SimSpeed = 1 | 5 | 10 | 20

// Operator-toggleable map overlay categories (numbered waypoint nodes, drone
// tracks, and safety geofences are always shown and are intentionally NOT here).
export type MapLayerKey = 'relays' | 'gates' | 'recharge' | 'traffic' | 'thermal' | 'irFootprints'
export type LayerVisibility = Record<MapLayerKey, boolean>

export interface UIState {
  selectedDroneId: string | null
  sensorMode: SensorMode
  simSpeed: SimSpeed
  isRunning: boolean
  isReplayMode: boolean
  showPreflight: boolean
  showLaunchBay: boolean
  showEventLog: boolean
  layerVisibility: LayerVisibility
  /**
   * Touch route editing is active for the selected drone (mobile only). Cleared
   * whenever the selection is dropped or the mission resets, so the map can never
   * be left in edit mode with nothing selected.
   */
  routeEditMode: boolean
}

// ─── Telemetry History ─────────────────────────────────────────────────────────
export interface TelemetryPoint {
  t: number    // elapsedSec
  alt: number  // ft AGL
  bat: number  // %
  spd: number  // m/s
}

// ─── Legacy Replay (keep for backward compat in tests) ─────────────────────────
export interface DroneSnapshot {
  tick: number
  elapsedSec: number
  drones: DroneState[]
}

// ─── Mission Metrics ───────────────────────────────────────────────────────────
export interface MissionMetrics {
  totalFlightDistanceM: number
  waypointsReached: number
  conflictsDetected: number
  thermalContacts: number
  geofenceBreaches: number
  rtbTriggers: number
  recoveryDispatches: number
  groundUnitDispatch: number
}

// ─── Investor Demo / Readiness Layer ─────────────────────────────────────────
export type DemoChapterPhase = 'brief' | 'launch' | 'retask' | 'detection' | 'recovery' | 'review'
export type DemoChapterStatus = 'pending' | 'active' | 'complete'

export interface DemoChapter {
  id: string
  phase: DemoChapterPhase
  title: string
  operatorCue: string
  successSignal: string
  status: DemoChapterStatus
}

export interface InvestorDemoState {
  enabled: boolean
  currentChapterId: string | null
  completedChapterIds: string[]
  resetCount: number
  lastResetAt?: number
}

export type RemoteIdStatus = 'broadcasting' | 'degraded' | 'offline'
export type AirspaceAuthorizationKind = 'simulated_laanc' | 'field_incident_command' | 'not_required'
export type ComplianceFlagKind =
  | 'remote_id'
  | 'laanc'
  | 'altitude_limit'
  | 'bvlos'
  | 'night_ops'
  | 'operations_over_people'

export interface ComplianceFlag {
  kind: ComplianceFlagKind
  severity: DispatchPriority
  label: string
  detail: string
}

export interface AirspaceAuthorization {
  kind: AirspaceAuthorizationKind
  status: 'ready' | 'attention' | 'blocked'
  label: string
  reference: string
}

export interface ComplianceState {
  remoteId: {
    status: RemoteIdStatus
    broadcastingDroneIds: string[]
    degradedDroneIds: string[]
  }
  airspace: {
    authorization: AirspaceAuthorization
    maxObservedAltitudeFt: number
  }
  waiverFlags: ComplianceFlag[]
  checklist: ComplianceFlag[]
  disclaimer: string
}

export interface ExternalTrafficTrack {
  id: string
  label: string
  position: LatLng
  altitudeFt: number
  headingDeg: number
  speedKts: number
  risk: DispatchPriority
}

export interface AirspaceReservation {
  id: string
  label: string
  polygon: LatLng[]
  altitudeFloorFt: number
  altitudeCeilingFt: number
  status: 'active' | 'planned'
}

export interface UTMConflict {
  id: string
  droneId: string
  trafficId: string
  horizontalSeparationM: number
  verticalSeparationFt: number
  severity: DispatchPriority
}

export interface UTMAirspaceState {
  externalTracks: ExternalTrafficTrack[]
  reservations: AirspaceReservation[]
  conflicts: UTMConflict[]
  coordinationMode: string
}

// Every field here is measured from simulation state — no synthetic "ROI" projections.
// (An earlier responseTimeSavedMin / routeRiskReductionPct pair was removed: both were
// arbitrary formulas presented as outcomes, which is exactly what diligence flags.)
export interface MissionOutcomeSummary {
  headline: string
  missionTimeSec: number
  searchCoveragePct: number
  detectedContacts: number
  resolvedContacts: number
  fleetHealthScore: number
  evidenceEvents: number
  exportReady: boolean
}

export interface AfterActionPackage {
  kind: 'after_action_package'
  generatedAt: string
  scenarioId: string
  scenarioName: string
  scenarioVariant: ScenarioVariantConfig
  missionReport: {
    title: string
    summary: string
    replayFrameCount: number
    eventCount: number
  }
  outcome: MissionOutcomeSummary
  compliance: ComplianceState
  utm: UTMAirspaceState
  evidence: {
    chainHash: string
    chainVerified: boolean   // result of verifyChain() over the full event log at export time
    kpiCount: number
    droneCount: number
    positionSampleCount: number
  }
}
// ─── MAVLink ───────────────────────────────────────────────────────────────────
export interface MAVLinkMessage {
  msgId: number
  msgName: string
  systemId: number
  timestamp: number
  fields: Record<string, number | string>
}
