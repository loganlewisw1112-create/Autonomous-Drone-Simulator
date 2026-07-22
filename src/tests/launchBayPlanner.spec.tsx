// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { LaunchBayPlanner } from '@/components/LaunchBayPlanner'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import { useDroneStore } from '@/store/droneStore'
import type { DroneState, ScenarioConfig, WeatherVariantState } from '@/types'

const base = ALL_SCENARIOS[0]
const origin = { lat: 37.77, lng: -122.42 }

const parkedDrone: DroneState = {
  id: 'uav-01',
  label: 'UAV-01',
  color: '#00d4ff',
  position: origin,
  altitudeFt: 0,
  headingDeg: 0,
  speedMs: 0,
  batteryPct: 100,
  signalDbm: -55,
  missionState: 'idle',
  currentWaypointIndex: 0,
  conflictFlag: false,
  geofenceBreachFlag: false,
  bvlosFlag: false,
  sortieCount: 0,
}

function doctrineScenario(defaultSiteId = 'primary'): ScenarioConfig {
  return {
    ...base,
    id: 'doctrine-ui-test',
    name: 'Doctrine UI Test',
    droneCount: 1,
    startPosition: origin,
    waypoints: [{ id: 'task-1', label: 'Task sector', position: { lat: 37.771, lng: -122.42 }, altitudeFt: 120 }],
    perDroneWaypoints: {
      'uav-01': [{ id: 'task-1', label: 'Task sector', position: { lat: 37.771, lng: -122.42 }, altitudeFt: 120 }],
    },
    geofences: [],
    batteryStartPct: 100,
    batteryDrainRatePerSec: 0.001,
    launchSites: {
      primary: {
        id: 'primary', kind: 'police_rooftop', label: 'Primary Rooftop', agency: 'CITY UAS',
        position: origin, surfaceNote: 'Sheltered command rooftop', capacityDrones: 1, exposure: 'sheltered',
      },
      alternate: {
        id: 'alternate', kind: 'field_icp', label: 'Alternate Field ICP', agency: 'CITY UAS',
        position: { lat: 37.7695, lng: -122.42 }, surfaceNote: 'Open field command pad', capacityDrones: 3, exposure: 'sheltered',
      },
      ridge: {
        id: 'ridge', kind: 'helipad', label: 'Exposed Ridge Pad', agency: 'COUNTY UAS',
        position: { lat: 37.769, lng: -122.42 }, surfaceNote: 'Wind-exposed ridge', capacityDrones: 2, exposure: 'exposed',
      },
    },
    recoverySites: {
      recovery: {
        id: 'recovery', kind: 'field_icp', label: 'Recovery ICP', agency: 'CITY UAS',
        position: { lat: 37.77, lng: -122.419 }, surfaceNote: 'Primary recovery lane', isPrimaryRecovery: true,
        capacityDrones: 2, exposure: 'sheltered',
      },
    },
    defaultLaunchAssignments: { 'uav-01': defaultSiteId },
    defaultRecoveryAssignments: { 'uav-01': 'recovery' },
    droneRouteBriefs: {
      'uav-01': {
        role: 'Overwatch relay',
        launchRationale: 'Primary Rooftop provides elevated relay line of sight.',
        routePattern: 'Direct task route',
        altitudeBand: '120ft AGL',
        standoffOrRelayLogic: 'Maintain relay coverage.',
        recoveryPlan: 'Recover at Recovery ICP.',
      },
    },
  }
}

function loadPlanner(scenario = doctrineScenario()) {
  const weather: WeatherVariantState = {
    ...getDefaultWeatherState(scenario.seed),
    activeHazards: ['canyon_gusts'],
    windKts: 20,
    gustKts: 30,
    ceilingFt: 500,
  }
  useDroneStore.setState({
    scenario,
    weatherState: weather,
    launchPlan: null,
    droneWaypoints: { ...scenario.perDroneWaypoints },
    drones: [{ ...parkedDrone, position: { lat: origin.lat - 0.02, lng: origin.lng } }],
    lifecycle: 'preflight',
    ui: { ...useDroneStore.getState().ui, isRunning: false, showLaunchBay: true },
  })
}

beforeEach(() => loadPlanner())

describe('<LaunchBayPlanner />', () => {
  it('renders briefing metrics plus open, limited, and closed site states', async () => {
    const view = render(<LaunchBayPlanner />)
    const select = await screen.findByLabelText('LAUNCH SITE')

    expect(select).toHaveValue('primary')
    expect(view.container.querySelector('[data-availability="open"]')).toHaveTextContent('Alternate Field ICP')
    expect(view.container.querySelector('[data-availability="limited"]')).toHaveTextContent('Primary Rooftop')
    expect(view.container.querySelector('[data-availability="closed"]')).toHaveTextContent('Exposed Ridge Pad')
    expect(screen.getByText('TO TASK')).toBeInTheDocument()
    expect(screen.getByText('TRANSIT')).toBeInTheDocument()
    expect(screen.getByText('ROUND TRIP')).toBeInTheDocument()
    expect(screen.getByText('RESERVE')).toBeInTheDocument()
    expect(screen.getByText(/Primary Rooftop · .* to task · .* transit · .* reserve margin/i)).toBeInTheDocument()
    expect(screen.getByLabelText('Launch plan coverage')).toHaveTextContent('1/1 AIRCRAFT')
  })

  it('keeps rejected sites visible with exact reasons and disables invalid choices', async () => {
    const user = userEvent.setup()
    render(<LaunchBayPlanner />)
    const summary = await screen.findByText('1 REJECTED SITE — SHOW REASONS')
    await user.click(summary)

    const rejectionList = within(summary.closest('details') as HTMLElement).getByRole('list')
    expect(within(rejectionList).getByText('Exposed Ridge Pad')).toBeInTheDocument()
    expect(screen.getByText('weather exposure exceeds site limits')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Exposed Ridge Pad — REJECTED: weather exposure exceeds site limits/i })).toBeDisabled()
  })

  it('auto-assigns away from a rejected default and confirms the full doctrine plan', async () => {
    const user = userEvent.setup()
    loadPlanner(doctrineScenario('ridge'))
    render(<LaunchBayPlanner />)

    const select = await screen.findByLabelText('LAUNCH SITE')
    expect(select).toHaveValue('ridge')
    expect(screen.getByRole('button', { name: '✓ Confirm Launch Plan' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '⚡ Auto-Assign' }))
    await waitFor(() => expect(select).not.toHaveValue('ridge'))
    const confirm = screen.getByRole('button', { name: '✓ Confirm Launch Plan' })
    expect(confirm).toBeEnabled()
    await user.click(confirm)

    const stored = useDroneStore.getState().launchPlan
    expect(stored?.readyToLaunch).toBe(true)
    expect(stored?.assignments['uav-01']).not.toBe('ridge')
    expect(stored?.assignmentDetails?.['uav-01']?.rationale).toMatch(/to task.*transit.*reserve margin/i)
    expect(useDroneStore.getState().drones[0].position).toEqual(stored?.assignmentDetails?.['uav-01']?.bay)
    expect(useDroneStore.getState().ui.showLaunchBay).toBe(false)
  })
})
