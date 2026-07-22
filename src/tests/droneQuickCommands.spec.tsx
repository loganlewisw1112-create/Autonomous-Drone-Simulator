// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DroneQuickCommands } from '@/components/mobile/DroneQuickCommands'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { useDroneStore } from '@/store/droneStore'
import type { DroneState } from '@/types'

const scenario = ALL_SCENARIOS[0]

function makeDrone(): DroneState {
  return {
    id: 'uav-01',
    label: 'UAV-01',
    color: '#00d4ff',
    position: { ...scenario.startPosition },
    altitudeFt: 120,
    headingDeg: 90,
    speedMs: 8,
    batteryPct: 80,
    signalDbm: -60,
    missionState: 'navigate',
    currentWaypointIndex: 0,
    conflictFlag: false,
    geofenceBreachFlag: false,
    bvlosFlag: false,
    sortieCount: 0,
  }
}

describe('<DroneQuickCommands /> Route Advisor copy', () => {
  const acceptRouteSuggestion = vi.fn(() => true)

  beforeEach(() => {
    acceptRouteSuggestion.mockClear()
    useDroneStore.setState({
      scenario,
      drones: [makeDrone()],
      elapsedSec: 0,
      routeSuggestions: [],
      routeCommandError: null,
      routeCommandWarning: null,
      acceptRouteSuggestion,
      ui: { ...useDroneStore.getState().ui, selectedDroneId: 'uav-01' },
    })
  })

  afterEach(() => cleanup())

  it('labels suggestions as Route Advisor decision support', () => {
    render(<DroneQuickCommands />)

    expect(screen.getByText('ROUTE ADVISOR · SUGGESTED MOVES')).toBeInTheDocument()
    expect(screen.getByText(/request Route Advisor decision support/i)).toBeInTheDocument()
    expect(screen.queryByText(/AI-proposed|AI route suggestions/i)).not.toBeInTheDocument()
  })

  it('keeps legacy AI claims out of owned component source and comments', () => {
    const sources = [
      readFileSync(join(process.cwd(), 'src/components/mobile/DroneQuickCommands.tsx'), 'utf8'),
      readFileSync(join(process.cwd(), 'src/components/OperatorCommandPanel.tsx'), 'utf8'),
    ]

    for (const source of sources) {
      expect(source).not.toMatch(/AI-proposed|AI route suggestions/i)
    }
  })

  it('offers explicit replace and divert-resume application modes', () => {
    useDroneStore.setState({
      routeSuggestions: [{
        id: 'suggestion-1',
        droneId: 'uav-01',
        source: 'route_advisor',
        priority: 'urgent',
        title: 'Divert to contact',
        rationale: 'Reach the contact, then return to the current mission route.',
        riskLevel: 'advisory',
        route: [{ id: 'divert-1', position: { ...scenario.startPosition }, altitudeFt: 150 }],
        requiresApproval: true,
        createdAtSec: 0,
      }],
    })
    render(<DroneQuickCommands />)

    fireEvent.click(screen.getByRole('button', { name: 'REPLACE' }))
    expect(acceptRouteSuggestion).toHaveBeenLastCalledWith('suggestion-1', 'replace')

    fireEvent.click(screen.getByRole('button', { name: 'DIVERT + RESUME' }))
    expect(acceptRouteSuggestion).toHaveBeenLastCalledWith('suggestion-1', 'divert_resume')
  })

  it('surfaces route application warnings to the mobile operator', () => {
    useDroneStore.setState({
      routeCommandWarning: {
        code: 'route_capped',
        limit: 20,
        droppedWaypointCount: 2,
        message: 'Divert route capped; 2 resume waypoints dropped.',
      },
    })

    render(<DroneQuickCommands />)

    expect(screen.getByText('Divert route capped; 2 resume waypoints dropped.')).toBeInTheDocument()
  })
})
