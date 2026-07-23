import { useDroneStore } from '@/store/droneStore'
import { stepDrone } from '@/sim/drone/DroneEntity'
import { platformForDrone } from '@/sim/drone/platformCatalog'
import { getNextCommand, type MissionManagerState } from '@/sim/mission/MissionManager'
import { detectConflicts, applyConflictFlags, getAssignedAltitude } from '@/sim/safety/DeconflictEngine'
import { applyGeofenceFlags, applyCommsModel, applySurfaceClearanceSafety } from '@/sim/safety/SafetyManager'
import { buildSafeDroneRoutes } from '@/sim/mission/routeAudit'
import { validateOperatorRoute } from '@/sim/mission/operatorRoutes'
import { restoreSavedWaypointRoutes } from '@/sim/mission/waypointPersistence'
import { buildLaunchSlotsForPlan } from '@/sim/mission/launchPlanGeometry'
import { resolveLaunchSite } from '@/sim/mission/siteResolver'
import { recoverySiteIdForDrone } from '@/sim/mission/siteAssignments'
import {
  batteryProfileForDrone,
  batteryReservePctForDrone,
  chargeRateMultiplierForDrone,
  effectiveBatteryDrainRateForDrone,
  selectRechargeStationForDrone,
} from '@/sim/mission/rechargeStations'
import { checkThermalDetections } from '@/sim/sensors/ThermalSim'
import { evaluateGnss } from '@/sim/nav/gnss'
import { occlusionEpoch, type TerrainOcclusionService } from '@/sim/terrain/OcclusionService'
import { occlusionServiceFor } from '@/scenarios/terrainFixtures'
import { constellationAt, constellationFor, type ConstellationFixture } from '@/scenarios/constellationFixtures'
import { laneForScenario } from '@/scenarios/nistLanes'
import {
  featureRangesM,
  LANE_FEATURE_EVENT,
  resolvableFeatureIndex,
  type NistLaneDefinition,
} from '@/sim/mission/laneScoring'
import { isWeatherForceRtb } from '@/sim/weather/weatherEngine'
import { tickGroundUnit, computeGroundUnitEta } from '@/sim/mission/groundUnits'
import { tickRecoveryTeam, tickRecoveryExtraction, needsRecovery, recoveryTransitionState, createRecoveryTeam } from '@/sim/mission/recoveryManager'
import { bearingDeg, haversineDistanceM } from '@/utils/geometry'
import type { DroneState, EventType, FullMissionFrame, LatLng, LaunchBayPlan, MissionCompletionReason, Waypoint } from '@/types'

const THERMAL_CHECK_INTERVAL = 50
const SNAPSHOT_INTERVAL = 40
/** 20 ticks = 1 Hz, matching OCCLUSION_UPDATE_HZ — see the GNSS pass for why (§4.5). */
const GNSS_CHECK_INTERVAL = 20
/** 5 ticks = 4 Hz. Fine enough that a transiting aircraft cannot skip past a target.
 *  Guarded by a range reject, so the ray march only runs for targets actually in reach. */
const LANE_CHECK_INTERVAL = 5
/** Largest feature's acuity range — nothing is resolvable beyond it. */
const LANE_MAX_FEATURE_RANGE_M = Math.max(...featureRangesM())
const FT_TO_M = 0.3048
const FIXED_DT = 0.05
const TELEMETRY_SAMPLE_INTERVAL = 10
const TICK_INTERVAL_MS = 50
const INSPECT_CONFIDENCE_THRESHOLD = 0.75
const NON_INSPECTABLE_STATES = new Set<DroneState['missionState']>([
  'idle', 'preflight', 'launch', 'avoid', 'emergency', 'landed', 'recharge',
  'inspect', 'thermal_hold', 'return_to_base', 'remote_landed', 'stranded',
  'recovery_requested', 'recovery_enroute', 'recovered', 'unrecoverable_sim',
])

// A mission is genuinely over once every drone that lifted off has come to rest in a
// terminal grounded state. `launchTimeSec` is stamped on the first 'launch' transition and
// never cleared mid-mission, so it distinguishes "landed after flying" from "never launched".
const TERMINAL_GROUNDED_STATES = new Set<DroneState['missionState']>(['landed', 'recovered', 'unrecoverable_sim'])

function isMissionComplete(drones: DroneState[]): boolean {
  if (drones.length === 0) return false
  return drones.every((d) => d.launchTimeSec !== undefined && TERMINAL_GROUNDED_STATES.has(d.missionState))
}

// ephemeral state — not in store
const lastPositions = new Map<string, LatLng>()
const onSceneTicksMap = new Map<string, number>()  // recoveryTeamId → ticks on scene
let missionOcclusion: TerrainOcclusionService | undefined
let missionConstellation: ConstellationFixture | undefined
let missionLane: NistLaneDefinition | undefined
/** Per-run memo preventing duplicate identification EVENTS. The score is always refolded
 *  from the events themselves, so this can never be the source of truth. */
const laneIdentified = new Set<string>()

/**
 * One fixed-timestep tick (runs `simSpeed` physics sub-steps). Exported so tests and the
 * setInterval fallback can drive the REAL production step directly — never reimplement it.
 */
export function tick() {
  const store = useDroneStore.getState()
  if (!store.ui.isRunning) return

  const stepsPerFrame = store.ui.simSpeed

  for (let i = 0; i < stepsPerFrame; i++) {
    const {
      drones, scenario, tick: currentTick, elapsedSec, weatherState, launchCommandedSec,
      siteOverrides, siteRelocations,
    } = useDroneStore.getState()
    if (!scenario) break

    // Occlusion is evaluated at 1 Hz from simulation time, never wall time. A
    // mission without a committed terrain fixture simply has no LOS service.
    missionOcclusion?.setEpoch(occlusionEpoch(elapsedSec))

    const { droneWaypoints } = useDroneStore.getState()

    const telemetryBatch: Array<{ id: string; t: number; alt: number; bat: number; spd: number; pos: LatLng }> = []

    const updatedDrones = drones.map((drone) => {
      const stationSortieCount = drone.missionState === 'recharge'
        ? Math.max(0, (drone.sortieCount ?? 0) - 1)
        : (drone.sortieCount ?? 0)
      const selectedRechargeStation = selectRechargeStationForDrone({
        scenario,
        droneId: drone.id,
        sortieCount: stationSortieCount,
        currentWaypointIndex: drone.currentWaypointIndex,
      })
      const recoverySiteId = recoverySiteIdForDrone(scenario, drone.id)
      const recoverySite = recoverySiteId
        ? resolveLaunchSite(scenario, recoverySiteId, siteOverrides)
        : undefined
      const basePos = selectedRechargeStation?.position ?? recoverySite?.position ?? scenario.startPosition
      const recoveryRelocation = recoverySiteId ? siteRelocations[recoverySiteId] : undefined
      const baseWaypoint: Waypoint = {
        id: `base-${drone.sortieCount}`,
        position: basePos,
        altitudeFt: 0,
        label: selectedRechargeStation?.station.label ?? recoverySite?.label ?? 'Base',
      }
      const batteryProfile = batteryProfileForDrone(scenario, drone.id)
      // Apply weather battery drain multiplier
      const batteryDrainRatePerSec = effectiveBatteryDrainRateForDrone(scenario, drone.id) * weatherState.batteryDrainMultiplier
      const mm: MissionManagerState = {
        waypoints: scenario.waypoints,
        basePosition: baseWaypoint,
        elapsedSec,
        tick: currentTick,
        assignedAltitudeFt: getAssignedAltitude(drone.id, drones),
        droneWaypoints,
        rechargeTimeSec: scenario.rechargeTimeSec,
        maxSorties: scenario.maxSorties,
        batteryReservePct: batteryReservePctForDrone(scenario, drone.id),
        weatherForceRtb: isWeatherForceRtb(weatherState),
        weatherHazard: weatherState.activeHazards[0],
        launchCommandedSec: launchCommandedSec ?? undefined,
        baseAvailable: selectedRechargeStation !== null
          || recoveryRelocation === undefined
          || elapsedSec >= recoveryRelocation.availableAtSec,
      }

      const { cmd: rawCmd, nextState, nextWaypointIndex, hoverStartSec, rechargeStartSec, sortieResumeWpIdx } = getNextCommand(drone, mm)

      // Skip physics for grounded/recovery states — drone is not airborne, battery shouldn't drain
      const isGrounded = ['idle', 'preflight', 'landed', 'remote_landed', 'stranded', 'recovery_requested', 'recovery_enroute', 'recovered', 'unrecoverable_sim'].includes(nextState)

      // Apply weather speed cap via throttle reduction
      const cmd = isGrounded
        ? rawCmd
        : { ...rawCmd, throttle: ((rawCmd.throttle ?? 1) * weatherState.speedCapMultiplier) }

      const prevState = drone.missionState
      const prevWpIdx = drone.currentWaypointIndex
      const stateChanged = prevState !== nextState
      const wpAdvanced = (nextWaypointIndex > prevWpIdx && nextState === 'navigate') ||
        (prevState === 'hover' && (nextState === 'navigate' || nextState === 'return_to_base'))

      const hoverPatch: { hoverStartSec?: number } =
        hoverStartSec !== undefined ? { hoverStartSec }
        : nextState !== 'hover'    ? { hoverStartSec: undefined }
        : {}

      const rechargePatch: Partial<typeof drone> = {}

      if (sortieResumeWpIdx !== undefined && drone.sortieResumeWpIdx === undefined) {
        rechargePatch.sortieResumeWpIdx = sortieResumeWpIdx
      }
      if (rechargeStartSec !== undefined) {
        rechargePatch.rechargeStartSec = rechargeStartSec
        rechargePatch.sortieCount = (drone.sortieCount ?? 0) + 1
      }
      if (drone.missionState === 'recharge' && nextState === 'recharge' && mm.rechargeTimeSec) {
        const chargePerTick = 80 / mm.rechargeTimeSec * chargeRateMultiplierForDrone(scenario, drone.id) * FIXED_DT
        rechargePatch.batteryPct = Math.min(100, drone.batteryPct + chargePerTick)
      }

      let wpIdxForDrone = nextWaypointIndex
      if (drone.missionState === 'recharge' && nextState === 'launch') {
        wpIdxForDrone = drone.sortieResumeWpIdx ?? 0
        rechargePatch.rechargeStartSec = undefined
        rechargePatch.sortieResumeWpIdx = undefined
        rechargePatch.batteryPct = 100
      }

      const launchPatch: { launchTimeSec?: number } = {}
      if (nextState === 'launch' && drone.launchTimeSec === undefined) {
        launchPatch.launchTimeSec = elapsedSec
      }

      const emergencyPatch: { emergencyStartSec?: number } =
        nextState === 'emergency' && drone.emergencyStartSec === undefined ? { emergencyStartSec: elapsedSec }
        : nextState !== 'emergency' ? { emergencyStartSec: undefined }
        : {}

      const thermalHoldPatch: { thermalHoldStartSec?: number } =
        nextState === 'thermal_hold' && drone.thermalHoldStartSec === undefined ? { thermalHoldStartSec: elapsedSec }
        : nextState !== 'thermal_hold' ? { thermalHoldStartSec: undefined }
        : {}

      // Clear avoidance bookkeeping once the maneuver window ends (entry fields are set by
      // the conflict-avoidance pass below, not here).
      const avoidPatch: Partial<DroneState> =
        nextState !== 'avoid' && drone.avoidStartSec !== undefined
          ? { avoidStartSec: undefined, avoidHeadingDeg: undefined, avoidReturnState: undefined }
          : {}

      const updated = isGrounded
        ? { ...drone, missionState: nextState, currentWaypointIndex: wpIdxForDrone, ...hoverPatch, ...rechargePatch, ...launchPatch, ...emergencyPatch, ...thermalHoldPatch, ...avoidPatch }
        : stepDrone(
            { ...drone, missionState: nextState, currentWaypointIndex: wpIdxForDrone, ...hoverPatch, ...rechargePatch, ...launchPatch, ...emergencyPatch, ...thermalHoldPatch, ...avoidPatch },
            { ...cmd, batteryDrainRatePerSec },
            FIXED_DT,
            platformForDrone(scenario, drone.id),
          )

      // Emit chain-of-custody events for significant transitions
      if (stateChanged || wpAdvanced) {
        let eventType: EventType
        let payload: Record<string, unknown>

        if (stateChanged && nextState === 'emergency') {
          eventType = 'emergency_land'
          payload = { from: prevState, batteryPct: Math.round(drone.batteryPct), altitudeFt: Math.round(drone.altitudeFt) }
        } else if (stateChanged && nextState === 'return_to_base') {
          const weatherForced = mm.weatherForceRtb && !drone.geofenceBreachFlag && drone.batteryPct >= (batteryProfile?.reservePct ?? 25)
          if (weatherForced) {
            eventType = 'weather_divert'
            payload = {
              from: prevState,
              hazard: mm.weatherHazard ?? 'severe conditions',
              targetSafeZone: baseWaypoint.label ?? 'base',
              batteryPct: Math.round(drone.batteryPct),
            }
          } else {
            eventType = 'rtb_triggered'
            const reason = drone.geofenceBreachFlag
              ? 'geofence_breach'
              : drone.batteryPct < (batteryProfile?.reservePct ?? 25) ? 'low_battery'
              : 'operator_command'
            payload = {
              from: prevState,
              reason,
              batteryPct: Math.round(drone.batteryPct),
              geofenceId: drone.geofenceBreach?.id,
              rechargeStationId: selectedRechargeStation?.station.id,
            }
          }
        } else if (stateChanged && nextState === 'route_complete_loiter') {
          eventType = 'route_complete'
          payload = {
            batteryRemaining: Math.round(drone.batteryPct),
            totalTicks: currentTick,
            position: drone.position,
          }
        } else if (stateChanged && nextState === 'landed') {
          eventType = 'mission_complete'
          payload = { batteryRemaining: Math.round(drone.batteryPct), totalTicks: currentTick }
        } else if (stateChanged && nextState === 'recharge') {
          eventType = 'recharge_start'
          payload = {
            batteryPct: Math.round(drone.batteryPct),
            sortieNum: (drone.sortieCount ?? 0) + 1,
            elapsedSec: Math.round(elapsedSec),
            rechargeStationId: selectedRechargeStation?.station.id,
          }
        } else if (stateChanged && prevState === 'recharge' && nextState === 'launch') {
          eventType = 'sortie_launch'
          payload = { sortieNum: drone.sortieCount ?? 0, resumeWpIdx: drone.sortieResumeWpIdx ?? 0 }
        } else if (stateChanged && prevState === 'avoid') {
          eventType = 'avoidance_complete'
          payload = { resumedState: nextState, headingDeg: Math.round(drone.headingDeg) }
        } else if (wpAdvanced) {
          eventType = 'waypoint_reached'
          payload = { waypointIndex: prevWpIdx, nextWaypointIndex, elapsedSec: Math.round(elapsedSec) }
        } else {
          eventType = 'state_change'
          payload = { from: prevState, to: nextState }
        }

        useDroneStore.getState().emitEvent({ eventType, droneId: drone.id, tick: currentTick, payload })
        const { metrics } = useDroneStore.getState()
        if (eventType === 'waypoint_reached') useDroneStore.getState().updateMetrics({ waypointsReached: metrics.waypointsReached + 1 })
        if (eventType === 'rtb_triggered') useDroneStore.getState().updateMetrics({ rtbTriggers: metrics.rtbTriggers + 1 })
      }

      if (currentTick % TELEMETRY_SAMPLE_INTERVAL === 0) {
        telemetryBatch.push({
          id: drone.id,
          t: Math.round(elapsedSec * 10) / 10,
          alt: Math.round(updated.altitudeFt),
          bat: Math.round(updated.batteryPct * 10) / 10,
          spd: Math.round(updated.speedMs * 10) / 10,
          pos: updated.position,
        })
      }

      return updated
    })

    if (telemetryBatch.length > 0) {
      const st = useDroneStore.getState()
      for (const e of telemetryBatch) {
        st.addTelemetryPoint(e.id, { t: e.t, alt: e.alt, bat: e.bat, spd: e.spd })
        st.addPositionSample(e.id, e.pos)
      }
    }

    // ── Safety passes ──────────────────────────────────────────────────────────
    const withGeo = applyGeofenceFlags(updatedDrones, scenario.geofences)
    const withComms = applyCommsModel(withGeo, elapsedSec, scenario, weatherState, missionOcclusion)
    const conflicts = detectConflicts(withComms, missionOcclusion)
    const flaggedDrones = applyConflictFlags(withComms, conflicts)
    const surfaceSafety = applySurfaceClearanceSafety(flaggedDrones, missionOcclusion)
    const surfaceHazards = new Map(surfaceSafety.hazards.map((hazard) => [hazard.droneId, hazard]))
    const surfaceSafeDrones = surfaceSafety.drones

    for (const drone of surfaceSafeDrones) {
      const hazard = surfaceHazards.get(drone.id)
      const before = flaggedDrones.find((candidate) => candidate.id === drone.id)
      if (!hazard || !before || drone.missionState !== 'emergency' || before.missionState === 'emergency') continue
      useDroneStore.getState().emitEvent({
        eventType: 'emergency_land',
        droneId: drone.id,
        tick: currentTick,
        payload: {
          from: before.missionState,
          reason: 'surface_clearance',
          surfaceKind: hazard.kind,
          clearanceFt: Math.round(hazard.clearanceFt * 10) / 10,
          minimumClearanceFt: hazard.minimumClearanceFt,
        },
      })
    }

    // ── Conflict avoidance: the give-way drone diverges ───────────────────────
    // For each detected pair the second aircraft (idB) is the give-way drone: it breaks off
    // onto a divergence heading pointing directly away from the other aircraft, holds it for
    // AVOID_MANEUVER_SEC (see MissionManager), then resumes its interrupted task. Completion
    // is emitted through the standard state-transition path as avoidance_complete.
    // 'launch' is included: fleets spawn from adjacent launch points a few meters apart, so
    // climb-out is where conflicts actually occur in practice (cruise altitude bands are
    // separated enough that conflicts rarely happen once established) — excluding 'launch'
    // meant the maneuver almost never fired outside forced/artificial scenarios.
    const withDeconflict: DroneState[] = surfaceSafeDrones.map((drone) => {
      if (!['navigate', 'sar_grid', 'launch'].includes(drone.missionState)) return drone
      const conflict = conflicts.find((c) => c.idB === drone.id)
      if (!conflict) return drone
      const other = surfaceSafeDrones.find((d) => d.id === conflict.idA)
      if (!other) return drone
      const divergenceHeading = bearingDeg(other.position, drone.position)
      useDroneStore.getState().emitEvent({
        eventType: 'avoidance_start',
        droneId: drone.id,
        tick: currentTick,
        payload: {
          conflictWith: conflict.idA,
          divergenceHeadingDeg: Math.round(divergenceHeading),
          horizDistM: Math.round(conflict.horizDistM),
          vertDistFt: Math.round(conflict.vertDistFt),
        },
      })
      return {
        ...drone,
        missionState: 'avoid' as const,
        avoidStartSec: elapsedSec,
        avoidHeadingDeg: divergenceHeading,
        avoidReturnState: drone.missionState,
      }
    })

    // Track comms loss duration on each drone; snapshot position at first dropout.
    // Drones continue their flight plan during comms loss — no loiter/hover injected here.
    // When signal restores, emit comms_restored so command knows the drone is still on task.
    const withCommsTracking: DroneState[] = withDeconflict.map((drone) => {
      if (drone.signalDbm < -90 && !['landed', 'idle', 'recovered'].includes(drone.missionState)) {
        const firstDrop = (drone.commsLostSec ?? 0) === 0
        return {
          ...drone,
          commsLostSec: (drone.commsLostSec ?? 0) + FIXED_DT,
          lastKnownPosition: firstDrop ? drone.position : drone.lastKnownPosition,
        }
      }

      // Signal restored — was previously lost
      const wasLost = (drone.commsLostSec ?? 0) > 0
      if (wasLost) {
        useDroneStore.getState().emitEvent({
          eventType: 'comms_restored',
          droneId: drone.id,
          tick: currentTick,
          payload: {
            lostDurationSec: Math.round(drone.commsLostSec ?? 0),
            missionState: drone.missionState,
            waypointIndex: drone.currentWaypointIndex,
            batteryPct: Math.round(drone.batteryPct),
            position: drone.position,
            status: 'on_task',
          },
        })
      }

      return { ...drone, commsLostSec: 0, lastKnownPosition: undefined }
    })

    // Emit conflict events (throttled)
    if (conflicts.length > 0 && currentTick % 20 === 0) {
      useDroneStore.getState().emitEvent({
        eventType: 'conflict_detected',
        droneId: conflicts[0].idA,
        tick: currentTick,
        payload: {
          conflictWith: conflicts[0].idB,
          horizDistM: Math.round(conflicts[0].horizDistM),
          vertDistFt: Math.round(conflicts[0].vertDistFt),
        },
      })
      const { metrics } = useDroneStore.getState()
      useDroneStore.getState().updateMetrics({ conflictsDetected: metrics.conflictsDetected + 1 })
    }

    // Emit geofence breach events (throttled)
    const breachedDrone = withCommsTracking.find((d) => d.geofenceBreachFlag)
    if (breachedDrone && currentTick % 20 === 0) {
      useDroneStore.getState().emitEvent({
        eventType: 'geofence_breach',
        droneId: breachedDrone.id,
        tick: currentTick,
        payload: {
          position: breachedDrone.position,
          altitudeFt: Math.round(breachedDrone.altitudeFt),
          geofenceId: breachedDrone.geofenceBreach?.id,
        },
      })
      const { metrics } = useDroneStore.getState()
      useDroneStore.getState().updateMetrics({ geofenceBreaches: metrics.geofenceBreaches + 1 })
    }

    // Emit comms degradation events (throttled)
    const commsDrone = withCommsTracking.find((d) => d.signalDbm < -80)
    if (commsDrone && currentTick % 40 === 0) {
      const eventType: EventType = commsDrone.signalDbm < -90 ? 'comms_lost' : 'comms_degraded'
      useDroneStore.getState().emitEvent({
        eventType,
        droneId: commsDrone.id,
        tick: currentTick,
        payload: {
          signalDbm: Math.round(commsDrone.signalDbm),
          ...(eventType === 'comms_lost' ? { position: commsDrone.lastKnownPosition ?? commsDrone.position } : {}),
        },
      })
    }

    // ── Drone recovery detection ───────────────────────────────────────────────
    const { recoveryTeams } = useDroneStore.getState()
    const existingTeamDroneIds = new Set(recoveryTeams.map((t) => t.droneId))
    const finalDrones: DroneState[] = withCommsTracking.map((drone) => {
      if (!needsRecovery(drone, existingTeamDroneIds, elapsedSec)) return drone
      const newState = recoveryTransitionState(drone)
      if (newState === drone.missionState) return drone

      // Transition drone to recovery state
      useDroneStore.getState().emitEvent({
        eventType: 'drone_recovery_requested',
        droneId: drone.id,
        tick: currentTick,
        payload: {
          from: drone.missionState,
          batteryPct: Math.round(drone.batteryPct),
          position: drone.position,
          commsLostSec: drone.commsLostSec,
        },
      })

      // Dispatch a recovery team from staging
      const stagingPos = scenario.startPosition
      const teamId = `recovery-${drone.id}-${currentTick}`
      const team = createRecoveryTeam(teamId, drone.id, stagingPos, drone.position, weatherState)
      useDroneStore.getState().addRecoveryTeam(team)
      const { metrics } = useDroneStore.getState()
      useDroneStore.getState().updateMetrics({ recoveryDispatches: metrics.recoveryDispatches + 1 })

      return { ...drone, missionState: newState }
    })

    // ── Tick recovery teams ────────────────────────────────────────────────────
    const { recoveryTeams: currentTeams } = useDroneStore.getState()
    for (const team of currentTeams) {
      if (team.status === 'extracted') continue
      const drone = finalDrones.find((d) => d.id === team.droneId)

      if (team.status === 'on_scene') {
        const onScene = (onSceneTicksMap.get(team.id) ?? 0) + 1
        onSceneTicksMap.set(team.id, onScene)
        const updated = tickRecoveryExtraction(team, onScene)
        useDroneStore.getState().updateRecoveryTeam(team.id, updated)
        if (updated.status === 'extracted') {
          // Mark drone as recovered so it's no longer grounded — finalDrones is what
          // setDrones() applies at the end of this tick, so mutate it directly here.
          const finalDroneIdx = finalDrones.findIndex((d) => d.id === team.droneId)
          if (finalDroneIdx !== -1) finalDrones[finalDroneIdx] = { ...finalDrones[finalDroneIdx], missionState: 'recovered' }
          useDroneStore.getState().emitEvent({
            eventType: 'drone_recovered',
            droneId: team.droneId,
            tick: currentTick,
            payload: { teamId: team.id },
          })
        }
      } else if (team.status === 'enroute' && drone) {
        const updated = tickRecoveryTeam(team, weatherState, FIXED_DT * stepsPerFrame)
        useDroneStore.getState().updateRecoveryTeam(team.id, updated)
        if (updated.status === 'on_scene') {
          useDroneStore.getState().emitEvent({
            eventType: 'ground_unit_on_scene',
            droneId: team.droneId,
            tick: currentTick,
            payload: { teamId: team.id },
          })
        }
      }
    }

    // ── Tick ground units toward thermal contacts ──────────────────────────────
    const { groundUnits, thermalContacts } = useDroneStore.getState()
    for (const unit of groundUnits) {
      if (unit.status !== 'enroute' || !unit.targetThermalId) continue
      const contact = thermalContacts.find((c) => c.sourceId === unit.targetThermalId)
      if (!contact) continue
      const etaBefore = unit.etaSec ?? 9999
      const updated = tickGroundUnit(unit, contact.position, weatherState, FIXED_DT * stepsPerFrame)
      useDroneStore.getState().updateGroundUnit(unit.id, updated)
      // Emit on_scene event once
      if (updated.status === 'on_scene') {
        useDroneStore.getState().emitEvent({
          eventType: 'ground_unit_on_scene',
          droneId: 'system',
          tick: currentTick,
          payload: {
            unitId: unit.id,
            thermalId: unit.targetThermalId,
            etaWas: etaBefore,
          },
        })
      }
    }

    // ── Compute ETA on first dispatch tick ─────────────────────────────────────
    const { groundUnits: gus } = useDroneStore.getState()
    for (const unit of gus) {
      if (unit.status === 'enroute' && !unit.etaComputed && unit.targetThermalId) {
        const contact = thermalContacts.find((c) => c.sourceId === unit.targetThermalId)
        if (contact) {
          const eta = computeGroundUnitEta(unit.position, contact.position, weatherState)
          useDroneStore.getState().updateGroundUnit(unit.id, { etaSec: eta, etaComputed: true })
        }
      }
    }

    // ── Thermal sensor check ───────────────────────────────────────────────────
    if (currentTick % THERMAL_CHECK_INTERVAL === 0 && scenario.heatSources.length > 0) {
      for (const drone of finalDrones) {
        const detections = checkThermalDetections(
          drone,
          scenario.heatSources,
          currentTick,
          scenario.seed,
          {
            platform: platformForDrone(scenario, drone.id),
            weather: weatherState,
            occlusion: missionOcclusion,
          },
        )
        for (const det of detections) {
          useDroneStore.getState().addThermalContact(det)
          const storedContact = useDroneStore.getState().thermalContacts.find(
            (contact) => contact.sourceId === det.sourceId,
          )
          const operationalConfidence = storedContact?.weatherAdjustedConfidence ?? det.confidence
          const { metrics } = useDroneStore.getState()
          useDroneStore.getState().updateMetrics({ thermalContacts: metrics.thermalContacts + 1 })
          useDroneStore.getState().emitEvent({
            eventType: 'thermal_detection',
            droneId: drone.id,
            tick: currentTick,
            payload: {
              sourceId: det.sourceId,
              class: det.class,
              confidence: Math.round(operationalConfidence * 100),
              rawConfidence: Math.round(det.confidence * 100),
              position: det.position,
            },
          })

          // High-confidence contact triggers a brief automatic hover-and-confirm
          // instead of leaving the operator's only options as "ignore" or manual hover.
          if (operationalConfidence >= INSPECT_CONFIDENCE_THRESHOLD && !NON_INSPECTABLE_STATES.has(drone.missionState)) {
            const idx = finalDrones.findIndex((d) => d.id === drone.id)
            if (idx !== -1 && finalDrones[idx].missionState !== 'inspect') {
              finalDrones[idx] = {
                ...finalDrones[idx],
                missionState: 'inspect',
                inspectStartSec: elapsedSec,
                inspectReturnState: finalDrones[idx].missionState,
              }
            }
          }
        }
      }
    }

    // ── NIST lane: feature identification (WP-9) ───────────────────────────────
    //
    // A feature counts when the aircraft is close enough for it to be RESOLVABLE (the acuity
    // range from laneScoring) and has clear line of sight to the target face (WP-4). Neither is
    // a proximity trigger and neither is scripted.
    //
    // Identifications are emitted as evidence events, so the score is a fold over the same
    // tamper-evident chain as the rest of the after-action package and replays identically.
    // `laneIdentified` is a per-run memo that only prevents duplicate EVENTS; the score itself is
    // always recomputed from events, so nothing here can desynchronise it.
    if (missionLane && currentTick % LANE_CHECK_INTERVAL === 0) {
      for (const drone of finalDrones) {
        if (drone.altitudeFt < 2) continue
        const droneGroundM = missionOcclusion?.groundElevation(drone.position.lat, drone.position.lng) ?? 0
        const droneMslM = droneGroundM + drone.altitudeFt * FT_TO_M

        for (const target of missionLane.targets) {
          const targetGroundM = missionOcclusion?.groundElevation(target.position.lat, target.position.lng) ?? 0
          const targetMslM = targetGroundM + target.heightAglM
          const horizontalM = haversineDistanceM(drone.position, target.position)
          const slantRangeM = Math.hypot(horizontalM, droneMslM - targetMslM)

          // Cheap reject before paying for a ray march: nothing is resolvable past the largest
          // feature's range, and the lane has 20 targets checked several times a second.
          if (slantRangeM > LANE_MAX_FEATURE_RANGE_M) continue

          const los = missionOcclusion
            ? missionOcclusion.hasLineOfSight(
                { ...drone.position, altMslM: droneMslM },
                { ...target.position, altMslM: targetMslM },
              ).clear
            : true

          const best = resolvableFeatureIndex({
            observer: { position: drone.position, altMslM: droneMslM },
            target,
            targetMslM,
            hasLineOfSight: los,
            slantRangeM,
          })
          if (best < 0) continue

          // Features are cumulative: resolving index k means every larger feature is resolved too.
          for (let index = 0; index <= best; index += 1) {
            const key = `${target.id}#${index}`
            if (laneIdentified.has(key)) continue
            laneIdentified.add(key)
            useDroneStore.getState().emitEvent({
              eventType: LANE_FEATURE_EVENT,
              droneId: drone.id,
              tick: currentTick,
              payload: {
                laneId: missionLane.id,
                targetId: target.id,
                featureIndex: index,
                elapsedSec: Math.round(elapsedSec * 10) / 10,
                slantRangeM: Math.round(slantRangeM * 10) / 10,
              },
            })
          }
        }
      }
    }

    // ── GNSS: sky occlusion → DOP → reported position (WP-7) ───────────────────
    //
    // Runs at the 1 Hz occlusion epoch, not the 20 Hz tick. §4.5's rule: satellite geometry and
    // building shadows change slowly relative to the sim step, and skyVisibility() marches a ray
    // per satellite, so this is a 20× saving for no fidelity loss. Between evaluations each
    // drone keeps the fix it last computed.
    //
    // Truth is never touched. `drone.position` remains what the sim flies; only the reported
    // fields change, which is exactly the gap the operator is being trained to notice.
    if (missionConstellation && currentTick % GNSS_CHECK_INTERVAL === 0) {
      const looks = constellationAt(missionConstellation, elapsedSec)
      if (looks.length > 0) {
        for (let i = 0; i < finalDrones.length; i += 1) {
          const drone = finalDrones[i]
          const groundM = missionOcclusion?.groundElevation(drone.position.lat, drone.position.lng) ?? 0
          const gnss = evaluateGnss({
            droneId: drone.id,
            position: drone.position,
            altMslM: groundM + drone.altitudeFt * FT_TO_M,
            constellation: looks,
            occlusion: missionOcclusion,
            seed: scenario.seed,
            tick: currentTick,
            elapsedSec,
            lastReported: drone.reportedPosition,
          })

          finalDrones[i] = {
            ...drone,
            reportedPosition: gnss.reportedPosition,
            hdop: gnss.hdop,
            satsVisible: gnss.satsVisible,
            satsInView: gnss.satsInView,
            gnssHorizontalErrorM: gnss.horizontalErrorM,
            fixQuality: gnss.fixQuality,
          }

          // Emit only on transition. A degraded fix is a standing condition, not an event per
          // second, and the chain-of-custody log is evidence rather than a sampler.
          if (gnss.fixQuality !== (drone.fixQuality ?? 'fix')) {
            useDroneStore.getState().emitEvent({
              eventType: gnss.fixQuality === 'no_fix' ? 'gnss_fix_lost' : 'gnss_fix_changed',
              droneId: drone.id,
              tick: currentTick,
              payload: {
                fixQuality: gnss.fixQuality,
                from: drone.fixQuality ?? 'fix',
                satsVisible: gnss.satsVisible,
                satsInView: gnss.satsInView,
                hdop: gnss.hdop === null ? null : Math.round(gnss.hdop * 100) / 100,
                horizontalErrorM: gnss.horizontalErrorM === null ? null : Math.round(gnss.horizontalErrorM * 10) / 10,
                ...(gnss.lossReason ? { reason: gnss.lossReason } : {}),
              },
            })
          }
        }
      }
    }

    // ── Accumulate flight distance ─────────────────────────────────────────────
    let distanceDeltaM = 0
    for (const drone of finalDrones) {
      if (['navigate', 'sar_grid', 'return_to_base'].includes(drone.missionState)) {
        const prev = lastPositions.get(drone.id)
        if (prev) distanceDeltaM += haversineDistanceM(prev, drone.position)
        lastPositions.set(drone.id, drone.position)
      }
    }
    if (distanceDeltaM > 0) {
      const { metrics } = useDroneStore.getState()
      useDroneStore.getState().updateMetrics({ totalFlightDistanceM: metrics.totalFlightDistanceM + distanceDeltaM })
    }

    // ── Save full replay frame ─────────────────────────────────────────────────
    if (currentTick % SNAPSHOT_INTERVAL === 0) {
      const { thermalContacts: tc, groundUnits: gu, recoveryTeams: rt, events: ev } = useDroneStore.getState()
      const frame: FullMissionFrame = {
        tick: currentTick,
        elapsedSec,
        drones: finalDrones.map((d) => ({ ...d })),
        thermalContacts: tc.map((c) => ({ ...c })),
        groundUnits: gu.map((u) => ({ ...u })),
        recoveryTeams: rt.map((t) => ({ ...t })),
        weatherState: { ...weatherState },
        activeEventIds: ev.slice(-50).map((e) => e.hash),
      }
      useDroneStore.getState().addReplayFrame(frame)
    }

    useDroneStore.getState().setDrones(finalDrones)
    useDroneStore.getState().incrementTick()

    // Terminal auto-complete: once the whole fleet has launched and landed, the mission is
    // genuinely over. Finalize exactly once (endMission is idempotent) and stop stepping —
    // this is the ONLY tick-driven finalize path.
    if (isMissionComplete(finalDrones)) {
      endMission('all_drones_complete')
      break
    }
  }
}

// ─── Loop driver: fixed-timestep accumulator on requestAnimationFrame ─────────
//
// The previous driver was a bare setInterval(tick, 50). Browsers throttle timers in hidden
// tabs (measured in the audit: an 11× silent slowdown at 5× speed), so sim time silently
// diverged from its nominal rate with no indication to the operator.
//
// New contract:
//  - Sim pacing accumulates real frame deltas and runs whole FIXED_DT steps — physics stays
//    byte-identical (results depend only on step count, never wall time).
//  - Hidden tab = honest pause. rAF stops firing; on return the accumulator and frame clock
//    reset, so the mission resumes exactly where it paused — no fast-forward burst.
//  - A per-frame catch-up cap absorbs ordinary hiccups (GC, brief stalls) but drops larger
//    time debt rather than bursting through it.
//  - Non-browser environments (vitest node env) fall back to setInterval; tests may also call
//    the exported tick() directly.

const MAX_CATCHUP_STEPS_PER_FRAME = 4

let rafId: number | null = null
let intervalId: ReturnType<typeof setInterval> | null = null
let accumulatorMs = 0
let lastFrameTs: number | null = null

/** Pure accumulator step: how many ticks to run for an elapsed delta, with capped catch-up.
 *  Exported for unit tests. */
export function advanceAccumulator(
  accMs: number,
  deltaMs: number,
  tickMs: number = TICK_INTERVAL_MS,
  maxSteps: number = MAX_CATCHUP_STEPS_PER_FRAME,
): { steps: number; remainingMs: number } {
  let remaining = accMs + Math.max(0, deltaMs)
  let steps = 0
  while (remaining >= tickMs && steps < maxSteps) {
    remaining -= tickMs
    steps++
  }
  // At the cap we were stalled beyond ordinary jitter — drop the debt (honest pause, no burst).
  if (steps === maxSteps && remaining >= tickMs) remaining = 0
  return { steps, remainingMs: remaining }
}

function frame(now: number) {
  if (rafId === null) return
  const delta = lastFrameTs === null ? TICK_INTERVAL_MS : now - lastFrameTs
  lastFrameTs = now
  const { steps, remainingMs } = advanceAccumulator(accumulatorMs, delta)
  accumulatorMs = remainingMs
  for (let i = 0; i < steps; i++) tick()
  rafId = requestAnimationFrame(frame)
}

function handleVisibilityChange() {
  if (document.visibilityState === 'visible') {
    // Resume cleanly from the pause: forget hidden-time entirely.
    lastFrameTs = null
    accumulatorMs = 0
  }
}

const hasRafDriver = () =>
  typeof requestAnimationFrame === 'function' && typeof document !== 'undefined'

export function startSimLoop() {
  if (rafId !== null || intervalId !== null) return
  accumulatorMs = 0
  lastFrameTs = null
  if (hasRafDriver()) {
    document.addEventListener('visibilitychange', handleVisibilityChange)
    rafId = requestAnimationFrame(frame)
  } else {
    intervalId = setInterval(tick, TICK_INTERVAL_MS)
  }
}

/**
 * Cancel the raf/interval driver ONLY. No replay finalization, no lifecycle transition.
 * This is the generic "stop pumping ticks" primitive — used by pause, scenario swap,
 * RTB-ALL (which stops, mutates, then restarts), and demo reset. Because it never
 * finalizes, none of those paths writes a spurious run record.
 */
export function stopTicking() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }
  if (intervalId !== null) {
    clearInterval(intervalId)
    intervalId = null
  }
  accumulatorMs = 0
  lastFrameTs = null
}

/**
 * End the mission: stop ticking and — exactly once — mark the lifecycle 'completed' and
 * finalize the replay session (the sole path that persists an immutable run record, via
 * the runRecorder subscription to replaySession). Idempotent: a second call while already
 * 'completed' is a no-op, so a genuine terminal auto-complete followed by an explicit
 * End Mission (or repeated End Mission taps) writes nothing further.
 */
export function endMission(reason: MissionCompletionReason = 'operator_ended') {
  stopTicking()
  const store = useDroneStore.getState()
  if (store.lifecycle !== 'running' && store.lifecycle !== 'paused') return
  store.setRunning(false)
  store.setLifecycle('completed')
  store.finalizeReplaySession(reason)
}

/**
 * Backward-compatible alias retained for existing callers (test cleanup, etc.).
 * Post-split this cancels the driver WITHOUT finalizing — only endMission() finalizes.
 */
export function stopSimLoop() {
  stopTicking()
}

export function initFleet() {
  const { scenario, launchPlan, weatherState, scenarioVariant } = useDroneStore.getState()
  missionOcclusion = scenario ? occlusionServiceFor(scenario.id) : undefined
  missionConstellation = constellationFor(scenario?.id)
  missionLane = laneForScenario(scenario?.id)
  laneIdentified.clear()
  if (!scenario) return
  lastPositions.clear()
  onSceneTicksMap.clear()

  // Catalog and custom scenarios seed a launch plan from their authored assignments so
  // drones resolve through the physical site pool without a manual bay-planning pass.
  // Held locally for bay computation and re-applied after resetMission() clears the store plan.
  const seededLaunchPlan: LaunchBayPlan | null =
    !launchPlan && scenario.defaultLaunchAssignments
      ? { assignments: { ...scenario.defaultLaunchAssignments }, bayStatuses: [], readyToLaunch: true, blockers: [] }
      : null
  const effectiveLaunchPlan = launchPlan ?? seededLaunchPlan

  const colors = ['#00d4ff', '#44ff88', '#ffaa00', '#ff88ff', '#ff6644', '#cc44ff', '#ffdd00', '#ff4488']
  const droneIds = Array.from({ length: scenario.droneCount }, (_, i) => `uav-${String(i + 1).padStart(2, '0')}`)

  // Routes are computed first: the coordinated launch planner needs each drone's
  // first outbound target to orient its launch bay and sequence its takeoff slot.
  // Custom missions carry operator-authored routes — honor them verbatim instead of
  // re-deriving safe routes here (enhanceScenarioForOperations already audited them).
  const baselineRoutes = scenario.isCustom && scenario.authoredRoutes
    ? scenario.authoredRoutes
    : buildSafeDroneRoutes(scenario)
  // A saved custom definition is authoritative. Do not let an older per-scenario
  // localStorage draft silently replace routes loaded from the encrypted profile.
  const restoredRoutes = scenario.isCustom
    ? {
        routes: Object.fromEntries(Object.entries(baselineRoutes).map(([droneId, route]) => [
          droneId,
          route.map((waypoint) => ({ ...waypoint, position: { ...waypoint.position } })),
        ])),
        statuses: {},
      }
    : restoreSavedWaypointRoutes({
        scenarioId: scenario.id,
        scenarioVariant,
        baselineRoutes,
        validateRoute: (droneId, route) => validateOperatorRoute(scenario, droneId, route).accepted,
      })

  const launchSlots = buildLaunchSlotsForPlan(scenario, effectiveLaunchPlan, restoredRoutes.routes)

  const drones = droneIds.map((id, i) => ({
    id,
    label: id.toUpperCase(),
    color: colors[i % colors.length],
    position: launchSlots[id]?.bay ?? scenario.perDroneStartPositions?.[id] ?? scenario.startPosition,
    altitudeFt: 0,
    headingDeg: 0,
    speedMs: 0,
    batteryPct: scenario.batteryStartPct,
    signalDbm: -55,
    missionState: 'idle' as const,
    currentWaypointIndex: 0,
    conflictFlag: false,
    geofenceBreachFlag: false,
    geofenceBreach: undefined,
    bvlosFlag: false,
    sortieCount: 0,
    platformId: scenario.dronePlatforms?.[id],
    weatherDivertFlag: false,
    commsLostSec: 0,
    scheduledLaunchSec: launchSlots[id]?.scheduledLaunchSec ?? 0,
  }))

  useDroneStore.getState().setDrones(drones)
  useDroneStore.getState().resetMission()

  // resetMission() clears launchPlan; re-apply the authored site-pool assignments.
  if (seededLaunchPlan) useDroneStore.getState().setLaunchPlan(seededLaunchPlan)

  // Re-apply weather state (in case variant changed since last load)
  useDroneStore.getState().setWeatherState(weatherState)

  useDroneStore.getState().setDroneWaypoints(restoredRoutes.routes)
  useDroneStore.getState().setRouteSaveStatuses(restoredRoutes.statuses)

  // resetMission() above restored lastHash to the genesis hash, so this becomes link #1.
  useDroneStore.getState().emitEvent({
    eventType: 'mission_start',
    droneId: 'system',
    tick: 0,
    payload: {
      scenarioId: scenario.id,
      droneCount: scenario.droneCount,
      seed: scenario.seed,
      weatherSeverity: weatherState.activeHazards.length,
      activeHazards: weatherState.activeHazards,
    },
  })
}
