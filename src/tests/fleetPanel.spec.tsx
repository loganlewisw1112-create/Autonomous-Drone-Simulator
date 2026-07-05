// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FleetPanel } from '@/components/FleetPanel'
import { useDroneStore } from '@/store/droneStore'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import type { DroneState } from '@/types'

const scenario = ALL_SCENARIOS[0]

function makeDrone(id: string, patch: Partial<DroneState> = {}): DroneState {
  return {
    id, label: id.toUpperCase(), color: '#00d4ff', position: { ...scenario.startPosition },
    altitudeFt: 100, headingDeg: 0, speedMs: 5, batteryPct: 80, signalDbm: -60,
    missionState: 'navigate', currentWaypointIndex: 0, conflictFlag: false,
    geofenceBreachFlag: false, bvlosFlag: false, sortieCount: 0,
    ...patch,
  }
}

describe('<FleetPanel />', () => {
  beforeEach(() => {
    useDroneStore.setState({
      scenario,
      drones: [],
      recoveryTeams: [],
      ui: { ...useDroneStore.getState().ui, selectedDroneId: null },
    })
  })

  afterEach(() => cleanup())

  it('prompts to load a scenario when the fleet is empty', () => {
    render(<FleetPanel />)
    expect(screen.getByText('Load a scenario to see drones')).toBeInTheDocument()
  })

  it('renders one card per drone with label and mission state', () => {
    useDroneStore.setState({ drones: [makeDrone('uav-01'), makeDrone('uav-02', { missionState: 'hover' })] })
    render(<FleetPanel />)
    expect(screen.getByText('UAV-01')).toBeInTheDocument()
    expect(screen.getByText('UAV-02')).toBeInTheDocument()
    expect(screen.getByText('hover')).toBeInTheDocument()
  })

  it('flags a low-battery drone with a LOW BAT warning badge', () => {
    useDroneStore.setState({ drones: [makeDrone('uav-01', { batteryPct: 12 })] })
    render(<FleetPanel />)
    expect(screen.getByText('LOW BAT')).toBeInTheDocument()
  })

  it('flags a geofence breach with a GEO-BREACH warning badge', () => {
    useDroneStore.setState({ drones: [makeDrone('uav-01', { geofenceBreachFlag: true })] })
    render(<FleetPanel />)
    expect(screen.getByText('GEO-BREACH')).toBeInTheDocument()
  })

  it('shows no warning badges for a nominal drone', () => {
    useDroneStore.setState({ drones: [makeDrone('uav-01')] })
    render(<FleetPanel />)
    expect(screen.queryByText('LOW BAT')).not.toBeInTheDocument()
    expect(screen.queryByText('CONFLICT')).not.toBeInTheDocument()
  })

  it('selecting a drone card updates ui.selectedDroneId', async () => {
    useDroneStore.setState({ drones: [makeDrone('uav-01')] })
    const user = userEvent.setup()
    render(<FleetPanel />)
    await user.click(screen.getByText('UAV-01'))
    expect(useDroneStore.getState().ui.selectedDroneId).toBe('uav-01')
  })
})
