/**
 * Coordinated "hive-mind" launch — end-to-end through the real production tick.
 * Drones must lift off on a STAGGERED schedule from FANNED bays, not all at once
 * from stacked spawn points.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { useDroneStore } from '@/store/droneStore'
import { tick, stopSimLoop, initFleet } from '@/sim/SimulationLoop'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import { haversineDistanceM } from '@/utils/geometry'

const scenario = ALL_SCENARIOS.find((s) => s.id === 'extreme_fema_fort_myers') ?? ALL_SCENARIOS[0]

describe('coordinated staggered launch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    useDroneStore.setState({
      scenario,
      weatherState: getDefaultWeatherState(scenario.seed),
      launchPlan: null,
    })
    initFleet()
  })

  afterEach(() => {
    stopSimLoop()
    vi.useRealTimers()
  })

  it('assigns fanned bays (no two drones share a pad) and staggered slots', () => {
    const drones = useDroneStore.getState().drones
    // Every drone has a takeoff slot; not all identical.
    const slots = drones.map((d) => d.scheduledLaunchSec ?? 0)
    expect(new Set(slots).size).toBeGreaterThan(1)
    expect(Math.max(...slots)).toBeGreaterThan(0)

    // Spawn bays are spread apart, not stacked ~5.5 m.
    for (let i = 0; i < drones.length; i++) {
      for (let j = i + 1; j < drones.length; j++) {
        const d = haversineDistanceM(drones[i].position, drones[j].position)
        expect(d, `${drones[i].id}/${drones[j].id}`).toBeGreaterThan(15)
      }
    }
  })

  it('drones lift off at different sim-times, not all on the same tick', () => {
    useDroneStore.getState().beginLaunchSequence()
    useDroneStore.getState().setRunning(true)

    // All parked drones should now be holding in preflight, none airborne yet.
    expect(useDroneStore.getState().drones.every((d) => d.missionState === 'preflight')).toBe(true)

    // Run ~12 s of sim time — enough for the whole staggered window to complete.
    for (let i = 0; i < 240; i++) tick()

    const launchTimes = useDroneStore.getState().drones.map((d) => d.launchTimeSec ?? -1)
    expect(launchTimes.every((t) => t >= 0)).toBe(true)         // all eventually launched
    expect(new Set(launchTimes).size).toBeGreaterThan(1)        // but not simultaneously
    expect(Math.max(...launchTimes) - Math.min(...launchTimes)).toBeGreaterThan(1) // real spread (s)
  })

  it('is deterministic — same scenario yields identical slots across re-inits', () => {
    const first = useDroneStore.getState().drones.map((d) => d.scheduledLaunchSec ?? 0)
    initFleet()
    const second = useDroneStore.getState().drones.map((d) => d.scheduledLaunchSec ?? 0)
    expect(second).toEqual(first)
  })
})
