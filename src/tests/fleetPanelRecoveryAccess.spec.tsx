// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { FleetPanel } from '@/components/FleetPanel'
import { useDroneStore } from '@/store/droneStore'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { createUnroutedRecoveryTeam } from '@/sim/mission/recoveryManager'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import type { DroneState, RecoveryTeamState } from '@/types'

const scenario = ALL_SCENARIOS[0]
const weather = getDefaultWeatherState(1)

function drone(patch: Partial<DroneState> = {}): DroneState {
  return {
    id: 'uav-01', label: 'UAV-01', color: '#00d4ff', position: { ...scenario.startPosition },
    altitudeFt: 0, headingDeg: 0, speedMs: 0, batteryPct: 4, signalDbm: -60,
    missionState: 'recovery_requested', currentWaypointIndex: 0, conflictFlag: false,
    geofenceBreachFlag: false, bvlosFlag: false, sortieCount: 0,
    ...patch,
  }
}

describe('<FleetPanel /> recovery road access notes', () => {
  beforeEach(() => {
    useDroneStore.setState({ scenario, drones: [drone()], recoveryTeams: [], ui: { ...useDroneStore.getState().ui, selectedDroneId: null } })
  })
  afterEach(() => cleanup())

  it('says "no road data" when the scenario has no network', () => {
    const target = { lat: scenario.startPosition.lat + 0.01, lng: scenario.startPosition.lng }
    useDroneStore.setState({ recoveryTeams: [createUnroutedRecoveryTeam('r1', 'uav-01', scenario.startPosition, target, weather, null)] })
    render(<FleetPanel />)
    expect(screen.getByText('Recovery team en route (no road data)')).toBeInTheDocument()
  })

  it('says how far the nearest road is when the walk-in would be too long', () => {
    const target = { lat: scenario.startPosition.lat + 0.01, lng: scenario.startPosition.lng }
    useDroneStore.setState({ recoveryTeams: [createUnroutedRecoveryTeam('r1', 'uav-01', scenario.startPosition, target, weather, 1234.5)] })
    render(<FleetPanel />)
    const note = screen.getByText(/Recovery team en route \(nearest road 1235 m\)/)
    expect(note).toBeInTheDocument()
    // New text is readable: at least 12px.
    expect(parseFloat((note as HTMLElement).style.fontSize)).toBeGreaterThanOrEqual(12)
    expect((note as HTMLElement).style.fontSize).toBe('12px')
  })

  it('shows the no-road note at 12px and wraps rather than truncating it', () => {
    const target = { lat: scenario.startPosition.lat + 0.01, lng: scenario.startPosition.lng }
    useDroneStore.setState({ recoveryTeams: [createUnroutedRecoveryTeam('r1', 'uav-01', scenario.startPosition, target, weather, null)] })
    render(<FleetPanel />)
    const note = screen.getByText('Recovery team en route (no road data)') as HTMLElement
    expect(note.style.fontSize).toBe('12px')
    expect(note.style.textOverflow).not.toBe('ellipsis')
    expect(note.style.whiteSpace).not.toBe('nowrap')
  })

  it('shows the road-routed walk-in note at 12px, wrapped, not the old 8px', () => {
    const accessNote = 'Park at the road access point, 117 m from the aircraft, and walk in to avoid prop-wash damage.'
    const routed: RecoveryTeamState = {
      id: 'r1', droneId: 'uav-01', position: { ...scenario.startPosition },
      targetPosition: { lat: scenario.startPosition.lat + 0.01, lng: scenario.startPosition.lng },
      status: 'enroute', etaSec: 90, routePoints: [], accessNote, routeDistM: 0, accessGapM: 116.6, roadRouted: true,
    }
    useDroneStore.setState({ recoveryTeams: [routed] })
    render(<FleetPanel />)
    const note = screen.getByText(accessNote) as HTMLElement
    expect(note.style.fontSize).toBe('12px')
    expect(note.style.textOverflow).not.toBe('ellipsis')
    expect(note.style.whiteSpace).not.toBe('nowrap')
  })
})
