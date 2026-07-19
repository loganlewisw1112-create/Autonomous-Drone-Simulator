import { droneIdForIndex } from '@/sim/mission/routeAudit'
import type { LaunchBayPlan, LaunchBayStatus, ScenarioConfig, WeatherVariantState } from '@/types'

// Pure launch-bay planning logic shared by the LaunchBayPlanner modal and the
// one-click quick demo. Extracted so the demo path commits the exact same plan
// shape the manual Auto-Assign → Confirm flow produces.

export function buildDroneIds(scenario: ScenarioConfig): string[] {
  return Array.from({ length: scenario.droneCount }, (_, i) => droneIdForIndex(i))
}

export function computeBayStatuses(
  scenario: ScenarioConfig,
  weatherState: WeatherVariantState,
  assignments: Record<string, string>,
  droneIds: string[],
): LaunchBayStatus[] {
  const siteEntries = Object.entries(scenario.launchSites ?? {})
  return siteEntries.map(([siteId, site], i) => {
    const bayKey = `bay-${i}`
    const weatherClosed = weatherState.launchBayAvailability[bayKey] === false
    const assignedDroneIds = droneIds.filter((d) => assignments[d] === siteId)
    return {
      siteId,
      capacityDrones: site.capacityDrones ?? 2,
      assignedDroneIds,
      weatherClosed,
      closureReason: weatherClosed
        ? `Bay closed — ${weatherState.activeHazards.slice(0, 2).join(', ') || 'severe weather'}`
        : undefined,
    }
  })
}

export function computeBlockers(
  droneIds: string[],
  assignments: Record<string, string>,
  bayStatuses: LaunchBayStatus[],
): string[] {
  const b: string[] = []
  droneIds.forEach((id) => {
    if (!assignments[id]) b.push(`${id.toUpperCase()} — no launch bay assigned`)
  })
  bayStatuses.forEach((bay) => {
    if (bay.weatherClosed && bay.assignedDroneIds.length > 0) {
      b.push(`Bay ${bay.siteId} is weather-closed but has drones assigned`)
    }
    if (bay.assignedDroneIds.length > bay.capacityDrones) {
      b.push(`Bay ${bay.siteId} over capacity (${bay.assignedDroneIds.length}/${bay.capacityDrones})`)
    }
  })
  return b
}

export function buildAutoAssignments(scenario: ScenarioConfig): Record<string, string> {
  const siteEntries = Object.entries(scenario.launchSites ?? {})
  const auto: Record<string, string> = {}
  buildDroneIds(scenario).forEach((id, i) => {
    const siteId = siteEntries[i % siteEntries.length]?.[0]
    if (siteId) auto[id] = siteId
  })
  return auto
}

export function buildAutoLaunchBayPlan(
  scenario: ScenarioConfig,
  weatherState: WeatherVariantState,
): LaunchBayPlan {
  const droneIds = buildDroneIds(scenario)
  const assignments = buildAutoAssignments(scenario)
  const bayStatuses = computeBayStatuses(scenario, weatherState, assignments, droneIds)
  const blockers = computeBlockers(droneIds, assignments, bayStatuses)
  return { assignments, bayStatuses, readyToLaunch: blockers.length === 0, blockers }
}
