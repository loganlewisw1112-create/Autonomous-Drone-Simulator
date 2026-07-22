import {
  buildAutoLaunchDoctrinePlan,
  buildLaunchBayPlan as buildDoctrineLaunchBayPlan,
} from '@/sim/mission/launchDoctrine'
import { droneIdForIndex } from '@/sim/mission/routeAudit'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import type { LaunchBayPlan, LaunchBayStatus, ScenarioConfig, WeatherVariantState } from '@/types'

export function buildDroneIds(scenario: ScenarioConfig): string[] {
  return Array.from({ length: scenario.droneCount }, (_, index) => droneIdForIndex(index))
}

export function buildLaunchBayPlan(
  scenario: ScenarioConfig,
  weatherState: WeatherVariantState,
  assignments: Record<string, string>,
): LaunchBayPlan {
  return buildDoctrineLaunchBayPlan(scenario, weatherState, assignments)
}

export function computeBayStatuses(
  scenario: ScenarioConfig,
  weatherState: WeatherVariantState,
  assignments: Record<string, string>,
  _droneIds: string[],
): LaunchBayStatus[] {
  return buildLaunchBayPlan(scenario, weatherState, assignments).bayStatuses
}

export function computeBlockers(
  droneIds: string[],
  assignments: Record<string, string>,
  bayStatuses: LaunchBayStatus[],
): string[] {
  const blockers: string[] = []
  droneIds.forEach((droneId) => {
    if (!assignments[droneId]) blockers.push(`${droneId.toUpperCase()} — no launch bay assigned`)
  })
  bayStatuses.forEach((bay) => {
    if (bay.weatherClosed && bay.assignedDroneIds.length > 0) {
      blockers.push(`Bay ${bay.siteId} is weather-closed but has drones assigned`)
    }
    const capacity = bay.effectiveCapacityDrones ?? bay.capacityDrones
    if (bay.assignedDroneIds.length > capacity) {
      blockers.push(`Bay ${bay.siteId} over capacity (${bay.assignedDroneIds.length}/${capacity})`)
    }
  })
  return blockers
}

/**
 * Backward-compatible assignment-only wrapper. Callers with live weather should
 * pass it; legacy callers receive deterministic default conditions.
 */
export function buildAutoAssignments(
  scenario: ScenarioConfig,
  weatherState: WeatherVariantState = getDefaultWeatherState(scenario.seed),
): Record<string, string> {
  return buildAutoLaunchDoctrinePlan(scenario, weatherState).assignments
}

export function buildAutoLaunchBayPlan(
  scenario: ScenarioConfig,
  weatherState: WeatherVariantState,
): LaunchBayPlan {
  return buildAutoLaunchDoctrinePlan(scenario, weatherState)
}
