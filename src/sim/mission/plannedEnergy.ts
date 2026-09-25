import { modelledDrainRatePerSec, reserveBatteryPct, type FlightEnvironment } from '@/sim/drone/DroneEntity'
import { platformForDrone } from '@/sim/drone/platformCatalog'
import { lowAltitudeDryden } from '@/sim/weather/dryden'
import type { ScenarioConfig, WeatherVariantState } from '@/types'
import { batteryProfileForDrone, batteryReservePctForDrone } from './rechargeStations'

/**
 * Battery planning on the same model the aircraft burns against.
 *
 * The live loop has drained batteries through the WP-11 endurance/load model since July, but the
 * RTB energy-to-home gate, launch doctrine, site reposition and the tactical advisor kept pricing
 * legs with the scenario's flat `batteryDrainRatePerSec` — about 3x more optimistic than what the
 * aircraft then actually burned. Every planner now asks `modelledDrainRatePerSec` directly, with
 * the airframe, the forecast weather and the throttle the mission manager will command.
 */

const KTS_TO_MS = 0.514444
/** Navigate/SAR-grid throttle MissionManager commands. */
export const CRUISE_THROTTLE = 0.8
/** Return-to-base throttle MissionManager commands. */
export const RTB_THROTTLE = 0.9
/** Gusts are sampled at the RTB leg / tasking altitude band. */
const PLANNING_ALTITUDE_FT = 120
/** E|X| for X ~ N(0, σ²) is σ·√(2/π). The load factor is linear in |gust|, so the expected
 *  gust load is the load at the mean gust magnitude. */
const MEAN_ABS_GAUSSIAN = Math.sqrt(2 / Math.PI)

/** Everything a planner may know about the weather; absent fields mean still air at 20 °C. */
export type PlanningWeather = Partial<Pick<
  WeatherVariantState,
  'tempF' | 'windKts' | 'gustKts' | 'batteryDrainMultiplier' | 'speedCapMultiplier'
>>

/** SoC at which a modelled pack's loaded voltage reaches the autopilot's reserve (~37.5%). Pure, so computed once. */
const VOLTAGE_RESERVE_PCT = reserveBatteryPct()

/**
 * The battery level a TASKED aircraft must keep. The autopilot turns a navigating aircraft for home
 * at the scenario's percentage reserve or the pack's voltage reserve, whichever comes first, so a
 * task priced against the 25% floor alone would be abandoned part-way. Legs flown as a return to
 * base are exempt from that gate and keep the percentage reserve as their landing floor.
 */
export function taskingReservePctForDrone(scenario: ScenarioConfig, droneId: string): number {
  return Math.max(batteryReservePctForDrone(scenario, droneId), VOLTAGE_RESERVE_PCT)
}

/** A scenario battery kit scales the airframe's rated endurance (e.g. an extended-endurance pack). */
export function enduranceScaleForDrone(scenario: ScenarioConfig, droneId: string): number {
  const multiplier = batteryProfileForDrone(scenario, droneId)?.enduranceMultiplier
  return multiplier && multiplier > 0 ? multiplier : 1
}

/** The flight environment a planner expects: forecast wind, the mean Dryden gust magnitude the
 *  live loop will draw from, ambient temperature and the scenario's residual drain dial. */
export function planningEnvironment(
  scenario: ScenarioConfig,
  droneId: string,
  weather?: PlanningWeather,
): FlightEnvironment {
  const tempF = weather?.tempF ?? 68
  const { sigmaMs } = lowAltitudeDryden((weather?.gustKts ?? 0) * KTS_TO_MS, PLANNING_ALTITUDE_FT)
  return {
    tempC: (tempF - 32) * 5 / 9,
    windMs: (weather?.windKts ?? 0) * KTS_TO_MS,
    gustMs: sigmaMs * MEAN_ABS_GAUSSIAN,
    drainMultiplier: weather?.batteryDrainMultiplier ?? 1,
    enduranceScale: enduranceScaleForDrone(scenario, droneId),
  }
}

/** Groundspeed at a commanded throttle after the weather speed cap, as the live loop applies it. */
export function plannedSpeedMs(
  scenario: ScenarioConfig,
  droneId: string,
  weather?: PlanningWeather,
  throttle = CRUISE_THROTTLE,
): number {
  return Math.max(0.1, platformForDrone(scenario, droneId).maxSpeedMs * throttle * (weather?.speedCapMultiplier ?? 1))
}

/** Modelled drain (% per second) for this drone at a given speed in the forecast weather. */
export function plannedDrainRatePerSec(
  scenario: ScenarioConfig,
  droneId: string,
  weather?: PlanningWeather,
  speedMs = plannedSpeedMs(scenario, droneId, weather),
): number {
  return modelledDrainRatePerSec(speedMs, platformForDrone(scenario, droneId), planningEnvironment(scenario, droneId, weather))
}

/**
 * Battery (% of pack) to fly `distanceM` and then hold for `dwellSec`.
 * Transit is priced at `speedMs` (cruise throttle by default); dwell is priced as a hover.
 */
export function plannedLegEnergyPct(
  scenario: ScenarioConfig,
  droneId: string,
  distanceM: number,
  weather?: PlanningWeather,
  options: { speedMs?: number; dwellSec?: number } = {},
): number {
  const speedMs = Math.max(0.1, options.speedMs ?? plannedSpeedMs(scenario, droneId, weather))
  const transit = (Math.max(0, distanceM) / speedMs) * plannedDrainRatePerSec(scenario, droneId, weather, speedMs)
  const dwellSec = Math.max(0, options.dwellSec ?? 0)
  const dwell = dwellSec > 0 ? dwellSec * plannedDrainRatePerSec(scenario, droneId, weather, 0) : 0
  return transit + dwell
}
