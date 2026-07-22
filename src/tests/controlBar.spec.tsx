// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ControlBar } from '@/components/ControlBar'
import { useDroneStore } from '@/store/droneStore'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import type { LaunchBayPlan } from '@/types'

const scenario = ALL_SCENARIOS[0]

function readyPlan(): LaunchBayPlan {
  return { assignments: {}, bayStatuses: [], readyToLaunch: true, blockers: [] }
}

describe('<ControlBar />', () => {
  beforeEach(() => {
    useDroneStore.setState({
      scenario,
      drones: [],
      weatherState: getDefaultWeatherState(scenario.seed),
      launchPlan: null,
      lastRouteChange: null,
      latestFleetRetaskResult: null,
      fleetRetaskUndo: null,
      operatorRole: 'pic',
      ui: { ...useDroneStore.getState().ui, isRunning: false },
    })
  })

  afterEach(() => cleanup())

  it('disables START when no launch plan has been confirmed', () => {
    render(<ControlBar />)
    expect(screen.getByRole('button', { name: '▶ START' })).toBeDisabled()
  })

  it('enables START once the launch plan is ready and role is PIC', () => {
    useDroneStore.setState({ launchPlan: readyPlan(), operatorRole: 'pic' })
    render(<ControlBar />)
    expect(screen.getByRole('button', { name: '▶ START' })).not.toBeDisabled()
  })

  it('keeps START disabled for an Observer even with a ready launch plan', () => {
    useDroneStore.setState({ launchPlan: readyPlan(), operatorRole: 'observer' })
    render(<ControlBar />)
    expect(screen.getByRole('button', { name: '▶ START' })).toBeDisabled()
  })

  it('switching role to OBS updates operatorRole in the store', async () => {
    const user = userEvent.setup()
    render(<ControlBar />)
    await user.click(screen.getByRole('button', { name: 'OBS' }))
    expect(useDroneStore.getState().operatorRole).toBe('observer')
  })

  it('shows the BAY PLAN REQUIRED hint before a plan is confirmed', () => {
    render(<ControlBar />)
    expect(screen.getByText('⚠ BAY PLAN REQUIRED')).toBeInTheDocument()
  })

  it('surfaces objective-based mission progress', () => {
    render(<ControlBar />)
    expect(screen.getByTestId('mission-progress')).toHaveTextContent('TASK 0%')
  })

  it('exposes fleet retask to the PIC and blocks observers', () => {
    render(<ControlBar />)
    expect(screen.getByRole('button', { name: '⟳ RETASK FLEET' })).toBeDisabled()

    cleanup()
    useDroneStore.setState({
      drones: [{
        id: 'uav-01', label: 'UAV-01', color: '#00d4ff', position: scenario.startPosition,
        altitudeFt: 120, headingDeg: 0, speedMs: 8, batteryPct: 80, signalDbm: -60,
        missionState: 'navigate', currentWaypointIndex: 0, conflictFlag: false,
        geofenceBreachFlag: false, bvlosFlag: false, sortieCount: 0,
      }],
      operatorRole: 'pic',
    })
    render(<ControlBar />)
    expect(screen.getByRole('button', { name: '⟳ RETASK FLEET' })).toBeEnabled()

    cleanup()
    useDroneStore.setState({ operatorRole: 'observer' })
    render(<ControlBar />)
    expect(screen.getByRole('button', { name: '⟳ RETASK FLEET' })).toBeDisabled()
  })

  it('shows one-click route undo only when a route change is available', () => {
    render(<ControlBar />)
    expect(screen.queryByRole('button', { name: '↶ UNDO ROUTE' })).not.toBeInTheDocument()

    cleanup()
    useDroneStore.setState({
      lastRouteChange: { scenarioId: scenario.id, changedAt: 1, previous: {} },
    })
    render(<ControlBar />)
    expect(screen.getByRole('button', { name: '↶ UNDO ROUTE' })).toBeEnabled()
  })
})
