/**
 * Proves the per-platform physics are actually wired into the production loop.
 *
 * platformPhysics.spec pins stepDrone's clamps in isolation; this drives the real
 * SimulationLoop so a regression that drops the `platformForDrone(...)` argument at
 * the tick() call site (silently reverting every drone to LEGACY_PLATFORM) fails
 * here rather than passing unnoticed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { useDroneStore } from '@/store/droneStore'
import { startSimLoop, stopSimLoop, endMission, initFleet } from '@/sim/SimulationLoop'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import { PLATFORM_CATALOG, LEGACY_PLATFORM } from '@/sim/drone/platformCatalog'
import type { ScenarioConfig } from '@/types'

const TICK_MS = 50
const CLOCK_ORIGIN = new Date('2026-01-01T00:00:00Z')

/** Runs `scenario` for `ticks` and returns the peak speed observed per drone. */
function peakSpeeds(scenario: ScenarioConfig, ticks: number): Record<string, number> {
  vi.setSystemTime(CLOCK_ORIGIN)
  useDroneStore.setState({
    // This test isolates propulsion. WP-5 thermal contacts now trigger a real
    // inspect hold at sourced ranges, which is intentionally outside that scope.
    scenario: { ...scenario, heatSources: [] },
    weatherState: getDefaultWeatherState(scenario.seed),
    launchPlan: null,
  })
  initFleet()
  useDroneStore.getState().beginLaunchSequence()
  useDroneStore.getState().setRunning(true)
  startSimLoop()

  const peaks: Record<string, number> = {}
  for (let i = 0; i < ticks; i++) {
    vi.advanceTimersByTime(TICK_MS)
    for (const drone of useDroneStore.getState().drones) {
      peaks[drone.id] = Math.max(peaks[drone.id] ?? 0, drone.speedMs)
    }
  }
  endMission()
  return peaks
}

const byId = (id: string) => ALL_SCENARIOS.find((s) => s.id === id)!

describe('per-platform physics reach the production loop', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { stopSimLoop(); vi.useRealTimers() })

  it('stamps the scenario platform onto each drone at fleet init', () => {
    const scenario = byId('extreme_fbi_hrt_compound')
    useDroneStore.setState({ scenario, weatherState: getDefaultWeatherState(scenario.seed), launchPlan: null })
    initFleet()
    const drones = useDroneStore.getState().drones
    expect(drones.find((d) => d.id === 'uav-01')?.platformId).toBe('brinc_lemur_2')
    expect(drones.find((d) => d.id === 'uav-03')?.platformId).toBe('skydio_x10')
  })

  it('lets an X10 fleet cruise faster than the legacy airframe cap', () => {
    // demo_basic is a uniform Skydio X10 fleet (20 m/s) — it must exceed the old
    // global 12 m/s ceiling, which is the whole point of per-platform physics.
    const peaks = peakSpeeds(byId('demo_basic'), 1600)
    const fastest = Math.max(...Object.values(peaks))
    expect(fastest).toBeGreaterThan(LEGACY_PLATFORM.maxSpeedMs)
    expect(fastest).toBeLessThanOrEqual(PLATFORM_CATALOG.skydio_x10.maxSpeedMs + 0.001)
  })

  it('holds a Teal 2 fire fleet below its slower 10 m/s doctrinal cap', () => {
    const scenario = byId('demo_wildfire')
    const peaks = peakSpeeds(scenario, 1600)
    for (const [droneId, peak] of Object.entries(peaks)) {
      const platformId = scenario.dronePlatforms![droneId]
      expect(peak, `${droneId} (${platformId})`).toBeLessThanOrEqual(
        PLATFORM_CATALOG[platformId].maxSpeedMs + 0.001,
      )
    }
    // uav-01/02 are Teal 2s; they must stay under the X10 cap they'd have hit
    // if the platform argument were dropped.
    expect(peaks['uav-01']).toBeLessThanOrEqual(PLATFORM_CATALOG.teal_2.maxSpeedMs + 0.001)
  })

  it('differentiates platforms within one mixed fleet', () => {
    const scenario = byId('demo_wildfire') // teal_2 primary, skydio_x10 on slot 3
    const peaks = peakSpeeds(scenario, 1600)
    expect(scenario.dronePlatforms!['uav-03']).toBe('skydio_x10')
    // The X10 slot should out-run the Teal 2 slots in the same mission.
    expect(peaks['uav-03']).toBeGreaterThan(PLATFORM_CATALOG.teal_2.maxSpeedMs)
  })
})
