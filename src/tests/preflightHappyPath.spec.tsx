// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useDroneStore } from '@/store/droneStore'
import { getScenarioById } from '@/scenarios/registry'
import { PREFLIGHT_CHECKLIST } from '@/sim/mission/preflightChecklist'
import { PreflightChecklist } from '@/components/PreflightChecklist'
import type { DroneState, MissionEvent, ScenarioConfig, ScenarioVariantConfig } from '@/types'

// Audit F-09: the preflight workflow UI had zero direct coverage, so a regression in the
// continue/cancel wiring (the ONLY path from checklist to launch-bay planning in both
// shells) could survive the aggregate coverage gate. trainingBlockedLaunch.spec.tsx owns
// the blocked/degraded dispositions; this file owns the happy path: items + authorization
// complete -> continue enabled -> preflight_complete emitted + launch bay opened, and the
// two dismissal affordances (Cancel button, overlay click) closing WITHOUT emitting.

const DAY: ScenarioVariantConfig = {
  seed: 42,
  timeOfDay: 'day',
  season: 'summer',
  weatherSeverity: 0,
  commsDegradation: 0,
  thermalDensity: 0,
  batteryPressure: 0,
  terrainDifficulty: 0,
}

describe('preflight happy-path workflow', () => {
  beforeEach(() => {
    useDroneStore.getState().resetMission()
  })

  it('enables continue only once items and authorization are complete, then opens the launch bay and emits preflight_complete', async () => {
    const user = userEvent.setup()
    const scenario = readyScenario()
    parkFleet(scenario)
    act(() => useDroneStore.getState().setShowPreflight(true))

    render(<PreflightChecklist />)

    // Gate must hold with nothing confirmed — this is the workflow a regression would break.
    expect(screen.getByTestId('preflight-continue')).toBeDisabled()

    const eventsBefore = useDroneStore.getState().events.length
    await user.click(screen.getByText(/Check All/))
    expect(screen.getByTestId('preflight-continue')).toBeEnabled()

    await user.click(screen.getByTestId('preflight-continue'))

    const state = useDroneStore.getState()
    const completions = newCompletionEvents(state.events, eventsBefore)
    expect(completions).toHaveLength(1)
    // Payload fields are consumed by the chain-of-custody log; assert the load-bearing ones.
    expect(completions[0].droneId).toBe('system')
    expect(completions[0].payload).toMatchObject({
      scenarioId: scenario.id,
      itemsConfirmed: PREFLIGHT_CHECKLIST.length,
      authorizationReady: true,
      simulationOnly: true,
    })
    // Continue hands off to launch-bay planning: preflight closes, launch bay opens.
    expect(state.ui.showPreflight).toBe(false)
    expect(state.ui.showLaunchBay).toBe(true)
  })

  it('cancel closes the modal without emitting preflight_complete or opening the launch bay', async () => {
    const user = userEvent.setup()
    parkFleet(readyScenario())
    act(() => useDroneStore.getState().setShowPreflight(true))

    render(<PreflightChecklist />)
    const eventsBefore = useDroneStore.getState().events.length
    // Even with everything confirmed, Cancel must abandon without a completion record.
    await user.click(screen.getByText(/Check All/))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    const state = useDroneStore.getState()
    expect(state.ui.showPreflight).toBe(false)
    expect(state.ui.showLaunchBay).toBe(false)
    expect(newCompletionEvents(state.events, eventsBefore)).toHaveLength(0)
  })

  it('overlay click dismisses without emitting, and reopening resets per-mission confirmations', async () => {
    const user = userEvent.setup()
    parkFleet(readyScenario())
    act(() => useDroneStore.getState().setShowPreflight(true))

    const { container } = render(<PreflightChecklist />)
    const eventsBefore = useDroneStore.getState().events.length
    await user.click(screen.getByText(/Check All/))

    // fireEvent (not userEvent) so the click target is the overlay itself — a pointer
    // click at the overlay's center would land on the modal and must NOT dismiss.
    fireEvent.click(container.querySelector('.modal-overlay')!)

    let state = useDroneStore.getState()
    expect(state.ui.showPreflight).toBe(false)
    expect(state.ui.showLaunchBay).toBe(false)
    expect(newCompletionEvents(state.events, eventsBefore)).toHaveLength(0)

    // Checklist items are per-mission confirmations: reopening must NOT remember them.
    act(() => useDroneStore.getState().setShowPreflight(true))
    expect(screen.getByTestId('preflight-continue')).toBeDisabled()
    state = useDroneStore.getState()
    expect(state.ui.showLaunchBay).toBe(false)
  })
})

function newCompletionEvents(events: MissionEvent[], since: number): MissionEvent[] {
  return events.slice(since).filter((event) => event.eventType === 'preflight_complete')
}

/** synthetic_training is never evidence-gated, so the disposition is launch-ready. */
function readyScenario(): ScenarioConfig {
  const base = getScenarioById('demo_sar_coastal')!.config
  return { ...base, assuranceMode: 'synthetic_training', assuranceEvidence: [] }
}

function parkFleet(scenario: ScenarioConfig) {
  useDroneStore.setState({
    scenario,
    scenarioVariant: DAY,
    authorizationCompletedSteps: [],
    lifecycle: 'preflight',
    launchCommandedSec: null,
    // resetMission deliberately leaves modal flags alone, so clear them here —
    // the first test opens the launch bay and must not leak that into the next.
    ui: { ...useDroneStore.getState().ui, isRunning: false, showPreflight: false, showLaunchBay: false },
    drones: [parkedDrone('uav-01', scenario)],
    launchPlan: null,
  })
}

function parkedDrone(id: string, scenario: ScenarioConfig): DroneState {
  return {
    id,
    label: id.toUpperCase(),
    color: '#00d4ff',
    position: { ...scenario.startPosition },
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
}
