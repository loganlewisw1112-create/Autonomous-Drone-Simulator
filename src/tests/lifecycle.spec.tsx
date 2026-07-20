// @vitest-environment jsdom
/**
 * Mission-lifecycle FSM: the record-writing invariant.
 *
 * The bug this pins: stopSimLoop() used to finalize the replay session on EVERY stop path
 * (RTB-ALL, pause, scenario swap, demo reset, quickDemo start), and runRecorder writes a run
 * record whenever replaySession transitions to a new non-null session — so every one of those
 * paths persisted a spurious "ghost run".
 *
 * Post-split, only endMission() finalizes. A run record is written iff replaySession becomes a
 * NEW non-null session, so we subscribe to exactly that transition (the same signal runRecorder
 * uses) and count it — no IndexedDB/auth machinery required.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useDroneStore } from '@/store/droneStore'
import { useMissionControls } from '@/hooks/useMissionControls'
import { tick, stopTicking, endMission, initFleet } from '@/sim/SimulationLoop'
import { runQuickDemo } from '@/sim/demo/quickDemo'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import type { DroneState } from '@/types'

const scenario = ALL_SCENARIOS.find((s) => s.id === 'demo_basic') ?? ALL_SCENARIOS[0]

function makeDrone(id: string, missionState: DroneState['missionState']): DroneState {
  return {
    id,
    label: id.toUpperCase(),
    color: '#00d4ff',
    position: { lat: 37.775, lng: -122.49 },
    altitudeFt: 200,
    headingDeg: 45,
    speedMs: 8,
    batteryPct: 80,
    signalDbm: -60,
    missionState,
    currentWaypointIndex: 1,
    conflictFlag: false,
    geofenceBreachFlag: false,
    bvlosFlag: false,
    sortieCount: 0,
    launchTimeSec: 1, // treated as "has flown" for terminal detection
  }
}

// Minimal harness exposing the real hook handlers so RTB/pause/resume/demo-reset are exercised
// through production code rather than a re-implementation.
function Harness() {
  const c = useMissionControls()
  return (
    <div>
      <button onClick={c.handleAbort}>rtb</button>
      <button onClick={c.handlePause}>pause</button>
      <button onClick={c.handleResume}>resume</button>
      <button onClick={c.handleEndMission}>end</button>
      <button onClick={c.handleDemoReset}>reset</button>
      <button onClick={() => c.handleScenarioChange('demo_suspect_search')}>browse</button>
    </div>
  )
}

let finalizeCount = 0
let unsub: (() => void) | undefined

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  finalizeCount = 0
  useDroneStore.setState({
    scenario,
    drones: [],
    weatherState: getDefaultWeatherState(scenario.seed),
    launchPlan: null,
    operatorRole: 'pic',
    lifecycle: 'idle',
    replaySession: null,
    ui: { ...useDroneStore.getState().ui, isRunning: false, simSpeed: 1 },
  })
  // Baseline is the null set above; subscribeWithSelector only fires on subsequent changes.
  unsub = useDroneStore.subscribe(
    (s) => s.replaySession,
    (session, prev) => { if (session && session !== prev) finalizeCount++ },
  )
})

afterEach(() => {
  unsub?.()
  stopTicking()
  cleanup()
  vi.useRealTimers()
})

describe('mission lifecycle — run-record invariants', () => {
  it('RTB-ALL reroutes the fleet, writes no run record, and keeps the mission running', () => {
    useDroneStore.setState({ drones: [makeDrone('uav-01', 'navigate')] })
    useDroneStore.getState().setRunning(true)
    useDroneStore.getState().setLifecycle('running')

    render(<Harness />)
    fireEvent.click(screen.getByText('rtb'))

    expect(finalizeCount).toBe(0)
    expect(useDroneStore.getState().replaySession).toBeNull()
    expect(useDroneStore.getState().ui.isRunning).toBe(true)      // loop still running
    expect(useDroneStore.getState().lifecycle).toBe('running')
    expect(useDroneStore.getState().drones[0].missionState).toBe('return_to_base')
  })

  it('repeated pause/resume never writes a run record', () => {
    useDroneStore.setState({ drones: [makeDrone('uav-01', 'navigate')] })
    useDroneStore.getState().setRunning(true)
    useDroneStore.getState().setLifecycle('running')

    render(<Harness />)
    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByText('pause'))
      expect(useDroneStore.getState().lifecycle).toBe('paused')
      expect(useDroneStore.getState().ui.isRunning).toBe(false)
      fireEvent.click(screen.getByText('resume'))
      expect(useDroneStore.getState().lifecycle).toBe('running')
      expect(useDroneStore.getState().ui.isRunning).toBe(true)
    }

    expect(finalizeCount).toBe(0)
    expect(useDroneStore.getState().replaySession).toBeNull()
  })

  it('demo reset writes no run record', () => {
    useDroneStore.setState({ drones: [makeDrone('uav-01', 'navigate')] })
    useDroneStore.getState().setRunning(true)
    useDroneStore.getState().setLifecycle('running')

    render(<Harness />)
    fireEvent.click(screen.getByText('reset'))

    expect(finalizeCount).toBe(0)
    expect(useDroneStore.getState().replaySession).toBeNull()
  })

  it('scenario browsing writes no run record and enters preflight', () => {
    useDroneStore.setState({ drones: [makeDrone('uav-01', 'idle')] })
    useDroneStore.getState().setRunning(false)
    useDroneStore.getState().setLifecycle('idle')

    render(<Harness />)
    fireEvent.click(screen.getByText('browse'))

    expect(finalizeCount).toBe(0)
    expect(useDroneStore.getState().replaySession).toBeNull()
    expect(useDroneStore.getState().lifecycle).toBe('preflight')
    expect(useDroneStore.getState().ui.isRunning).toBe(false)
  })

  it.each(['running', 'paused'] as const)('blocks scenario replacement while %s', (lifecycle) => {
    const activeDrone = makeDrone('uav-active', 'navigate')
    useDroneStore.setState({ drones: [activeDrone] })
    useDroneStore.getState().setRunning(lifecycle === 'running')
    useDroneStore.getState().setLifecycle(lifecycle)
    const scenarioBefore = useDroneStore.getState().scenario

    render(<Harness />)
    fireEvent.click(screen.getByText('browse'))

    expect(finalizeCount).toBe(0)
    expect(useDroneStore.getState().scenario).toBe(scenarioBefore)
    expect(useDroneStore.getState().drones).toEqual([activeDrone])
    expect(useDroneStore.getState().lifecycle).toBe(lifecycle)
    expect(useDroneStore.getState().ui.isRunning).toBe(lifecycle === 'running')
  })

  it('quickDemo start writes no run record', () => {
    const result = runQuickDemo('demo_basic')
    expect(result.ok).toBe(true)

    expect(finalizeCount).toBe(0)
    expect(useDroneStore.getState().replaySession).toBeNull()
    expect(useDroneStore.getState().lifecycle).toBe('running')
  })

  it('terminal all-landed auto-completes and finalizes exactly one run record', () => {
    initFleet()
    // Force a genuinely-completed posture: every drone has flown and is now landed.
    const landed = useDroneStore.getState().drones.map((d) => ({
      ...d, missionState: 'landed' as const, launchTimeSec: 1,
    }))
    useDroneStore.setState({ drones: landed })
    expect(landed.length).toBeGreaterThan(0)
    useDroneStore.getState().setRunning(true)
    useDroneStore.getState().setLifecycle('running')

    tick() // terminal auto-complete fires endMission() exactly once

    expect(finalizeCount).toBe(1)
    expect(useDroneStore.getState().lifecycle).toBe('completed')
    expect(useDroneStore.getState().ui.isRunning).toBe(false)
    expect(useDroneStore.getState().replaySession?.completionReason).toBe('all_drones_complete')

    // Ticks after completion are inert — no further records.
    tick()
    tick()
    expect(finalizeCount).toBe(1)
  })

  it('explicit endMission finalizes exactly one record; a second call is a no-op', () => {
    useDroneStore.setState({ drones: [makeDrone('uav-01', 'navigate')] })
    useDroneStore.getState().setRunning(true)
    useDroneStore.getState().setLifecycle('running')

    endMission()
    expect(finalizeCount).toBe(1)
    expect(useDroneStore.getState().lifecycle).toBe('completed')
    expect(useDroneStore.getState().replaySession).not.toBeNull()
    expect(useDroneStore.getState().replaySession?.completionReason).toBe('operator_ended')

    endMission()
    expect(finalizeCount).toBe(1)
  })

  it('endMission is inert before a run has started', () => {
    useDroneStore.getState().setLifecycle('idle')

    endMission()

    expect(finalizeCount).toBe(0)
    expect(useDroneStore.getState().replaySession).toBeNull()
    expect(useDroneStore.getState().lifecycle).toBe('idle')
  })
})
