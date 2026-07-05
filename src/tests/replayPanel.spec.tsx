// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReplayPanel } from '@/components/ReplayPanel'
import { useDroneStore } from '@/store/droneStore'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import type { DroneState, FullMissionFrame, MissionReplaySession } from '@/types'

const scenario = ALL_SCENARIOS[0]

function makeDrone(id: string, missionState: DroneState['missionState']): DroneState {
  return {
    id, label: id.toUpperCase(), color: '#00d4ff', position: { ...scenario.startPosition },
    altitudeFt: 100, headingDeg: 0, speedMs: 5, batteryPct: 70, signalDbm: -60,
    missionState, currentWaypointIndex: 0, conflictFlag: false, geofenceBreachFlag: false,
    bvlosFlag: false, sortieCount: 0,
  }
}

function makeFrame(tick: number, missionState: DroneState['missionState']): FullMissionFrame {
  return {
    tick, elapsedSec: tick * 0.05, drones: [makeDrone('uav-01', missionState)],
    thermalContacts: [], groundUnits: [], recoveryTeams: [],
    weatherState: getDefaultWeatherState(scenario.seed), activeEventIds: [],
  }
}

function makeSession(): MissionReplaySession {
  const frames = [makeFrame(0, 'launch'), makeFrame(100, 'navigate'), makeFrame(200, 'landed')]
  return {
    scenarioId: scenario.id,
    scenarioVariant: { seed: 1, timeOfDay: 'day', season: 'spring', weatherSeverity: 0, commsDegradation: 0, thermalDensity: 1, batteryPressure: 0, terrainDifficulty: 0 },
    launchPlan: null,
    frames,
    events: [],
    metrics: { totalFlightDistanceM: 0, waypointsReached: 0, conflictsDetected: 0, thermalContacts: 0, geofenceBreaches: 0, rtbTriggers: 0, recoveryDispatches: 0, groundUnitDispatch: 0 },
    completedAt: Date.now(),
    finalDrones: [makeDrone('uav-01', 'landed')],
    finalThermalContacts: [],
    finalGroundUnits: [],
    finalRecoveryTeams: [],
    finalWeatherState: getDefaultWeatherState(scenario.seed),
  }
}

describe('<ReplayPanel />', () => {
  beforeEach(() => {
    useDroneStore.setState({
      scenario,
      replaySession: null,
      replayIndex: 0,
      replayFrames: [],
      ui: { ...useDroneStore.getState().ui, isRunning: false, isReplayMode: false },
    })
  })

  afterEach(() => cleanup())

  it('renders nothing when there is no finalized replay session', () => {
    const { container } = render(<ReplayPanel />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing while the mission is still running, even with frames buffered', () => {
    useDroneStore.setState({ replaySession: makeSession(), ui: { ...useDroneStore.getState().ui, isRunning: true } })
    const { container } = render(<ReplayPanel />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows REPLAY AVAILABLE once the mission has stopped with frames recorded', () => {
    useDroneStore.setState({ replaySession: makeSession() })
    render(<ReplayPanel />)
    expect(screen.getByText('▶ REPLAY AVAILABLE')).toBeInTheDocument()
  })

  it('ENTER REPLAY switches into scrub mode with transport controls', async () => {
    useDroneStore.setState({ replaySession: makeSession() })
    const user = userEvent.setup()
    render(<ReplayPanel />)
    await user.click(screen.getByRole('button', { name: 'ENTER REPLAY' }))
    expect(useDroneStore.getState().ui.isReplayMode).toBe(true)
    expect(screen.getByRole('slider')).toBeInTheDocument()
  })

  it('scrubbing the slider restores that frame\'s drone state', async () => {
    useDroneStore.setState({ replaySession: makeSession() })
    const user = userEvent.setup()
    render(<ReplayPanel />)
    await user.click(screen.getByRole('button', { name: 'ENTER REPLAY' }))

    // jsdom doesn't implement setSelectionRange for type="range" inputs, so keyboard-driven
    // seeking isn't simulable here — fire the change event the real slider dispatches instead.
    const slider = screen.getByRole('slider') as HTMLInputElement
    fireEvent.change(slider, { target: { value: '2' } }) // last frame index
    expect(useDroneStore.getState().drones[0].missionState).toBe('landed')
  })
})
