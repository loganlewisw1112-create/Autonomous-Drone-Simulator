/**
 * Regression guard for the launch-bay dead wire (audit H1): LaunchBayPlanner assignments are
 * keyed by the scenario.launchSites record keys, and initFleet must resolve them the same way —
 * a reassigned bay MUST move the drone's spawn position.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { useDroneStore } from '@/store/droneStore'
import { initFleet } from '@/sim/SimulationLoop'
import { BAY_SPACING_M } from '@/sim/mission/LaunchCoordinator'
import { buildAutoLaunchBayPlan } from '@/sim/mission/launchBayPlanning'
import { buildLaunchSlotsForPlan } from '@/sim/mission/launchPlanGeometry'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import { haversineDistanceM } from '@/utils/geometry'
import type { LaunchBayPlan } from '@/types'

const scenario = ALL_SCENARIOS.find((s) => s.id === 'extreme_multiagency_sf_pursuit') ?? ALL_SCENARIOS[0]
const siteIds = Object.keys(scenario.launchSites ?? {})
const defaultAssignments = scenario.defaultLaunchAssignments ?? {}

function singletonAssignment(): [string, string] {
  const counts = new Map<string, number>()
  Object.values(defaultAssignments).forEach((siteId) => counts.set(siteId, (counts.get(siteId) ?? 0) + 1))
  return Object.entries(defaultAssignments).find(([, siteId]) => counts.get(siteId) === 1)!
}

function makePlan(assignments: Record<string, string>): LaunchBayPlan {
  return { assignments, bayStatuses: [], readyToLaunch: true, blockers: [] }
}

describe('launch bay assignment wiring', () => {
  beforeEach(() => {
    useDroneStore.setState({
      scenario,
      weatherState: getDefaultWeatherState(scenario.seed),
      launchPlan: null,
    })
  })

  it('scenario provides a stable physical-site pool with valid default assignments', () => {
    expect(siteIds.length).toBeGreaterThanOrEqual(1)
    for (const siteId of Object.values(defaultAssignments)) {
      expect(scenario.launchSites?.[siteId]).toBeDefined()
      expect(scenario.launchSites?.[siteId]?.id).toBe(siteId)
    }
  })

  it('preserves an authored site coordinate for a singleton assignment', () => {
    const [droneId, siteId] = singletonAssignment()
    initFleet()
    const drone = useDroneStore.getState().drones.find((candidate) => candidate.id === droneId)!
    expect(drone.position).toEqual(scenario.launchSites![siteId].position)
  })

  it('fans a reassigned drone away from the resident drone at a shared site', () => {
    const [sourceId, sourceDefaultSiteId] = singletonAssignment()
    const residentEntry = Object.entries(defaultAssignments).find(([, siteId]) => siteId !== sourceDefaultSiteId)!
    const [residentId, sharedSiteId] = residentEntry
    const sharedSite = scenario.launchSites![sharedSiteId]

    useDroneStore.setState({ launchPlan: makePlan({ [sourceId]: sharedSiteId }) })
    initFleet()

    const reassigned = useDroneStore.getState().drones.find((d) => d.id === sourceId)!
    const resident = useDroneStore.getState().drones.find((d) => d.id === residentId)!
    const midpoint = {
      lat: (reassigned.position.lat + resident.position.lat) / 2,
      lng: (reassigned.position.lng + resident.position.lng) / 2,
    }
    expect(haversineDistanceM(reassigned.position, resident.position)).toBeGreaterThanOrEqual(BAY_SPACING_M - 1)
    expect(haversineDistanceM(midpoint, sharedSite.position)).toBeLessThan(0.2)
  })

  it('falls back to the drone default site for unknown assignment keys', () => {
    const [droneId, siteId] = singletonAssignment()
    useDroneStore.setState({ launchPlan: makePlan({ [droneId]: 'site-does-not-exist' }) })
    initFleet()
    const drone = useDroneStore.getState().drones.find((candidate) => candidate.id === droneId)!
    expect(drone.position).toEqual(scenario.launchSites![siteId].position)
  })

  it('atomically applies a confirmed plan to the parked fleet', () => {
    initFleet()
    useDroneStore.getState().setLifecycle('preflight')
    const state = useDroneStore.getState()
    const plan = buildAutoLaunchBayPlan(scenario, state.weatherState)
    expect(plan.readyToLaunch, plan.blockers.join(' · ')).toBe(true)
    const placements = buildLaunchSlotsForPlan(scenario, plan, state.droneWaypoints)

    expect(useDroneStore.getState().applyParkedLaunchPlan(plan, placements)).toBe(true)
    const applied = useDroneStore.getState()
    expect(applied.launchPlan).toEqual(plan)
    for (const drone of applied.drones) {
      expect(drone.position).toEqual(placements[drone.id].bay)
      expect(drone.scheduledLaunchSec).toBe(placements[drone.id].scheduledLaunchSec)
    }
  })

  it('refuses to reposition a running fleet', () => {
    initFleet()
    const before = useDroneStore.getState().drones
    const plan = makePlan(defaultAssignments)
    const placements = buildLaunchSlotsForPlan(scenario, plan, useDroneStore.getState().droneWaypoints)
    useDroneStore.setState({ lifecycle: 'running' })

    expect(useDroneStore.getState().applyParkedLaunchPlan(plan, placements)).toBe(false)
    expect(useDroneStore.getState().drones).toEqual(before)
  })
})
