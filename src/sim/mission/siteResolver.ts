import type { LatLng, LaunchRecoverySite, ScenarioConfig } from '@/types'

export type SiteOverrides = Record<string, LatLng>

const MOBILE_SITE_KINDS = new Set<LaunchRecoverySite['kind']>([
  'mobile_command',
  'field_icp',
  'vessel',
])

/** Resolve either authored site pool through runtime overrides without mutating scenario input. */
export function resolveLaunchSite(
  scenario: ScenarioConfig,
  siteId: string,
  overrides: Readonly<SiteOverrides> = {},
): LaunchRecoverySite | undefined {
  const site = scenario.launchSites?.[siteId] ?? scenario.recoverySites?.[siteId]
  if (!site) return undefined

  const resolvedId = site.id?.trim() || siteId
  const position = overrides[siteId] ?? overrides[resolvedId] ?? site.position
  return {
    ...site,
    id: resolvedId,
    mobile: isMobileLaunchSite(site),
    position: { ...position },
  }
}

export function isMobileLaunchSite(site: LaunchRecoverySite): boolean {
  return site.mobile ?? MOBILE_SITE_KINDS.has(site.kind)
}
