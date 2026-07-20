/**
 * Production-loop integration test.
 *
 * Unlike determinism.spec.ts (which exercises the pure kernel functions), this drives the REAL
 * SimulationLoop tick() — via startSimLoop() + fake timers — including the safety passes, comms
 * model, thermal checks, replay snapshots, and chain-of-custody event emission. It exists to
 * pin two invariants the audit found broken or untested:
 *
 *   1. Evidence integrity: every event emitted during a live mission chains correctly —
 *      verifyChain() must return true and no two events may claim the same prevHash.
 *      (Regression guard for the async-hash race where all events in one tick captured
 *      the same stale lastHash.)
 *   2. Production determinism: two runs at the same seed and same (mocked) clock produce
 *      identical replay frames.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { useDroneStore } from '@/store/droneStore'
import { startSimLoop, stopSimLoop, endMission, initFleet } from '@/sim/SimulationLoop'
import { verifyChain, getGenesisHash } from '@/utils/chainOfCustody'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import type { FullMissionFrame, MissionEvent } from '@/types'

const scenario = ALL_SCENARIOS.find((s) => s.id === 'demo_basic') ?? ALL_SCENARIOS[0]
const CLOCK_ORIGIN = new Date('2026-01-01T00:00:00Z')
const TICK_MS = 50

interface MissionRunResult {
  events: MissionEvent[]
  frames: FullMissionFrame[]
  finalDrones: ReturnType<typeof useDroneStore.getState>['drones']
}

/** Run the real sim loop for `ticks` ticks from a clean mission start. */
function runMission(ticks: number): MissionRunResult {
  vi.setSystemTime(CLOCK_ORIGIN)
  useDroneStore.setState({
    scenario,
    weatherState: getDefaultWeatherState(scenario.seed),
    launchPlan: null,
  })
  initFleet()

  // Mirror the production start path so lifecycle enters `running` before End Mission.
  useDroneStore.getState().beginLaunchSequence()
  useDroneStore.getState().setRunning(true)
  startSimLoop()
  vi.advanceTimersByTime(ticks * TICK_MS)
  // Post-split, only endMission() finalizes the replay session (stopSimLoop just cancels
  // the driver). End the mission here so replaySession.frames is populated for assertions.
  endMission()

  const final = useDroneStore.getState()
  return {
    events: final.events,
    frames: final.replaySession?.frames ?? [],
    finalDrones: final.drones,
  }
}

describe('SimulationLoop production integration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    stopSimLoop()
    vi.useRealTimers()
  })

  it('emits a hash chain that verifies end-to-end during a live mission', () => {
    const { events } = runMission(1600) // 80 sim-seconds: launch, navigate, waypoints, comms window

    expect(events.length).toBeGreaterThan(5)
    expect(events[0].prevHash).toBe(getGenesisHash())
    expect(verifyChain(events)).toBe(true)
  })

  it('never lets two events claim the same prevHash (the audit race)', () => {
    const { events } = runMission(1600)

    const prevHashes = events.map((e) => e.prevHash)
    expect(new Set(prevHashes).size).toBe(prevHashes.length)

    // And every link points at its actual predecessor.
    for (let i = 1; i < events.length; i++) {
      expect(events[i].prevHash).toBe(events[i - 1].hash)
    }
  })

  it('detects tampering (negative control for verifyChain)', () => {
    const { events } = runMission(600)
    expect(events.length).toBeGreaterThan(2)
    expect(verifyChain(events)).toBe(true)

    const tampered = events.map((e, i) =>
      i === 1 ? { ...e, payload: { ...e.payload, injected: 'tampered' } } : e,
    )
    expect(verifyChain(tampered)).toBe(false)
  })

  it('two production runs at the same seed and clock produce identical replay frames', () => {
    const run1 = runMission(1200)
    const run2 = runMission(1200)

    expect(run1.frames.length).toBeGreaterThan(10)
    expect(run2.frames.length).toBe(run1.frames.length)
    expect(run2.frames).toEqual(run1.frames)
    expect(run2.finalDrones.map((d) => d.position)).toEqual(run1.finalDrones.map((d) => d.position))
    expect(run2.events.map((e) => e.hash)).toEqual(run1.events.map((e) => e.hash))
  })
})
