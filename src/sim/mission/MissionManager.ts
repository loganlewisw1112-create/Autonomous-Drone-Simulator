import type { DroneState, MissionState, Waypoint } from '@/types'
import { haversineDistanceM, bearingDeg } from '@/utils/geometry'
import { isBatteryCritical } from '@/sim/drone/DroneEntity'

const ARRIVAL_RADIUS_M = 10
const INSPECT_DWELL_SEC = 8
export const AVOID_MANEUVER_SEC = 4

export interface MissionManagerState {
  waypoints: Waypoint[]
  basePosition: Waypoint
  elapsedSec: number
  tick: number
  assignedAltitudeFt: number
  droneWaypoints?: Record<string, Waypoint[]>
  rechargeTimeSec?: number
  maxSorties?: number
  batteryReservePct?: number
  weatherForceRtb?: boolean
  weatherHazard?: string
}

export interface CommandResult {
  cmd: { targetHeadingDeg: number; throttle: number; targetAltitudeFt: number }
  nextState: MissionState
  nextWaypointIndex: number
  hoverStartSec?: number
  rechargeStartSec?: number
  sortieResumeWpIdx?: number
}

export function getNextCommand(drone: DroneState, mm: MissionManagerState): CommandResult {
  const waypoints = mm.droneWaypoints?.[drone.id] ?? mm.waypoints
  const { basePosition, assignedAltitudeFt } = mm
  let nextMissionState = drone.missionState
  let nextWpIdx = drone.currentWaypointIndex
  let sortieResumeWpIdx: number | undefined

  // ── Emergency overrides (highest priority) ──────────────────────────────────
  if (isBatteryCritical(drone) && drone.missionState !== 'emergency' && drone.missionState !== 'landed') {
    nextMissionState = 'emergency'
  } else if (isBelowReserve(drone, mm.batteryReservePct) && !['return_to_base', 'emergency', 'landed', 'hover', 'recharge'].includes(drone.missionState)) {
    if (mm.maxSorties && drone.sortieCount < mm.maxSorties - 1) {
      sortieResumeWpIdx = drone.currentWaypointIndex
    }
    nextMissionState = 'return_to_base'
    nextWpIdx = 0
  } else if (drone.geofenceBreachFlag && !['return_to_base', 'emergency', 'landed', 'hover', 'recharge'].includes(drone.missionState)) {
    if (mm.maxSorties && drone.sortieCount < mm.maxSorties - 1) {
      sortieResumeWpIdx = drone.currentWaypointIndex
    }
    nextMissionState = 'return_to_base'
    nextWpIdx = 0
  } else if (mm.weatherForceRtb && !['return_to_base', 'emergency', 'landed', 'recharge'].includes(drone.missionState)) {
    // Weather severity forces divert to safe zone (base). Preserve sortie for resume.
    if (mm.maxSorties && drone.sortieCount < mm.maxSorties - 1) {
      sortieResumeWpIdx = drone.currentWaypointIndex
    }
    nextMissionState = 'return_to_base'
    nextWpIdx = 0
  }

  let targetPos = basePosition.position
  let targetAltFt = basePosition.altitudeFt
  let throttle = 0

  switch (nextMissionState) {
    case 'idle':
    case 'preflight':
      return { cmd: { targetHeadingDeg: drone.headingDeg, throttle: 0, targetAltitudeFt: 0 }, nextState: nextMissionState, nextWaypointIndex: nextWpIdx }

    case 'launch':
      targetAltFt = assignedAltitudeFt
      throttle = drone.altitudeFt < targetAltFt - 5 ? 0.3 : 0
      nextMissionState = drone.altitudeFt >= targetAltFt - 5 ? 'navigate' : 'launch'
      break

    case 'navigate':
    case 'sar_grid': {
      if (waypoints.length === 0) { nextMissionState = 'return_to_base'; break }
      const wp = waypoints[drone.currentWaypointIndex]
      if (!wp) { nextMissionState = 'return_to_base'; break }
      targetPos = wp.position
      targetAltFt = assignedAltitudeFt
      throttle = 0.8
      if (haversineDistanceM(drone.position, wp.position) < ARRIVAL_RADIUS_M) {
        // Enter hover if waypoint has a dwell and hasn't started yet
        if (wp.dwellTimeSec !== undefined && drone.hoverStartSec === undefined) {
          return {
            cmd: { targetHeadingDeg: drone.headingDeg, throttle: 0, targetAltitudeFt: assignedAltitudeFt },
            nextState: 'hover',
            nextWaypointIndex: drone.currentWaypointIndex,
            hoverStartSec: mm.elapsedSec,
          }
        }
        nextWpIdx = drone.currentWaypointIndex + 1
        if (nextWpIdx >= waypoints.length) {
          // Route complete — loiter at final waypoint. Do NOT auto-RTB.
          // Battery/weather/geofence/operator guards will pull us into RTB when needed.
          return {
            cmd: { targetHeadingDeg: drone.headingDeg, throttle: 0, targetAltitudeFt: assignedAltitudeFt },
            nextState: 'route_complete_loiter',
            nextWaypointIndex: drone.currentWaypointIndex,
          }
        }
      }
      break
    }

    case 'hover': {
      const wp = waypoints[drone.currentWaypointIndex]

      // Guard: invalid hover state — advance immediately
      if (!wp?.dwellTimeSec || drone.hoverStartSec === undefined) {
        const ni = drone.currentWaypointIndex + 1
        if (ni >= waypoints.length) {
          // Route complete — loiter, do NOT auto-RTB.
          return { cmd: { targetHeadingDeg: drone.headingDeg, throttle: 0, targetAltitudeFt: assignedAltitudeFt }, nextState: 'route_complete_loiter', nextWaypointIndex: drone.currentWaypointIndex }
        }
        return { cmd: { targetHeadingDeg: bearingDeg(drone.position, waypoints[ni].position), throttle: 0.8, targetAltitudeFt: assignedAltitudeFt }, nextState: 'navigate', nextWaypointIndex: ni }
      }

      const elapsed = mm.elapsedSec - drone.hoverStartSec
      if (elapsed >= wp.dwellTimeSec) {
        // Dwell complete — advance to next waypoint
        const ni = drone.currentWaypointIndex + 1
        if (ni >= waypoints.length) {
          // Route complete — loiter, do NOT auto-RTB.
          return { cmd: { targetHeadingDeg: drone.headingDeg, throttle: 0, targetAltitudeFt: assignedAltitudeFt }, nextState: 'route_complete_loiter', nextWaypointIndex: drone.currentWaypointIndex }
        }
        return { cmd: { targetHeadingDeg: bearingDeg(drone.position, waypoints[ni].position), throttle: 0.8, targetAltitudeFt: assignedAltitudeFt }, nextState: 'navigate', nextWaypointIndex: ni }
      }

      // Still hovering — hold heading, throttle=0 lets drone decelerate to zero naturally
      return {
        cmd: { targetHeadingDeg: drone.headingDeg, throttle: 0, targetAltitudeFt: assignedAltitudeFt },
        nextState: 'hover',
        nextWaypointIndex: drone.currentWaypointIndex,
        // hoverStartSec NOT returned → SimulationLoop preserves existing value
      }
    }

    case 'avoid': {
      // Traffic-conflict avoidance: the give-way drone holds a divergence heading (set by
      // SimulationLoop when the conflict was detected) for a fixed maneuver window, then
      // resumes its interrupted task. Safety guards at the top of this function still
      // override (battery reserve / geofence / weather RTB take precedence over avoid).
      const elapsed = mm.elapsedSec - (drone.avoidStartSec ?? mm.elapsedSec)
      if (elapsed >= AVOID_MANEUVER_SEC) {
        return {
          cmd: { targetHeadingDeg: drone.headingDeg, throttle: 0.8, targetAltitudeFt: assignedAltitudeFt },
          nextState: drone.avoidReturnState ?? 'navigate',
          nextWaypointIndex: drone.currentWaypointIndex,
        }
      }
      return {
        cmd: {
          targetHeadingDeg: drone.avoidHeadingDeg ?? drone.headingDeg,
          throttle: 0.55,
          targetAltitudeFt: assignedAltitudeFt,
        },
        nextState: 'avoid',
        nextWaypointIndex: drone.currentWaypointIndex,
      }
    }

    case 'recharge': {
      const elapsed = mm.elapsedSec - (drone.rechargeStartSec ?? mm.elapsedSec)
      if (elapsed >= (mm.rechargeTimeSec ?? Infinity)) {
        return {
          cmd: { targetHeadingDeg: drone.headingDeg, throttle: 0, targetAltitudeFt: 0 },
          nextState: 'launch',
          nextWaypointIndex: 0,
        }
      }
      return {
        cmd: { targetHeadingDeg: drone.headingDeg, throttle: 0, targetAltitudeFt: 0 },
        nextState: 'recharge',
        nextWaypointIndex: 0,
      }
    }

    case 'return_to_base':
      targetPos = basePosition.position
      targetAltFt = 120
      throttle = 0.9
      if (haversineDistanceM(drone.position, basePosition.position) < ARRIVAL_RADIUS_M) {
        if (mm.rechargeTimeSec && mm.maxSorties && drone.sortieCount < mm.maxSorties - 1) {
          return {
            cmd: { targetHeadingDeg: drone.headingDeg, throttle: 0, targetAltitudeFt: 0 },
            nextState: 'recharge',
            nextWaypointIndex: 0,
            rechargeStartSec: mm.elapsedSec,
          }
        }
        nextMissionState = 'landed'
        throttle = 0
        targetAltFt = 0
      }
      break

    case 'emergency':
      throttle = 0
      targetAltFt = 0
      if (drone.altitudeFt < 2) nextMissionState = 'landed'
      break

    case 'landed':
      return { cmd: { targetHeadingDeg: drone.headingDeg, throttle: 0, targetAltitudeFt: 0 }, nextState: 'landed', nextWaypointIndex: 0 }

    case 'inspect': {
      const elapsed = mm.elapsedSec - (drone.inspectStartSec ?? mm.elapsedSec)
      if (elapsed >= INSPECT_DWELL_SEC) {
        // Dwell complete — enter thermal_hold; operator must explicitly resume the flight plan
        return {
          cmd: { targetHeadingDeg: drone.headingDeg, throttle: 0, targetAltitudeFt: assignedAltitudeFt },
          nextState: 'thermal_hold',
          nextWaypointIndex: drone.currentWaypointIndex,
        }
      }
      return {
        cmd: { targetHeadingDeg: drone.headingDeg, throttle: 0, targetAltitudeFt: assignedAltitudeFt },
        nextState: 'inspect',
        nextWaypointIndex: drone.currentWaypointIndex,
      }
    }

    case 'thermal_hold':
      return {
        cmd: { targetHeadingDeg: drone.headingDeg, throttle: 0, targetAltitudeFt: assignedAltitudeFt },
        nextState: 'thermal_hold',
        nextWaypointIndex: drone.currentWaypointIndex,
      }

    case 'route_complete_loiter':
      // Hold position at last waypoint. Operator RTB / battery reserve / weather / geofence
      // will interrupt via the guards at the top of getNextCommand.
      return {
        cmd: { targetHeadingDeg: drone.headingDeg, throttle: 0, targetAltitudeFt: assignedAltitudeFt },
        nextState: 'route_complete_loiter',
        nextWaypointIndex: drone.currentWaypointIndex,
      }

    // Grounded pending recovery-team action — SimulationLoop skips physics for these states.
    case 'remote_landed':
    case 'stranded':
    case 'recovery_requested':
    case 'recovery_enroute':
      return { cmd: { targetHeadingDeg: drone.headingDeg, throttle: 0, targetAltitudeFt: 0 }, nextState: nextMissionState, nextWaypointIndex: nextWpIdx }

    // Recovery complete — hand the drone back to normal flow instead of staying terminal forever.
    case 'recovered':
      return { cmd: { targetHeadingDeg: drone.headingDeg, throttle: 0, targetAltitudeFt: 0 }, nextState: 'landed', nextWaypointIndex: 0 }

    // Drone lost in simulation — terminal by design, not by accidental fallthrough.
    case 'unrecoverable_sim':
      return { cmd: { targetHeadingDeg: drone.headingDeg, throttle: 0, targetAltitudeFt: 0 }, nextState: 'unrecoverable_sim', nextWaypointIndex: nextWpIdx }

    default:
      break
  }

  const targetHeadingDeg = bearingDeg(drone.position, targetPos)

  return {
    cmd: { targetHeadingDeg, throttle, targetAltitudeFt: targetAltFt },
    nextState: nextMissionState,
    nextWaypointIndex: nextWpIdx,
    sortieResumeWpIdx,
  }
}

function isBelowReserve(drone: DroneState, reservePct = 25): boolean {
  return drone.batteryPct < reservePct
}
