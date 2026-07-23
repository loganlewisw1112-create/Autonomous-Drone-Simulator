import type { DroneState, DroneCmd, LatLng } from '@/types'
import { LEGACY_PLATFORM, type DronePlatformSpec } from './platformCatalog'
import { offsetLatLng, angleDiffDeg, clamp, haversineDistanceM } from '@/utils/geometry'
import { enduranceMinutes, reserveSocForVoltage, terminalVoltage } from './battery'

const BASE_BATTERY_DRAIN = 0.02 // % per second at hover
const SPEED_BATTERY_COEFF = 0.008 // additional % per second per m/s
const ARRIVAL_RADIUS_M = 8
const RTB_SIGNAL_LOSS_DBM = -95

/** Typical LiPo pack for this airframe class. Used only to report cell voltage. */
const PACK_CELLS = 4
/** Per-cell sag under a representative flight load (WP-11). */
const FLIGHT_SAG_V = 0.15

/**
 * Live battery/turbulence environment (REALISM_ROADMAP WP-10 / WP-11).
 *
 * Supplying this switches `stepDrone` from the legacy linear drain to the sourced discharge
 * model. Omitting it preserves the previous behaviour exactly — the same "legacy path stays
 * until the caller opts in" pattern ThermalSim uses for WP-5.
 */
export interface FlightEnvironment {
  /** Ambient temperature, °C. Drives the WP-11 capacity derate. */
  tempC: number
  /** Instantaneous gust the airframe is fighting, m/s (WP-10). */
  gustMs?: number
  /** Sustained wind, m/s. */
  windMs?: number
  /** Multiplier the scenario/weather layer already applied; kept so it still bites. */
  drainMultiplier?: number
}

/**
 * Aggregate load factor vs the published endurance profile (WP-11 `EnduranceInput.loadFactor`).
 *
 * Published endurance figures are quoted for gentle still-air cruise. Real burn rises with
 * airspeed and, per WP-10's stated couplings, with the work of holding station against wind and
 * gusts — which is precisely how turbulence reaches an operator who never touches the sticks.
 */
export function flightLoadFactor(
  speedMs: number,
  platform: DronePlatformSpec,
  env: FlightEnvironment,
): number {
  const speedShare = platform.maxSpeedMs > 0 ? Math.min(1, Math.max(0, speedMs) / platform.maxSpeedMs) : 0
  const windShare = platform.windToleranceMs > 0
    ? Math.min(1.5, (Math.max(0, env.windMs ?? 0) + Math.abs(env.gustMs ?? 0)) / platform.windToleranceMs)
    : 0
  // Still air at rest is the published profile (1.0); full speed in a gale roughly doubles burn.
  return 1 + speedShare * 0.45 + windShare * 0.4
}

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

export function stepDrone(
  state: DroneState,
  cmd: DroneCmd,
  dt: number,
  platform: DronePlatformSpec = LEGACY_PLATFORM,
  env?: FlightEnvironment,
): DroneState {
  let { headingDeg, speedMs, batteryPct, altitudeFt, position } = state

  // ── Heading update ──────────────────────────────────────────────────────────
  if (cmd.targetHeadingDeg !== undefined) {
    const diff = angleDiffDeg(headingDeg, cmd.targetHeadingDeg)
    const maxTurn = platform.turnRateDegS * dt
    headingDeg = (headingDeg + Math.sign(diff) * Math.min(Math.abs(diff), maxTurn) + 360) % 360
  }

  // ── Speed update ────────────────────────────────────────────────────────────
  const targetSpeed = clamp((cmd.throttle ?? 0) * platform.maxSpeedMs, 0, platform.maxSpeedMs)
  // Simple slew: per-platform acceleration
  const accel = platform.accelMs2
  if (speedMs < targetSpeed) speedMs = Math.min(speedMs + accel * dt, targetSpeed)
  else speedMs = Math.max(speedMs - accel * dt, targetSpeed)

  // ── Altitude update ─────────────────────────────────────────────────────────
  if (cmd.targetAltitudeFt !== undefined) {
    const diff = cmd.targetAltitudeFt - altitudeFt
    const climbRateFtS = platform.climbRateFtS
    const step = clamp(diff, -climbRateFtS * dt, climbRateFtS * dt)
    altitudeFt = clamp(altitudeFt + step, 0, 400)
  }

  // ── Position update (geographic) ────────────────────────────────────────────
  const distanceM = speedMs * dt
  if (distanceM > 0) {
    position = offsetLatLng(position, headingDeg, distanceM)
  }

  // ── Battery drain (WP-11 discharge model, or the legacy linear path) ────────
  // Skip drain when recharging — SimulationLoop applies charge rate separately
  if (state.missionState !== 'recharge') {
    const drainRate = env
      ? modelledDrainRatePerSec(speedMs, platform, env)
      : cmd.batteryDrainRatePerSec ?? (BASE_BATTERY_DRAIN + speedMs * SPEED_BATTERY_COEFF)
    const drain = Math.max(0, drainRate) * dt
    batteryPct = Math.max(0, batteryPct - drain)
  }

  // ── Signal strength (simple distance model — caller updates with actual dist) ─
  const signalDbm = state.signalDbm  // updated by RFModel

  const next: DroneState = { ...state, headingDeg, speedMs, altitudeFt, position, batteryPct, signalDbm }
  if (env) {
    // Pack voltage under load — the quantity a real autopilot's reserve gate watches, and the
    // reason the WP-11 reserve fires before a linear "percent remaining" gate would.
    next.cellVoltageV = terminalVoltage(batteryPct / 100, FLIGHT_SAG_V)
    next.packVoltageV = next.cellVoltageV * PACK_CELLS
    next.gustMs = env.gustMs
  }
  return next
}

/**
 * Drain rate (% per second) from the WP-11 discharge model.
 *
 * Endurance is the published figure derated for temperature and divided by the live load factor;
 * burning 100% over that endurance gives the rate. At 20 °C, still air, at rest this reproduces
 * the platform's published endurance exactly, which is WP-11's stated acceptance criterion.
 */
export function modelledDrainRatePerSec(
  speedMs: number,
  platform: DronePlatformSpec,
  env: FlightEnvironment,
): number {
  const minutes = enduranceMinutes({
    publishedMin: platform.enduranceMin,
    tempC: env.tempC,
    loadFactor: flightLoadFactor(speedMs, platform, env),
  })
  const base = 100 / Math.max(1, minutes * 60)
  return base * Math.max(0, env.drainMultiplier ?? 1)
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

/**
 * Per-cell LOADED voltage at which the autopilot calls the reserve (WP-11).
 *
 * 3.6 V under load, not the 3.0 V cutoff. The gap is deliberate and is the whole point of the
 * discharge curve: below ~3.6 V loaded the pack is into the knee, where the remaining energy
 * collapses far faster than the percentage suggests, and the aircraft still has to fly home and
 * descend. Calling reserve at the cutoff would leave nothing for the trip back.
 *
 * Measured consequence: this crosses at ~37% state of charge, so it fires meaningfully EARLIER
 * than a linear "25% remaining" gate — which is WP-11's stated accept criterion.
 */
export const RESERVE_CELL_V = 3.6

/**
 * Voltage-aware reserve state of charge — WP-11's stated accept criterion that the knee triggers
 * RTB *earlier* than linear drain does.
 *
 * A linear gate treats "25% remaining" as 25% of usable energy. The OCV curve says otherwise: the
 * knee below ~30% SoC means the pack collapses toward cutoff far faster than the percentage
 * suggests, so the voltage the autopilot actually watches crosses its reserve threshold while the
 * naive percentage still looks comfortable.
 */
export function reserveBatteryPct(sagV = FLIGHT_SAG_V): number {
  return reserveSocForVoltage(RESERVE_CELL_V, sagV) * 100
}

/** True when the modelled pack has reached its voltage reserve. Falls back to the linear gate
 *  for aircraft with no modelled voltage (legacy drain path). */
export function isAtVoltageReserve(drone: DroneState): boolean {
  if (drone.cellVoltageV === undefined) return isBatteryLow(drone)
  return drone.cellVoltageV <= RESERVE_CELL_V
}

export function isBatteryCritical(drone: DroneState): boolean {
  return drone.batteryPct < 8
}
