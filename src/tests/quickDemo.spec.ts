/**
 * One-click quick demo — drives the exact production pipeline (scenario load,
 * fleet init, preflight evidence, auto launch-bay plan, coordinated launch)
 * end-to-end through the real sim loop.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useDroneStore } from '@/store/droneStore'
import { stopSimLoop } from '@/sim/SimulationLoop'
import { runQuickDemo } from '@/sim/demo/quickDemo'

describe('runQuickDemo', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    useDroneStore.setState({
      scenario: null,
      launchPlan: null,
      drones: [],
      events: [],
      ui: { ...useDroneStore.getState().ui, isRunning: false, showPreflight: false, showLaunchBay: false },
    })
  })

  // Mandatory: runQuickDemo starts the node setInterval sim driver — leaking it
  // bleeds ticks into every other suite.
  afterEach(() => {
    stopSimLoop()
    vi.useRealTimers()
  })

  it('runs the full pipeline: scenario, fleet, evidence, plan, launch', () => {
    const result = runQuickDemo()
    expect(result.ok).toBe(true)

    const s = useDroneStore.getState()
    expect(s.scenario?.id).toBe('demo_basic')
    expect(s.drones.length).toBeGreaterThan(0)
    expect(s.launchPlan?.readyToLaunch).toBe(true)
    expect(s.ui.isRunning).toBe(true)
    // Coordinated launch: everyone enters the preflight hold, no modals opened.
    expect(s.drones.every((d) => d.missionState === 'preflight')).toBe(true)
    expect(s.ui.showPreflight).toBe(false)
    expect(s.ui.showLaunchBay).toBe(false)
    // Evidence chain carries both the fleet init and the preflight completion.
    expect(s.events.some((e) => e.eventType === 'mission_start')).toBe(true)
    expect(s.events.some((e) => e.eventType === 'preflight_complete')).toBe(true)
  })

  it('drones actually lift off on the staggered schedule', () => {
    expect(runQuickDemo().ok).toBe(true)

    // Advance the real production loop (setInterval fallback under fake timers).
    vi.advanceTimersByTime(12_000)

    const drones = useDroneStore.getState().drones
    const launched = drones.filter((d) => d.launchTimeSec !== undefined)
    expect(launched.length).toBeGreaterThan(0)
    // Staggered, not simultaneous.
    const slots = drones.map((d) => d.scheduledLaunchSec ?? 0)
    expect(new Set(slots).size).toBeGreaterThan(1)
    expect(useDroneStore.getState().tick).toBeGreaterThan(0)
  })

  it('rejects an unknown scenario id without touching the store', () => {
    const result = runQuickDemo('does-not-exist')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('does-not-exist')
    expect(useDroneStore.getState().scenario).toBeNull()
    expect(useDroneStore.getState().ui.isRunning).toBe(false)
  })
})
