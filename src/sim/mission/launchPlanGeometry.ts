import { BAY_SPACING_M, planCoordinatedLaunch, type LaunchSlot } from '@/sim/mission/LaunchCoordinator'
import { droneIdForIndex } from '@/sim/mission/routeAudit'
import type { LatLng, LaunchBayPlan, ScenarioConfig, Waypoint } from '@/types'

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
