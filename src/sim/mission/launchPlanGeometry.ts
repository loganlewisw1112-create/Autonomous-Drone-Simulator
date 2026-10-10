import { BAY_SPACING_M, planCoordinatedLaunch, type LaunchSlot } from '@/sim/mission/LaunchCoordinator'
import { buildBayStatuses, buildLaunchDoctrineSituation } from '@/sim/mission/launchDoctrine'
import { droneIdForIndex } from '@/sim/mission/routeAudit'
import type { LatLng, LaunchBayPlan, ScenarioConfig, Waypoint, WeatherVariantState } from '@/types'

export const WEATHER_BLOCKER_PREFIX = 'Weather:'

/** First weather-closure blocker on a plan, for operator-facing START hints. */
export function launchWeatherBlocker(plan: LaunchBayPlan | null | undefined): string | null {
  return plan?.blockers.find((blocker) => blocker.startsWith(WEATHER_BLOCKER_PREFIX)) ?? null
}

/**
 * Seed a plan from authored defaults when the operator has not confirmed one yet.
 * With live weather the seed is gated by the launch doctrine itself (the same
 * `weatherGateForSite` limits the planner uses): a bay the doctrine closes carries
 * `weatherClosed` + `closureReason`, and the plan is not ready while any closed bay has
 * drones assigned. Without weather the legacy always-ready seed is returned.
 */
export function seededLaunchPlanFromScenario(
  scenario: ScenarioConfig,
  weather?: WeatherVariantState,
  siteOverrides: Readonly<Record<string, LatLng>> = {},
): LaunchBayPlan | null {
  if (!scenario.defaultLaunchAssignments) return null
  const assignments = { ...scenario.defaultLaunchAssignments }
  if (!weather) return { assignments, bayStatuses: [], readyToLaunch: true, blockers: [] }

  const situation = buildLaunchDoctrineSituation({ scenario, weather, siteOverrides }, assignments)
  const bayStatuses = buildBayStatuses(situation, assignments)
  const conditions = `gusts ${Math.round(weather.gustKts)} kt, ceiling ${Math.round(weather.ceilingFt)} ft`
  const blockers = bayStatuses
    .filter((bay) => bay.weatherClosed && bay.assignedDroneIds.length > 0)
    .map((bay) => `${WEATHER_BLOCKER_PREFIX} bay ${bay.siteId} closed (${bay.closureReason ?? 'weather limits exceeded'}; ${conditions})`)
  return { assignments, bayStatuses, readyToLaunch: blockers.length === 0, blockers }
}

/**
 * True for a plan that is still just the authored-default seed (no doctrine
 * `assignmentDetails`, assignments identical to the defaults), as opposed to one an
 * operator confirmed through bay planning.
 */
export function isSeededLaunchPlan(scenario: ScenarioConfig, plan: LaunchBayPlan | null): boolean {
  const defaults = scenario.defaultLaunchAssignments
  if (!plan || !defaults || plan.assignmentDetails) return false
  const planned = Object.entries(plan.assignments)
  return planned.length === Object.keys(defaults).length
    && planned.every(([droneId, siteId]) => defaults[droneId] === siteId)
}

export function effectiveLaunchPlan(
  scenario: ScenarioConfig,
  launchPlan: LaunchBayPlan | null,
): LaunchBayPlan | null {
  return launchPlan ?? seededLaunchPlanFromScenario(scenario)
}

/**
 * Recompute coordinated bays around the current (possibly overridden) launch sites.
 * Used by initFleet and by pre-launch mobile-base reposition so every shell launches
 * from the same fan geometry.
 */
export function replanLaunchSlots(
  scenario: ScenarioConfig,
  launchPlan: LaunchBayPlan | null,
  routes: Readonly<Record<string, readonly Waypoint[]>>,
  siteOverrides: Readonly<Record<string, LatLng>> = {},
): Record<string, LaunchSlot> {
  return buildLaunchSlotsForPlan(
    scenario,
    effectiveLaunchPlan(scenario, launchPlan),
    routes,
    siteOverrides,
  )
}

export function buildLaunchSlotsForPlan(
  scenario: ScenarioConfig,
  plan: LaunchBayPlan | null,
  routes: Readonly<Record<string, readonly Waypoint[]>>,
  siteOverrides: Readonly<Record<string, LatLng>> = {},
): Record<string, LaunchSlot> {
  const droneIds = Array.from({ length: scenario.droneCount }, (_, index) => droneIdForIndex(index))
  const explicitBays: Record<string, LatLng> = {}
  const explicitBaySiteIds: Record<string, string> = {}
  const explicitBayFootprintsM: Record<string, number> = {}
  const firstTargets: Record<string, LatLng> = {}

  for (const droneId of droneIds) {
    const plannedSiteId = plan?.assignments[droneId]
    const plannedSite = plannedSiteId ? scenario.launchSites?.[plannedSiteId] : undefined
    const defaultSiteId = scenario.defaultLaunchAssignments?.[droneId]
    const defaultSite = defaultSiteId ? scenario.launchSites?.[defaultSiteId] : undefined
    const legacySite = scenario.launchSites?.[droneId]
    const authoredSite = plannedSite ?? defaultSite ?? legacySite
    const recordKey = plannedSite
      ? plannedSiteId
      : defaultSite
        ? defaultSiteId
        : legacySite ? droneId : undefined
    const site = authoredSite && recordKey
      ? { ...authoredSite, position: siteOverrides[authoredSite.id?.trim() || recordKey] ?? siteOverrides[recordKey] ?? authoredSite.position }
      : authoredSite
    const bay = site?.position ?? scenario.perDroneStartPositions?.[droneId]

    if (bay) explicitBays[droneId] = bay
    if (site && recordKey) {
      const siteId = site.id?.trim() || recordKey
      const capacity = site.capacityDrones ?? 2
      explicitBaySiteIds[droneId] = siteId
      explicitBayFootprintsM[siteId] = site.padFootprintM
        ?? Math.max(0, capacity - 1) * BAY_SPACING_M
    }
    firstTargets[droneId] = routes[droneId]?.[0]?.position ?? scenario.startPosition
  }

  return planCoordinatedLaunch({
    startPosition: scenario.startPosition,
    droneIds,
    firstTargets,
    explicitBays,
    explicitBaySiteIds,
    explicitBayFootprintsM,
  })
}
