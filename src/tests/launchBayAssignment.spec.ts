/**
 * Regression guard for the launch-bay dead wire (audit H1): LaunchBayPlanner assignments are
 * keyed by the scenario.launchSites record keys, and initFleet must resolve them the same way —
 * a reassigned bay MUST move the drone's spawn position.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { useDroneStore } from '@/store/droneStore'
import { initFleet } from '@/sim/SimulationLoop'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import type { LaunchBayPlan } from '@/types'

const scenario = ALL_SCENARIOS.find((s) => s.id === 'demo_sar_coastal') ?? ALL_SCENARIOS[0]
const siteIds = Object.keys(scenario.launchSites ?? {})

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

  it('scenario provides per-drone launch sites keyed by drone id', () => {
    expect(siteIds.length).toBeGreaterThanOrEqual(2)
    expect(scenario.launchSites?.['uav-01']).toBeDefined()
  })

  it('spawns each drone at its own site when no reassignment is made', () => {
    useDroneStore.setState({ launchPlan: makePlan({ 'uav-01': 'uav-01' }) })
    initFleet()
    const uav01 = useDroneStore.getState().drones.find((d) => d.id === 'uav-01')!
    expect(uav01.position).toEqual(scenario.launchSites!['uav-01'].position)
  })

  it('moves the spawn position when the operator reassigns a bay', () => {
    const otherSiteId = siteIds.find((id) => id !== 'uav-01')!
    const otherSite = scenario.launchSites![otherSiteId]
    expect(otherSite.position).not.toEqual(scenario.launchSites!['uav-01'].position)

    useDroneStore.setState({ launchPlan: makePlan({ 'uav-01': otherSiteId }) })
    initFleet()

    const uav01 = useDroneStore.getState().drones.find((d) => d.id === 'uav-01')!
    expect(uav01.position).toEqual(otherSite.position)
  })

  it('falls back to the drone default site for unknown assignment keys', () => {
    useDroneStore.setState({ launchPlan: makePlan({ 'uav-01': 'site-does-not-exist' }) })
    initFleet()
    const uav01 = useDroneStore.getState().drones.find((d) => d.id === 'uav-01')!
    expect(uav01.position).toEqual(scenario.launchSites!['uav-01'].position)
  })
})
