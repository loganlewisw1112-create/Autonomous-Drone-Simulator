// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OperatorCommandPanel } from '@/components/OperatorCommandPanel'
import { useDroneStore } from '@/store/droneStore'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import type { DroneState } from '@/types'

const scenario = ALL_SCENARIOS[0]

function makeDrone(id: string, patch: Partial<DroneState> = {}): DroneState {
  return {
    id,
    label: id.toUpperCase(),
    color: '#00d4ff',
    position: { ...scenario.startPosition },
    altitudeFt: 120,
    headingDeg: 90,
    speedMs: 8,
    batteryPct: 80,
    signalDbm: -60,
    missionState: 'navigate',
    currentWaypointIndex: 1,
    conflictFlag: false,
    geofenceBreachFlag: false,
    bvlosFlag: false,
    sortieCount: 0,
    ...patch,
  }
}

describe('<OperatorCommandPanel />', () => {
  beforeEach(() => {
    useDroneStore.setState({
      scenario,
      drones: [makeDrone('uav-01')],
      droneWaypoints: {},
      routeSuggestions: [],
      routeCommandError: null,
      routeSaveStatuses: {},
      ui: { ...useDroneStore.getState().ui, selectedDroneId: null },
    })
  })

  afterEach(() => cleanup())

  it('renders nothing without an active scenario', () => {
    useDroneStore.setState({ scenario: null })
    const { container } = render(<OperatorCommandPanel />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the OPS HUB for the selected (or first) drone', () => {
    render(<OperatorCommandPanel />)
    expect(screen.getByTestId('ops-hub')).toBeInTheDocument()
    expect(screen.getByText('UAV-01')).toBeInTheDocument()
  })

  it('HOVER puts the drone into hover state and logs an operator command', async () => {
    const user = userEvent.setup()
    render(<OperatorCommandPanel />)
    await user.click(screen.getByRole('button', { name: 'HOVER' }))

    const state = useDroneStore.getState()
    expect(state.drones[0].missionState).toBe('hover')
    expect(state.events.some((e) => e.eventType === 'operator_command' && e.payload.command === 'hover')).toBe(true)
  })

  it('RTB sends the drone to return_to_base', async () => {
    const user = userEvent.setup()
    render(<OperatorCommandPanel />)
    await user.click(screen.getByRole('button', { name: 'RTB' }))
    expect(useDroneStore.getState().drones[0].missionState).toBe('return_to_base')
  })

  it('surfaces a route command error banner when the store reports one', () => {
    useDroneStore.setState({ routeCommandError: 'UAV-01 route rejected: Test Zone' })
    render(<OperatorCommandPanel />)
    expect(screen.getByText('UAV-01 route rejected: Test Zone')).toBeInTheDocument()
  })

  it('shows a route diff on pending suggestions — never a silent swap (M2)', () => {
    // Generate real suggestions through the store action so the card renders
    // exactly what production produces.
    useDroneStore.getState().generateRouteSuggestionsForDrone('uav-01')
    expect(useDroneStore.getState().routeSuggestions.length).toBeGreaterThan(0)

    render(<OperatorCommandPanel />)
    const diff = screen.getAllByTestId('suggestion-route-diff')[0]
    // Old side: no saved route in this fixture; new side: waypoint count + distance.
    expect(diff.textContent).toContain('no saved route')
    expect(diff.textContent).toMatch(/\+ \d+ wp · \d+(\.\d+)? km/)
  })
})
