// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
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
  beforeEach(() => {
    useDroneStore.setState({
      scenario,
      drones: [makeDrone()],
      elapsedSec: 0,
      routeSuggestions: [],
      routeCommandError: null,
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
})
