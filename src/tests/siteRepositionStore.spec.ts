import { beforeEach, describe, expect, it } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { useDroneStore } from '@/store/droneStore'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import { createDroneState } from '@/sim/drone/DroneEntity'
import { tick } from '@/sim/SimulationLoop'
import { offsetLatLng } from '@/utils/geometry'

const scenario = ALL_SCENARIOS.find((item) => item.id === 'demo_basic') ?? ALL_SCENARIOS[0]
const siteId = Object.keys(scenario.launchSites ?? {}).find((id) => scenario.launchSites?.[id].mobile !== false)!

describe('site reposition store transaction', () => {
  beforeEach(() => {
    useDroneStore.setState({
      scenario,
      drones: [],
      launchPlan: null,
      lifecycle: 'preflight',
      tick: 50,
      elapsedSec: 10,
      events: [],
      lastHash: '0'.repeat(64),
      siteOverrides: {},
      siteRelocations: {},
      latestFleetRetaskPlan: null,
      weatherState: getDefaultWeatherState(scenario.seed),
    })
  })

  it('previews without mutation, then atomically records overrides and evidence', () => {
    const authoredSnapshot = JSON.parse(JSON.stringify(scenario))
    const requested = offsetLatLng(scenario.launchSites![siteId].position, 90, 60)

    const preview = useDroneStore.getState().previewSiteReposition(siteId, requested)
    expect(preview.ok, preview.message).toBe(true)
    expect(preview.repositionTimeSec).toBe(0)
    expect(useDroneStore.getState().siteOverrides).toEqual({})

    const result = useDroneStore.getState().repositionLaunchSite(siteId, requested)
    expect(result.ok, result.message).toBe(true)

    const committed = useDroneStore.getState()
    expect(Object.keys(committed.siteOverrides).sort()).toEqual(result.affectedSiteIds)
    result.affectedSiteIds.forEach((affectedSiteId) => {
      expect(committed.siteOverrides[affectedSiteId]).toEqual(result.position)
      expect(committed.siteRelocations[affectedSiteId].availableAtSec).toBe(10)
    })
    expect(committed.events).toHaveLength(1)
    expect(committed.events[0]).toMatchObject({
      eventType: 'launch_site_repositioned',
      droneId: 'system',
      payload: {
        siteId,
        from: result.from,
        to: result.position,
        affected: result.affectedDrones,
        reserveDeltaPct: result.reserveDeltaPct,
        repositionTimeSec: 0,
      },
      prevHash: '0'.repeat(64),
    })
    expect(committed.lastHash).toBe(committed.events[0].hash)
    expect(scenario).toEqual(authoredSnapshot)
  })

  it('applies the relocation delay only during an active mission', () => {
    useDroneStore.setState({ lifecycle: 'running', elapsedSec: 42 })
    const requested = offsetLatLng(scenario.launchSites![siteId].position, 180, 40)
    const result = useDroneStore.getState().repositionLaunchSite(siteId, requested)

    expect(result.ok, result.message).toBe(true)
    expect(result.repositionTimeSec).toBeGreaterThan(0)
    expect(useDroneStore.getState().siteRelocations[siteId].availableAtSec)
      .toBe(42 + result.repositionTimeSec)
    expect(useDroneStore.getState().latestFleetRetaskPlan).not.toBeNull()
  })

  it('routes RTB to the override and withholds recovery until relocation completes', () => {
    const requested = offsetLatLng(scenario.launchSites![siteId].position, 270, 50)
    const result = useDroneStore.getState().repositionLaunchSite(siteId, requested)
    expect(result.ok, result.message).toBe(true)

    const relocationEntries = Object.fromEntries(
      Object.entries(useDroneStore.getState().siteRelocations).map(([id, relocation]) => [
        id,
        { ...relocation, availableAtSec: 30 },
      ]),
    )
    const returning = {
      ...createDroneState('uav-01', 'UAV-01', '#00d4ff', result.position, 120),
      missionState: 'return_to_base' as const,
      launchTimeSec: 0,
    }
    useDroneStore.setState((state) => ({
      drones: [returning],
      lifecycle: 'running',
      elapsedSec: 0,
      siteRelocations: relocationEntries,
      ui: { ...state.ui, isRunning: true },
    }))

    tick()
    expect(useDroneStore.getState().drones[0].missionState).toBe('return_to_base')

    useDroneStore.setState({ elapsedSec: 31 })
    tick()
    expect(useDroneStore.getState().drones[0].missionState).toBe('landed')
  })

  it('leaves state untouched when the domain assessment rejects the site', () => {
    const result = useDroneStore.getState().repositionLaunchSite('missing-site', scenario.startPosition)

    expect(result.ok).toBe(false)
    expect(useDroneStore.getState().siteOverrides).toEqual({})
    expect(useDroneStore.getState().siteRelocations).toEqual({})
    expect(useDroneStore.getState().events).toEqual([])
    expect(useDroneStore.getState().lastHash).toBe('0'.repeat(64))
  })

  it('clears all runtime site state on mission reset', () => {
    const requested = offsetLatLng(scenario.launchSites![siteId].position, 0, 30)
    expect(useDroneStore.getState().repositionLaunchSite(siteId, requested).ok).toBe(true)

    useDroneStore.getState().resetMission()
    expect(useDroneStore.getState().siteOverrides).toEqual({})
    expect(useDroneStore.getState().siteRelocations).toEqual({})
  })
})
