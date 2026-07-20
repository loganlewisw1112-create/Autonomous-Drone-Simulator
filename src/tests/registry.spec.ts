// @vitest-environment jsdom
/**
 * Dynamic scenario registry + custom-mission compile path.
 *
 * Covers: a registered custom mission surfaces through both the imperative getScenarioOptions()
 * and the reactive useScenarioOptions() hook; unregister removes it; operator-authored routes and
 * default launch assignments survive enhanceScenarioForOperations AND initFleet's route derivation
 * (per-drone waypoints must round-trip unchanged); and the designer altitude guard.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  getScenarioById,
  getScenarioOptions,
  registerCustomScenario,
  unregisterCustomScenario,
  useScenarioOptions,
} from '@/scenarios/registry'
import { validateAltitude } from '@/sim/mission/operatorRoutes'
import { saveDroneWaypointRoute } from '@/sim/mission/waypointPersistence'
import { useDroneStore } from '@/store/droneStore'
import { initFleet } from '@/sim/SimulationLoop'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import type { ScenarioConfig, Waypoint } from '@/types'

const CUSTOM_ID = 'custom-registry-test-001'

const authoredRoutes: Record<string, Waypoint[]> = {
  'uav-01': [
    { id: 'auth-1', label: 'Authored 1', position: { lat: 37.7800, lng: -122.4000 }, altitudeFt: 120 },
    { id: 'auth-2', label: 'Authored 2', position: { lat: 37.7810, lng: -122.4010 }, altitudeFt: 160 },
    { id: 'auth-3', label: 'Authored 3', position: { lat: 37.7820, lng: -122.4020 }, altitudeFt: 200 },
  ],
}

const defaultLaunchAssignments: Record<string, string> = { 'uav-01': 'site-a' }

function makeCustomScenario(): ScenarioConfig {
  return {
    id: CUSTOM_ID,
    name: 'Custom Registry Test Mission',
    description: 'Operator-authored test mission for the registry compile path.',
    seed: 7,
    droneCount: 1,
    missionType: 'waypoint',
    startPosition: { lat: 37.7790, lng: -122.3990 },
    waypoints: [],
    geofences: [],
    heatSources: [],
    batteryStartPct: 100,
    batteryDrainRatePerSec: 0.05,
    commsLossWindows: [],
    isCustom: true,
    authoredRoutes,
    defaultLaunchAssignments,
    launchSites: {
      'site-a': {
        kind: 'field_icp',
        label: 'Test Site A',
        agency: 'TEST',
        position: { lat: 37.7790, lng: -122.3990 },
        surfaceNote: 'test pad',
      },
    },
  }
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  unregisterCustomScenario(CUSTOM_ID)
})

describe('scenario registry', () => {
  it('seeds from the static catalog', () => {
    expect(getScenarioOptions().length).toBeGreaterThan(0)
    expect(getScenarioById('demo_basic')).toBeDefined()
  })

  it('a registered custom scenario appears in getScenarioOptions() and getScenarioById()', () => {
    expect(getScenarioById(CUSTOM_ID)).toBeUndefined()
    registerCustomScenario(makeCustomScenario())
    expect(getScenarioOptions().some((o) => o.id === CUSTOM_ID)).toBe(true)
    expect(getScenarioById(CUSTOM_ID)?.label).toBe('Custom Registry Test Mission')
  })

  it('unregister removes the custom scenario', () => {
    registerCustomScenario(makeCustomScenario())
    expect(getScenarioById(CUSTOM_ID)).toBeDefined()
    unregisterCustomScenario(CUSTOM_ID)
    expect(getScenarioById(CUSTOM_ID)).toBeUndefined()
    expect(getScenarioOptions().some((o) => o.id === CUSTOM_ID)).toBe(false)
  })

  it('useScenarioOptions() re-renders when a custom scenario is (un)registered', () => {
    const { result } = renderHook(() => useScenarioOptions())
    const baseline = result.current.length

    act(() => { registerCustomScenario(makeCustomScenario()) })
    expect(result.current.length).toBe(baseline + 1)
    expect(result.current.some((o) => o.id === CUSTOM_ID)).toBe(true)

    act(() => { unregisterCustomScenario(CUSTOM_ID) })
    expect(result.current.length).toBe(baseline)
    expect(result.current.some((o) => o.id === CUSTOM_ID)).toBe(false)
  })
})

describe('custom-mission authored routes survive the compile path', () => {
  it('enhanceScenarioForOperations honors authored routes verbatim (no overwrite)', () => {
    const option = registerCustomScenario(makeCustomScenario())
    expect(option.config.isCustom).toBe(true)
    expect(option.config.authoredRoutes).toEqual(authoredRoutes)
    expect(option.config.defaultLaunchAssignments).toEqual(defaultLaunchAssignments)
    // The overwrite bug: perDroneWaypoints must equal the authored input, not derived routes.
    expect(option.config.perDroneWaypoints?.['uav-01']).toEqual(authoredRoutes['uav-01'])
  })

  it('authored routes also survive initFleet route derivation', () => {
    const option = registerCustomScenario(makeCustomScenario())
    useDroneStore.setState({
      scenario: option.config,
      launchPlan: null,
      drones: [],
      weatherState: getDefaultWeatherState(option.config.seed),
    })

    initFleet()

    const droneWaypoints = useDroneStore.getState().droneWaypoints
    expect(droneWaypoints['uav-01']).toEqual(authoredRoutes['uav-01'])
    // The seeded launch plan reflects the authored default assignment.
    expect(useDroneStore.getState().launchPlan?.assignments).toEqual(defaultLaunchAssignments)
  })

  it('ignores stale local waypoint drafts when loading an encrypted custom mission', () => {
    const option = registerCustomScenario(makeCustomScenario())
    const scenarioVariant = useDroneStore.getState().scenarioVariant
    const staleRoute: Waypoint[] = [{
      id: 'stale-draft',
      label: 'Stale local draft',
      position: { lat: 37.79, lng: -122.41 },
      altitudeFt: 220,
    }]
    expect(saveDroneWaypointRoute({
      scenarioId: CUSTOM_ID,
      scenarioVariant,
      droneId: 'uav-01',
      route: staleRoute,
      source: 'manual_save',
    }).ok).toBe(true)

    useDroneStore.setState({
      scenario: option.config,
      launchPlan: null,
      drones: [],
      weatherState: getDefaultWeatherState(option.config.seed),
    })
    initFleet()

    expect(useDroneStore.getState().droneWaypoints['uav-01']).toEqual(authoredRoutes['uav-01'])
  })
})

describe('validateAltitude', () => {
  it('enforces the 20–400 ft operator band (inclusive)', () => {
    expect(validateAltitude(19.9)).toBe(false)
    expect(validateAltitude(20)).toBe(true)
    expect(validateAltitude(400)).toBe(true)
    expect(validateAltitude(400.1)).toBe(false)
  })
})
