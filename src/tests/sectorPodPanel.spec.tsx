// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Recharts is lazy-loaded by the telemetry tab and irrelevant to the READY tab under test.
vi.mock('@/components/TelemetryCharts', () => ({ TelemetryCharts: () => null }))

import { TelemetryPanel } from '@/components/TelemetryPanel'
import { useDroneStore } from '@/store/droneStore'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import type { DroneState, LatLng, ScenarioConfig } from '@/types'

// REALISM_ROADMAP WP-6 accept criterion: "per-sector and cumulative POD shown in READY".
// The maths is pinned in podReporting.spec.ts; this asserts the operator can actually read it,
// and — the part that matters for a diligence read — that an unsourced platform reads as
// UNSOURCED on the panel rather than as a confident percentage.

const SECTOR: LatLng[] = [
  { lat: 37, lng: -122 },
  { lat: 37.009, lng: -122 },
  { lat: 37.009, lng: -121.9887 },
  { lat: 37, lng: -121.9887 },
]

const TRACK: LatLng[] = [
  { lat: 37.004, lng: -121.999 },
  { lat: 37.004, lng: -121.9897 },
  { lat: 37.005, lng: -121.9897 },
  { lat: 37.005, lng: -121.999 },
]

function scenarioWithSector(platformId: string): ScenarioConfig {
  return {
    ...ALL_SCENARIOS[0],
    id: 'pod-panel-test',
    searchArea: SECTOR,
    dronePlatforms: { 'uav-01': platformId },
  } as ScenarioConfig
}

function drone(): DroneState {
  return {
    id: 'uav-01',
    label: 'UAV-01',
    color: '#00d4ff',
    position: { lat: 37.004, lng: -121.999 },
    altitudeFt: 200,
    headingDeg: 90,
    speedMs: 8,
    batteryPct: 74,
    signalDbm: -58,
    missionState: 'sar_grid',
    currentWaypointIndex: 1,
    conflictFlag: false,
    geofenceBreachFlag: false,
    bvlosFlag: false,
    sortieCount: 1,
    launchTimeSec: 0,
  }
}

function mount(platformId: string) {
  useDroneStore.setState({
    scenario: scenarioWithSector(platformId),
    drones: [drone()],
    positionHistory: { 'uav-01': TRACK },
  })
  render(<TelemetryPanel />)
  fireEvent.click(screen.getByRole('button', { name: 'READY' }))
  return screen.getByTestId('sector-pod-section')
}

describe('sector POD on the READY tab (WP-6)', () => {
  beforeEach(() => {
    useDroneStore.setState({ elapsedSec: 120 })
  })

  it('shows cumulative POD, sector area and a per-sweep breakdown', () => {
    const section = mount('skydio_x10')

    expect(within(section).getByText('CUMULATIVE POD')).toBeTruthy()
    // A real percentage, not a placeholder.
    expect(section.textContent).toMatch(/CUMULATIVE POD\s*\d+%/)
    expect(within(section).getByText('SECTOR AREA')).toBeTruthy()
    expect(section.textContent).toMatch(/km²/)

    // Per-sector (per-sweep) row for the drone that flew it.
    expect(within(section).getByText('UAV-01')).toBeTruthy()
    expect(section.textContent).toMatch(/km × \d+m W/)

    // The provenance line: POD has to be traceable to its formula to be worth reporting.
    expect(section.textContent).toContain('1.645')
    expect(section.textContent).toContain('Johnson')
  })

  it('reads UNSOURCED, not a percentage, for a platform with unpublished optics', () => {
    const section = mount('freefly_astro_max')

    expect(section.textContent).toContain('UNSOURCED')
    expect(section.textContent).not.toMatch(/CUMULATIVE POD\s*\d+%/)
    expect(section.textContent).toContain('optics not published')
    expect(section.textContent).toContain('Excluded for unpublished optics: Freefly Astro Max')
  })

  it('no longer labels route progress as search coverage', () => {
    mount('skydio_x10')
    const panel = screen.getByTestId('investor-readiness-panel')
    // Route progress is how much of the planned track has been flown. Calling it "coverage"
    // invited it to be read as a detection claim; POD is the detection claim now.
    expect(panel.textContent).toContain('ROUTE PROGRESS')
    expect(panel.textContent).not.toContain('SEARCH COVERAGE')
  })

  it('omits the POD section entirely for a scenario with no search area', () => {
    useDroneStore.setState({
      scenario: { ...ALL_SCENARIOS[0], id: 'no-sector', searchArea: undefined } as ScenarioConfig,
      drones: [drone()],
      positionHistory: { 'uav-01': TRACK },
    })
    render(<TelemetryPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'READY' }))
    expect(screen.queryByTestId('sector-pod-section')).toBeNull()
  })
})
