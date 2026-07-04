import { useDroneStore } from '@/store/droneStore'
import { stepDrone } from '@/sim/drone/DroneEntity'
import { getNextCommand, type MissionManagerState } from '@/sim/mission/MissionManager'
import { detectConflicts, applyConflictFlags, getAssignedAltitude } from '@/sim/safety/DeconflictEngine'
import { applyGeofenceFlags, applyCommsModel } from '@/sim/safety/SafetyManager'
import { buildSafeDroneRoutes } from '@/sim/mission/routeAudit'
import { validateOperatorRoute } from '@/sim/mission/operatorRoutes'
import { restoreSavedWaypointRoutes } from '@/sim/mission/waypointPersistence'
import {
  batteryProfileForDrone,
  batteryReservePctForDrone,
  chargeRateMultiplierForDrone,
  effectiveBatteryDrainRateForDrone,
  selectRechargeStationForDrone,
} from '@/sim/mission/rechargeStations'
import { checkThermalDetections } from '@/sim/sensors/ThermalSim'
import { isWeatherForceRtb } from '@/sim/weather/weatherEngine'
import { tickGroundUnit, computeGroundUnitEta } from '@/sim/mission/groundUnits'
import { tickRecoveryTeam, tickRecoveryExtraction, needsRecovery, recoveryTransitionState, createRecoveryTeam } from '@/sim/mission/recoveryManager'
import { haversineDistanceM } from '@/utils/geometry'
import type { DroneState, EventType, FullMissionFrame, LatLng, Waypoint } from '@/types'

const THERMAL_CHECK_INTERVAL = 50
const SNAPSHOT_INTERVAL = 40
const FIXED_DT = 0.05
const TELEMETRY_SAMPLE_INTERVAL = 10
const TICK_INTERVAL_MS = 50
const INSPECT_CONFIDENCE_THRESHOLD = 0.75
const NON_INSPECTABLE_STATES = new Set<DroneState['missionState']>([
  'idle', 'preflight', 'launch', 'avoid', 'emergency', 'landed', 'recharge',
  'inspect', 'thermal_hold', 'remote_landed', 'stranded', 'recovery_requested', 'recovery_enroute', 'recovered', 'unrecoverable_sim',
])

// ephemeral state — not in store
const lastPositions = new Map<string, LatLng>()
const onSceneTicksMap = new Map<string, number>()  // recoveryTeamId → ticks on scene

/**
 * One fixed-timestep tick (runs `simSpeed` physics sub-steps). Exported so tests and the
 * setInterval fallback can drive the REAL production step directly — never reimplement it.
 */
export function tick() {
  const store = useDroneStore.getState()
  if (!store.ui.isRunning) return

  const stepsPerFrame = store.ui.simSpeed

  for (let i = 0; i < stepsPerFrame; i++) {
    const { drones, scenario, tick: currentTick, elapsedSec, weatherState } = useDroneStore.getState()
    if (!scenario) break

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
      const basePos = selectedRechargeStation?.position ?? scenario.recoverySites?.[drone.id]?.position ?? scenario.startPosition
      const baseWaypoint: Waypoint = {
        id: `base-${drone.sortieCount}`,
        position: basePos,
        altitudeFt: 0,
        label: selectedRechargeStation?.station.label ?? scenario.recoverySites?.[drone.id]?.label ?? 'Base',
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
      }

      const { cmd: rawCmd, nextState, nextWaypointIndex, hoverStartSec, rechargeStartSec, sortieResumeWpIdx } = getNextCommand(drone, mm)

      // Skip physics for grounded/recovery states — drone is not airborne, battery shouldn't drain
      const isGrounded = ['idle', 'landed', 'remote_landed', 'stranded', 'recovery_requested', 'recovery_enroute', 'recovered', 'unrecoverable_sim'].includes(nextState)

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

      const updated = isGrounded
        ? { ...drone, missionState: nextState, currentWaypointIndex: wpIdxForDrone, ...hoverPatch, ...rechargePatch, ...launchPatch, ...emergencyPatch, ...thermalHoldPatch }
        : stepDrone(
            { ...drone, missionState: nextState, currentWaypointIndex: wpIdxForDrone, ...hoverPatch, ...rechargePatch, ...launchPatch, ...emergencyPatch, ...thermalHoldPatch },
            { ...cmd, batteryDrainRatePerSec },
            FIXED_DT,
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
    const withComms = applyCommsModel(withGeo, elapsedSec, scenario, weatherState)
    const conflicts = detectConflicts(withComms)
    const withDeconflict = applyConflictFlags(withComms, conflicts)

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
        const detections = checkThermalDetections(drone, scenario.heatSources, currentTick, scenario.seed)
        for (const det of detections) {
          useDroneStore.getState().addThermalContact(det)
          const { metrics } = useDroneStore.getState()
          useDroneStore.getState().updateMetrics({ thermalContacts: metrics.thermalContacts + 1 })
          useDroneStore.getState().emitEvent({
            eventType: 'thermal_detection',
            droneId: drone.id,
            tick: currentTick,
            payload: {
              sourceId: det.sourceId,
              class: det.class,
              confidence: Math.round(det.confidence * 100),
              position: det.position,
            },
          })

          // High-confidence contact triggers a brief automatic hover-and-confirm
          // instead of leaving the operator's only options as "ignore" or manual hover.
          if (det.confidence >= INSPECT_CONFIDENCE_THRESHOLD && !NON_INSPECTABLE_STATES.has(drone.missionState)) {
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

export function stopSimLoop() {
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
  // Finalize the replay session so scrubbing is available
  useDroneStore.getState().finalizeReplaySession()
}

export function initFleet() {
  const { scenario, launchPlan, weatherState, scenarioVariant } = useDroneStore.getState()
  if (!scenario) return
  lastPositions.clear()
  onSceneTicksMap.clear()

  const colors = ['#00d4ff', '#44ff88', '#ffaa00', '#ff88ff', '#ff6644', '#cc44ff', '#ffdd00', '#ff4488']
  const drones = Array.from({ length: scenario.droneCount }, (_, i) => {
    const id = `uav-${String(i + 1).padStart(2, '0')}`
    const defaultPos = {
      lat: scenario.startPosition.lat + i * 0.00005,
      lng: scenario.startPosition.lng + i * 0.00005,
    }
    // Prefer launch plan assignment, then scenario launch site, then default offset.
    // Assignments are keyed by the launchSites record key (LaunchBayPlanner uses the same
    // keys), so reassigning a drone to another bay actually moves its spawn position.
    const launchSiteId = launchPlan?.assignments[id]
    const launchSite = launchSiteId ? scenario.launchSites?.[launchSiteId] : undefined
    return {
      id,
      label: id.toUpperCase(),
      color: colors[i % colors.length],
      position: launchSite?.position ?? scenario.launchSites?.[id]?.position ?? scenario.perDroneStartPositions?.[id] ?? defaultPos,
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
      weatherDivertFlag: false,
      commsLostSec: 0,
    }
  })

  useDroneStore.getState().setDrones(drones)
  useDroneStore.getState().resetMission()

  // Re-apply weather state (in case variant changed since last load)
  useDroneStore.getState().setWeatherState(weatherState)

  const baselineRoutes = buildSafeDroneRoutes(scenario)
  const restoredRoutes = restoreSavedWaypointRoutes({
    scenarioId: scenario.id,
    scenarioVariant,
    baselineRoutes,
    validateRoute: (droneId, route) => validateOperatorRoute(scenario, droneId, route).accepted,
  })

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
