import { resolveLaunchSite, type SiteOverrides } from '@/sim/mission/siteResolver'
import type { LaunchRecoverySite, ScenarioConfig } from '@/types'

export function launchSiteIdForDrone(scenario: ScenarioConfig, droneId: string): string | undefined {
  const assigned = scenario.defaultLaunchAssignments?.[droneId]
  if (assigned && scenario.launchSites?.[assigned]) return assigned
  return scenario.launchSites?.[droneId] ? droneId : undefined
}

export function recoverySiteIdForDrone(scenario: ScenarioConfig, droneId: string): string | undefined {
  const assigned = scenario.defaultRecoveryAssignments?.[droneId]
  if (assigned && scenario.recoverySites?.[assigned]) return assigned
  return scenario.recoverySites?.[droneId] ? droneId : undefined
}

export function launchSiteForDrone(
  scenario: ScenarioConfig,
  droneId: string,
  overrides: Readonly<SiteOverrides> = {},
): LaunchRecoverySite | undefined {
  const siteId = launchSiteIdForDrone(scenario, droneId)
  return siteId ? resolveLaunchSite(scenario, siteId, overrides) : undefined
}

export function recoverySiteForDrone(
  scenario: ScenarioConfig,
  droneId: string,
  overrides: Readonly<SiteOverrides> = {},
): LaunchRecoverySite | undefined {
  const siteId = recoverySiteIdForDrone(scenario, droneId)
  return siteId ? resolveLaunchSite(scenario, siteId, overrides) : undefined
}
