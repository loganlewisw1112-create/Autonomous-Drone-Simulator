import { haversineDistanceM } from '@/utils/geometry'
import { platformForDrone } from '@/sim/drone/platformCatalog'
import type { BatteryProfile, LatLng, RechargeStation, ScenarioConfig } from '@/types'

export interface RechargeStationSelectionInput {
  scenario: ScenarioConfig
  droneId: string
  sortieCount: number
  currentWaypointIndex: number
}

export interface RechargeStationSelection {
  station: RechargeStation
  position: LatLng
  sequenceIndex: number
}

export function batteryProfileForDrone(scenario: ScenarioConfig, droneId: string): BatteryProfile | undefined {
  return scenario.droneBatteryProfiles?.[droneId] ?? scenario.batteryProfile
}

export function batteryReservePctForDrone(scenario: ScenarioConfig, droneId: string): number {
  return batteryProfileForDrone(scenario, droneId)?.reservePct ?? 25
}

export function effectiveBatteryDrainRateForDrone(scenario: ScenarioConfig, droneId: string): number {
  const profile = batteryProfileForDrone(scenario, droneId)
  // Precedence: explicit BatteryProfile endurance multiplier (per-drone then fleet)
  // wins → else the assigned platform's endurance multiplier → else neutral (1).
  let enduranceMultiplier = 1
  if (profile?.enduranceMultiplier && profile.enduranceMultiplier > 0) {
    enduranceMultiplier = profile.enduranceMultiplier
  } else {
    const platform = platformForDrone(scenario, droneId)
    if (platform.enduranceMultiplier > 0) enduranceMultiplier = platform.enduranceMultiplier
  }
  return scenario.batteryDrainRatePerSec / enduranceMultiplier
}

export function chargeRateMultiplierForDrone(scenario: ScenarioConfig, droneId: string): number {
  return batteryProfileForDrone(scenario, droneId)?.chargeRateMultiplier ?? 1
}

export function rechargeStationsForDrone(scenario: ScenarioConfig, droneId: string): RechargeStation[] {
  const stationsById = new Map((scenario.rechargeStations ?? []).map((station) => [station.id, station]))
  const stationIds = scenario.perDroneRechargeStationIds?.[droneId]

  if (stationIds?.length) {
    return stationIds
      .map((id) => stationsById.get(id))
      .filter((station): station is RechargeStation => Boolean(station))
  }

  const positions = scenario.perDroneRechargeStations?.[droneId] ?? []
  return positions.map((position, index) =>
    stationForPosition(scenario, position) ?? {
      id: `${droneId}-recharge-${index + 1}`,
      label: `Recharge Station ${index + 1}`,
      position,
      road: 'Scenario recovery route',
      agency: 'UAS OPS',
    }
  )
}

export function selectRechargeStationForDrone(input: RechargeStationSelectionInput): RechargeStationSelection | null {
  const sequence = rechargeStationsForDrone(input.scenario, input.droneId)
  if (sequence.length === 0) return null

  const routeLength = input.scenario.perDroneWaypoints?.[input.droneId]?.length
    ?? input.scenario.waypoints.length
  const maxRouteIndex = Math.max(1, routeLength - 1)
  const progressRatio = Math.max(0, Math.min(1, input.currentWaypointIndex / maxRouteIndex))
  const progressIndex = Math.floor(progressRatio * (sequence.length - 1))
  const preferredIndex = Math.max(0, Math.min(sequence.length - 1, Math.max(input.sortieCount, progressIndex)))

  return {
    station: sequence[preferredIndex],
    position: sequence[preferredIndex].position,
    sequenceIndex: preferredIndex,
  }
}

export function stationForPosition(scenario: ScenarioConfig, position: LatLng): RechargeStation | undefined {
  return scenario.rechargeStations?.find((station) => haversineDistanceM(station.position, position) < 35)
}

export function rechargeStationLabelForEvent(scenario: ScenarioConfig, stationId?: unknown, fallbackPosition?: LatLng): string | undefined {
  if (typeof stationId === 'string') {
    const station = scenario.rechargeStations?.find((item) => item.id === stationId)
    if (station) return station.label
  }
  if (fallbackPosition) return stationForPosition(scenario, fallbackPosition)?.label
  return undefined
}
