import { beforeEach, describe, expect, it } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { useDroneStore } from '@/store/droneStore'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import { createDroneState } from '@/sim/drone/DroneEntity'
import { initFleet, tick } from '@/sim/SimulationLoop'
import { BAY_SPACING_M } from '@/sim/mission/LaunchCoordinator'
import { haversineDistanceM, offsetLatLng } from '@/utils/geometry'
import type { LaunchRecoverySite, ScenarioConfig } from '@/types'
import { executeInstructorCommand, validateInstructorCommand } from '@/classroom/commandRegistry'

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

  it('pre-launch move parks the fleet on fanned bays around the new CB', () => {
    const shared = makeSharedMobileScenario()
    useDroneStore.setState({
      scenario: shared,
      weatherState: getDefaultWeatherState(shared.seed),
      launchPlan: null,
      lifecycle: 'preflight',
      siteOverrides: {},
      siteRelocations: {},
      events: [],
      lastHash: '0'.repeat(64),
      ui: { ...useDroneStore.getState().ui, isRunning: false },
    })
    initFleet()
    useDroneStore.setState({ lifecycle: 'preflight' })

    const origin = shared.launchSites!.mobile.position
    const requested = offsetLatLng(origin, 90, 250)
    const before = useDroneStore.getState().drones.map((drone) => ({ ...drone.position }))
    const result = useDroneStore.getState().repositionLaunchSite('mobile', requested)
    expect(result.ok, result.message).toBe(true)

    const parked = useDroneStore.getState().drones
    expect(parked).toHaveLength(3)
    for (const drone of parked) {
      expect(haversineDistanceM(drone.position, result.position)).toBeLessThan(BAY_SPACING_M + 1)
      expect(before.some((point) => point.lat === drone.position.lat && point.lng === drone.position.lng)).toBe(false)
    }
    expect(haversineDistanceM(parked[0].position, parked[1].position)).toBeGreaterThanOrEqual(BAY_SPACING_M - 1)
    expect(haversineDistanceM(parked[1].position, parked[2].position)).toBeGreaterThanOrEqual(BAY_SPACING_M - 1)
    expect(useDroneStore.getState().launchPlan?.readyToLaunch).toBe(true)
  })

  it('initFleet honors a pre-existing site override for spawn geometry', () => {
    const shared = makeSharedMobileScenario()
    const moved = offsetLatLng(shared.launchSites!.mobile.position, 0, 300)
    useDroneStore.setState({
      scenario: shared,
      weatherState: getDefaultWeatherState(shared.seed),
      launchPlan: null,
      siteOverrides: { mobile: moved, 'mobile-recovery': moved },
      siteRelocations: {},
      ui: { ...useDroneStore.getState().ui, isRunning: false },
    })
    initFleet()

    const drones = useDroneStore.getState().drones
    expect(useDroneStore.getState().siteOverrides.mobile).toEqual(moved)
    expect(drones).toHaveLength(3)
    for (const drone of drones) {
      expect(haversineDistanceM(drone.position, moved)).toBeLessThan(BAY_SPACING_M + 1)
    }
    expect(haversineDistanceM(drones[0].position, drones[1].position)).toBeGreaterThanOrEqual(BAY_SPACING_M - 1)
  })

  it('classroom reposition_site command replans parked bays the same way', () => {
    const shared = makeSharedMobileScenario()
    useDroneStore.setState({
      scenario: shared,
      weatherState: getDefaultWeatherState(shared.seed),
      launchPlan: null,
      lifecycle: 'preflight',
      siteOverrides: {},
      siteRelocations: {},
      events: [],
      lastHash: '0'.repeat(64),
      ui: { ...useDroneStore.getState().ui, isRunning: false },
    })
    initFleet()
    useDroneStore.setState({ lifecycle: 'preflight' })

    const requested = offsetLatLng(shared.launchSites!.mobile.position, 180, 200)
    const checked = validateInstructorCommand({
      commandId: 'cmd-reposition',
      kind: 'reposition_site',
      siteId: 'mobile',
      position: requested,
    })
    if (!checked.ok) throw new Error(checked.message)

    const executed = executeInstructorCommand(checked.command, { actorSessionId: 'INSTRUCTOR' })
    expect(executed.ok).toBe(true)
    if (!executed.ok) return

    const center = useDroneStore.getState().siteOverrides.mobile
    expect(center).toBeDefined()
    const parked = useDroneStore.getState().drones
    for (const drone of parked) {
      expect(haversineDistanceM(drone.position, center!)).toBeLessThan(BAY_SPACING_M + 1)
    }
    expect(haversineDistanceM(parked[0].position, parked[1].position)).toBeGreaterThanOrEqual(BAY_SPACING_M - 1)
  })
})

function makeSharedMobileScenario(): ScenarioConfig {
  const origin = { lat: 37.75, lng: -122.4 }
  const mobile: LaunchRecoverySite = {
    id: 'mobile',
    kind: 'mobile_command',
    label: 'Shared mobile CB',
    agency: 'UAS OPS',
    position: origin,
    surfaceNote: 'Shared pad',
    capacityDrones: 3,
    padFootprintM: 2 * BAY_SPACING_M,
    repositionRadiusM: 2_000,
    repositionTimeSec: 120,
  }
  const recovery: LaunchRecoverySite = {
    ...mobile,
    id: 'mobile-recovery',
    label: 'Shared mobile recovery',
  }
  const task = offsetLatLng(origin, 45, 800)
  return {
    id: 'phase3-shared-mobile',
    name: 'Phase 3 shared mobile CB',
    description: 'Three drones share one mobile command base',
    seed: 42,
    droneCount: 3,
    missionType: 'waypoint',
    startPosition: origin,
    waypoints: [{ id: 'task', position: task, altitudeFt: 120 }],
    perDroneWaypoints: {
      'uav-01': [{ id: 't1', position: offsetLatLng(task, 0, 0), altitudeFt: 120 }],
      'uav-02': [{ id: 't2', position: offsetLatLng(task, 90, 80), altitudeFt: 120 }],
      'uav-03': [{ id: 't3', position: offsetLatLng(task, 180, 80), altitudeFt: 120 }],
    },
    geofences: [],
    heatSources: [],
    batteryStartPct: 100,
    batteryDrainRatePerSec: 0.01,
    commsLossWindows: [],
    launchSites: { mobile },
    recoverySites: { 'mobile-recovery': recovery },
    defaultLaunchAssignments: {
      'uav-01': 'mobile',
      'uav-02': 'mobile',
      'uav-03': 'mobile',
    },
    defaultRecoveryAssignments: {
      'uav-01': 'mobile-recovery',
      'uav-02': 'mobile-recovery',
      'uav-03': 'mobile-recovery',
    },
  }
}
