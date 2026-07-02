import type { DroneState, DroneCmd, LatLng } from '@/types'
import { offsetLatLng, angleDiffDeg, clamp, haversineDistanceM } from '@/utils/geometry'

const MAX_TURN_RATE_DEG_S = 90
const MAX_SPEED_MS = 12        // ~27 mph — within FAA Part 107 limit of 57 mph
const BASE_BATTERY_DRAIN = 0.02 // % per second at hover
const SPEED_BATTERY_COEFF = 0.008 // additional % per second per m/s
const ARRIVAL_RADIUS_M = 8
const RTB_SIGNAL_LOSS_DBM = -95

export function createDroneState(
  id: string,
  label: string,
  color: string,
  position: LatLng,
  altitudeFt = 0,
): DroneState {
  return {
    id,
    label,
    color,
    position,
    altitudeFt,
    headingDeg: 0,
    speedMs: 0,
    batteryPct: 100,
    signalDbm: -55,
    missionState: 'idle',
    currentWaypointIndex: 0,
    conflictFlag: false,
    geofenceBreachFlag: false,
    bvlosFlag: false,
    sortieCount: 0,
  }
}

export function stepDrone(state: DroneState, cmd: DroneCmd, dt: number): DroneState {
  let { headingDeg, speedMs, batteryPct, altitudeFt, position } = state

  // ── Heading update ──────────────────────────────────────────────────────────
  if (cmd.targetHeadingDeg !== undefined) {
    const diff = angleDiffDeg(headingDeg, cmd.targetHeadingDeg)
    const maxTurn = MAX_TURN_RATE_DEG_S * dt
    headingDeg = (headingDeg + Math.sign(diff) * Math.min(Math.abs(diff), maxTurn) + 360) % 360
  }

  // ── Speed update ────────────────────────────────────────────────────────────
  const targetSpeed = clamp((cmd.throttle ?? 0) * MAX_SPEED_MS, 0, MAX_SPEED_MS)
  // Simple slew: 3 m/s² acceleration
  const accel = 3
  if (speedMs < targetSpeed) speedMs = Math.min(speedMs + accel * dt, targetSpeed)
  else speedMs = Math.max(speedMs - accel * dt, targetSpeed)

  // ── Altitude update ─────────────────────────────────────────────────────────
  if (cmd.targetAltitudeFt !== undefined) {
    const diff = cmd.targetAltitudeFt - altitudeFt
    const climbRateFtS = 300 / 60  // 300 ft/min
    const step = clamp(diff, -climbRateFtS * dt, climbRateFtS * dt)
    altitudeFt = clamp(altitudeFt + step, 0, 400)
  }

  // ── Position update (geographic) ────────────────────────────────────────────
  const distanceM = speedMs * dt
  if (distanceM > 0) {
    position = offsetLatLng(position, headingDeg, distanceM)
  }

  // ── Battery drain ───────────────────────────────────────────────────────────
  // Skip drain when recharging — SimulationLoop applies charge rate separately
  if (state.missionState !== 'recharge') {
    const drainRate = cmd.batteryDrainRatePerSec ?? (BASE_BATTERY_DRAIN + speedMs * SPEED_BATTERY_COEFF)
    const drain = Math.max(0, drainRate) * dt
    batteryPct = Math.max(0, batteryPct - drain)
  }

  // ── Signal strength (simple distance model — caller updates with actual dist) ─
  const signalDbm = state.signalDbm  // updated by RFModel

  return { ...state, headingDeg, speedMs, altitudeFt, position, batteryPct, signalDbm }
}

export function isAtWaypoint(drone: DroneState, target: LatLng): boolean {
  return haversineDistanceM(drone.position, target) < ARRIVAL_RADIUS_M
}

export function isSignalLost(drone: DroneState): boolean {
  return drone.signalDbm < RTB_SIGNAL_LOSS_DBM
}

export function isBatteryLow(drone: DroneState): boolean {
  return drone.batteryPct < 25
}

export function isBatteryCritical(drone: DroneState): boolean {
  return drone.batteryPct < 8
}
