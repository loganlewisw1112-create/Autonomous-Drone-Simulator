import { resolveLaunchSite, type SiteOverrides } from '@/sim/mission/siteResolver'
import { recoverySiteIdForDrone } from '@/sim/mission/siteAssignments'
import {
  selectRechargeStationForDrone,
  type RechargeStationSelection,
} from '@/sim/mission/rechargeStations'
import type { DroneState, LatLng, ScenarioConfig } from '@/types'

/**
 * Single source of truth for "where does this aircraft go when it goes home?"
 *
 * This exists because the answer was previously derived in two places that had drifted:
 * the tick resolved recharge-station → recovery-site → scenario start, while the lost-link
 * route validator checked a route to scenario.startPosition unconditionally. A lost-link
 * RTB could therefore be *validated* against a destination the aircraft would never fly to,
 * and an unflyable real destination could be cleared for return. Every consumer must call
 * this resolver rather than re-deriving precedence locally.
 *
 * Precedence is deliberate and unchanged from the flown behavior:
 *   1. assigned forward recharge station (closest thing to a live, reachable base)
 *   2. assigned recovery site (honoring operator site relocations via `siteOverrides`)
 *   3. scenario start position (always defined, so resolution never fails)
 */

export type RtbDestinationSource = 'recharge_station' | 'recovery_site' | 'scenario_start'

export interface RtbDestination {
  position: LatLng
  label: string
  source: RtbDestinationSource
  /** Non-null when the destination is a forward recharge station. */
  rechargeStation: RechargeStationSelection | null
  /** Set whenever the drone has an assigned recovery site, even if a station outranks it. */
  recoverySiteId?: string
}

/** The subset of drone state the destination actually depends on. */
export type RtbDestinationDrone = Pick<
  DroneState,
  'id' | 'missionState' | 'sortieCount' | 'currentWaypointIndex'
>

/**
 * Home for STATIC route planning and auditing, where no live drone state exists.
 *
 * Pre-flight planners (safe-route construction, scenario route audits, the custom-mission
 * designer) still need the same answer the aircraft will reach at the END of its route, so
 * this models exactly that: final waypoint, first sortie, not sitting on a station. It exists
 * so those callers never hand-roll a precedence of their own — routeAudit.ts previously
 * carried a third variant (recovery site → last recharge station → start) that disagreed with
 * the flown one whenever a scenario had both a recovery site and staged stations (audit F-04).
 */
export function resolvePlannedRtbDestination(
  scenario: ScenarioConfig,
  droneId: string,
  route: readonly unknown[] = [],
  siteOverrides: Readonly<SiteOverrides> = {},
): RtbDestination {
  return resolveRtbDestination(
    scenario,
    {
      id: droneId,
      // Not 'recharge': the aircraft is inbound, not already parked on a station, so the
      // sortie it is completing is the one it flew.
      missionState: 'return_to_base',
      sortieCount: 0,
      currentWaypointIndex: Math.max(0, route.length - 1),
    },
    siteOverrides,
  )
}

export function resolveRtbDestination(
  scenario: ScenarioConfig,
  drone: RtbDestinationDrone,
  siteOverrides: Readonly<SiteOverrides> = {},
): RtbDestination {
  // A drone sitting ON a station has already consumed that sortie's station, so the
  // selector is asked about the sortie it is currently completing, not the next one.
  // Keeping this here (rather than at the call site) is the whole point of the module:
  // both the flown path and the validator must agree on which station is "current".
  const stationSortieCount = drone.missionState === 'recharge'
    ? Math.max(0, (drone.sortieCount ?? 0) - 1)
    : (drone.sortieCount ?? 0)

  const rechargeStation = selectRechargeStationForDrone({
    scenario,
    droneId: drone.id,
    sortieCount: stationSortieCount,
    currentWaypointIndex: drone.currentWaypointIndex,
  })

  const recoverySiteId = recoverySiteIdForDrone(scenario, drone.id)
  const recoverySite = recoverySiteId
    ? resolveLaunchSite(scenario, recoverySiteId, siteOverrides)
    : undefined

  if (rechargeStation) {
    return {
      position: rechargeStation.position,
      label: rechargeStation.station.label,
      source: 'recharge_station',
      rechargeStation,
      recoverySiteId,
    }
  }

  if (recoverySite) {
    return {
      position: recoverySite.position,
      label: recoverySite.label,
      source: 'recovery_site',
      rechargeStation: null,
      recoverySiteId,
    }
  }

  return {
    position: scenario.startPosition,
    label: 'Base',
    source: 'scenario_start',
    rechargeStation: null,
    recoverySiteId,
  }
}
