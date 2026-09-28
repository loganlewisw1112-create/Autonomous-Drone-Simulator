import type { DroneState, DroneCmd, LatLng } from '@/types'
import { LEGACY_PLATFORM, type DronePlatformSpec } from './platformCatalog'
import { offsetLatLng, angleDiffDeg, clamp, haversineDistanceM } from '@/utils/geometry'
import { enduranceMinutes, reserveSocForVoltage, terminalVoltage } from './battery'

const BASE_BATTERY_DRAIN = 0.02 // % per second at hover
const SPEED_BATTERY_COEFF = 0.008 // additional % per second per m/s
const ARRIVAL_RADIUS_M = 8
const RTB_SIGNAL_LOSS_DBM = -95

/** Series cell count when an airframe's pack configuration is unpublished. Reporting only. */
const DEFAULT_PACK_CELLS = 4
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
  /** Residual scenario/weather multiplier: the battery-pressure dial. Wind and cold are NOT in
   *  it — they reach the pack through `flightLoadFactor` and the temperature derate. */
  drainMultiplier?: number
  /** Scales the airframe's rated endurance, e.g. a scenario's extended-endurance battery kit. */
  enduranceScale?: number
}

/**
 * Hover power over best-endurance power when an airframe publishes no hover time. Modelling
 * choice, set between the two published pairs: Skydio X10/X10D 40 min max flight vs 35 min hover
 * (1.143), and Freefly Astro Max with LR1 31 min vs ~27.5 min hover from Freefly's chart (1.127).
 */
export const DEFAULT_HOVER_POWER_RATIO = 1.14

/**
 * Best-endurance airspeed as a share of the airframe's top speed. Modelling choice, taken from
 * Freefly's measured Astro "Flight Time versus Flight Speed" chart (hover / 7 / 15 m/s at 0 and
 * 1.5 kg payload): the curve below fitted to those points bottoms out at 0.61-0.71 of 15 m/s.
 * With 0.65, the Astro Max + LR1 model gives 26.6 min at 15 m/s against ~27.1 min interpolated
 * from the two measured payload curves.
 */
export const BEST_ENDURANCE_SPEED_FRACTION = 0.65

/**
 * Multirotor power vs level airspeed, relative to hover power, in units of the hover induced
 * velocity v_h: momentum-theory induced power w(u) plus parasite drag power c·u³.
 * w solves w⁴ + u²w² = 1, so w(0) = 1 and induced power falls as the rotor meets fresh air.
 */
function inducedRatio(u: number): number {
  return Math.sqrt((-u * u + Math.sqrt(u ** 4 + 4)) / 2)
}

function inducedRatioSlope(u: number): number {
  return (-u + u ** 3 / Math.sqrt(u ** 4 + 4)) / (2 * inducedRatio(u))
}

interface PowerCurve {
  /** Hover induced velocity, m/s. */
  inducedVelocityMs: number
  /** Parasite coefficient, relative to hover power at u = 1. */
  parasite: number
  /** Minimum of the curve (power at best-endurance speed), relative to hover power. */
  minPower: number
}

const powerCurveCache = new Map<string, PowerCurve>()

/**
 * The airframe's power curve, pinned by two figures: the hover penalty (published hover time vs
 * published endurance, or the modelled default) sets how deep the U is; the best-endurance speed
 * sets where along the speed axis its bottom sits. Pure and cached, so no sim state is added.
 */
export function powerCurveFor(platform: DronePlatformSpec): PowerCurve {
  const hoverRatio = platform.hoverEnduranceMin && platform.hoverEnduranceMin > 0
    ? Math.max(1, platform.enduranceMin / platform.hoverEnduranceMin)
    : DEFAULT_HOVER_POWER_RATIO
  const bestSpeedMs = Math.max(0.1, platform.airframeMaxSpeedMs * BEST_ENDURANCE_SPEED_FRACTION)
  const key = `${hoverRatio}|${bestSpeedMs}`
  const cached = powerCurveCache.get(key)
  if (cached) return cached

  // Where the minimum sits (in units of v_h) fixes the parasite term, and deeper minima sit
  // further out, so bisect that location until the minimum equals 1 / hoverRatio.
  const shape = (um: number) => {
    const parasite = -inducedRatioSlope(um) / (3 * um * um)
    return { parasite, minPower: inducedRatio(um) + parasite * um ** 3 }
  }
  let lo = 0.05
  let hi = 6
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (shape(mid).minPower > 1 / hoverRatio) lo = mid
    else hi = mid
  }
  const um = (lo + hi) / 2
  const curve = { inducedVelocityMs: bestSpeedMs / um, ...shape(um) }
  powerCurveCache.set(key, curve)
  return curve
}

/** Power at a level airspeed over power at best-endurance speed: 1 at best speed, the hover
 *  penalty at rest, rising again toward top speed. */
export function speedPowerFactor(speedMs: number, platform: DronePlatformSpec): number {
  const { inducedVelocityMs, parasite, minPower } = powerCurveFor(platform)
  const u = Math.max(0, speedMs) / inducedVelocityMs
  return (inducedRatio(u) + parasite * u ** 3) / minPower
}

/**
 * Aggregate load factor vs the published endurance profile (WP-11 `EnduranceInput.loadFactor`).
 *
 * Published max flight time is the best case: still air at the best-endurance speed. Hovering and
 * flying fast both cost more (`speedPowerFactor`), and per WP-10's stated couplings so does the
 * work of holding station against wind and gusts, which is how turbulence reaches an operator who
 * never touches the sticks.
 */
export function flightLoadFactor(
  speedMs: number,
  platform: DronePlatformSpec,
  env: FlightEnvironment,
): number {
  const windShare = platform.windToleranceMs > 0
    ? Math.min(1.5, (Math.max(0, env.windMs ?? 0) + Math.abs(env.gustMs ?? 0)) / platform.windToleranceMs)
    : 0
  return speedPowerFactor(speedMs, platform) + windShare * 0.4
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
    // Multirotors descend slower than they climb (vortex-ring limit); airframes with no published
    // descent rate fall back to the climb rate, which keeps the legacy airframe unchanged.
    const climbRateFtS = platform.climbRateFtS
    const descentRateFtS = platform.descentRateFtS ?? climbRateFtS
    const step = clamp(diff, -descentRateFtS * dt, climbRateFtS * dt)
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
    next.packVoltageV = next.cellVoltageV * (platform.battery.cells ?? DEFAULT_PACK_CELLS)
    next.gustMs = env.gustMs
  }
  return next
}

/**
 * Drain rate (% per second) from the WP-11 discharge model.
 *
 * Endurance is the published figure derated for temperature and divided by the live load factor;
 * burning 100% over that endurance gives the rate. At 20 °C in still air this reproduces the
 * published max flight time at the best-endurance speed and the published hover time at rest.
 */
export function modelledDrainRatePerSec(
  speedMs: number,
  platform: DronePlatformSpec,
  env: FlightEnvironment,
): number {
  const minutes = enduranceMinutes({
    publishedMin: platform.enduranceMin * Math.max(0, env.enduranceScale ?? 1),
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
export const CRITICAL_CELL_V = 3.3

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
  if (!Number.isFinite(drone.cellVoltageV)) return true
  return drone.cellVoltageV <= RESERVE_CELL_V
}

/**
 * What the operator should be told about this pack, using the gates the autopilot acts on:
 * 'critical' is the emergency-land gate; 'reserve' is the loaded-voltage reserve (~37% SoC for
 * modelled packs, 25% on the legacy path) or any battery RTB the loop has flagged — including the
 * scenario percentage floor and the energy-to-home gate. UI thresholds read this rather than
 * hard-coding percentages that disagree with when the aircraft actually turns for home.
 */
export function batteryAlert(drone: DroneState): 'ok' | 'reserve' | 'critical' {
  if (isBatteryCritical(drone)) return 'critical'
  if (drone.batteryRtb || isAtVoltageReserve(drone)) return 'reserve'
  return 'ok'
}

export function isBatteryCritical(drone: DroneState): boolean {
  if (!Number.isFinite(drone.batteryPct) || drone.batteryPct < 8) return true
  if (drone.cellVoltageV !== undefined
    && (!Number.isFinite(drone.cellVoltageV) || drone.cellVoltageV <= CRITICAL_CELL_V)) return true
  return false
}
