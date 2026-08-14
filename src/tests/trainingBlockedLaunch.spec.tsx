// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useDroneStore } from '@/store/droneStore'
import { getScenarioById } from '@/scenarios/registry'
import { assuranceForScenario } from '@/assurance/trainingAssurance'
import { PreflightChecklist } from '@/components/PreflightChecklist'
import type { DroneState, ScenarioConfig, ScenarioVariantConfig } from '@/types'

// Audit F-06 regression suite.
//
// 'training_blocked' previously shared the acknowledge-and-continue affordance with
// 'training_degraded', so an evidence-gated scenario could launch on missing/stale/invalid
// evidence. Blocked must be non-overridable at BOTH the preflight UI and the store launch
// boundary — the store is the one that matters, because classroom mission control and the
// demo driver call beginLaunchSequence() without ever rendering the checklist.

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

describe('training_blocked is not operator-overridable', () => {
  beforeEach(() => {
    useDroneStore.getState().resetMission()
  })

  it('produces a blocked disposition when required exercise evidence is absent', () => {
    // Guards the premise of every other test here: agency_training_exercise requires six
    // evidence kinds, so a scenario claiming that mode with none of them is blocked.
    const assurance = assuranceForScenario(blockedScenario())
    expect(assurance.launchDisposition).toBe('training_blocked')
    expect(assurance.trainingRunAllowed).toBe(false)
    expect(assurance.blockers.length).toBeGreaterThan(0)
  })

  it('refuses beginLaunchSequence at the store boundary even with authorization complete', () => {
    const scenario = blockedScenario()
    parkFleet(scenario)
    useDroneStore.getState().completeAuthorizationTraining('test')
    expect(useDroneStore.getState().isAuthorizationTrainingReady()).toBe(true)

    useDroneStore.getState().beginLaunchSequence()

    expect(useDroneStore.getState().lifecycle).toBe('preflight')
    expect(useDroneStore.getState().launchCommandedSec).toBeNull()
  })

  it('still allows launch for the same scenario once the mode is not evidence-gated', () => {
    // Control case — proves the refusal above is the assurance gate and not some unrelated
    // precondition failing in this fixture.
    const scenario = readyScenario()
    parkFleet(scenario)
    useDroneStore.getState().completeAuthorizationTraining('test')

    useDroneStore.getState().beginLaunchSequence()

    expect(useDroneStore.getState().lifecycle).toBe('running')
  })

  it('keeps preflight continue disabled and offers no acknowledgement escape hatch', async () => {
    const user = userEvent.setup()
    const scenario = blockedScenario()
    parkFleet(scenario)
    useDroneStore.getState().completeAuthorizationTraining('test')
    useDroneStore.getState().setShowPreflight(true)

    render(<PreflightChecklist />)
    await user.click(screen.getByText(/Check All/))

    expect(screen.getByTestId('assurance-blocked-notice')).toBeInTheDocument()
    // The degraded acknowledgement checkbox must not exist at all for a blocked scenario.
    expect(screen.queryByRole('checkbox', { name: /geographic familiarization only/i })).toBeNull()
    expect(screen.getByTestId('preflight-continue')).toBeDisabled()
  })

  it('leaves the degraded acknowledgement path working', async () => {
    const user = userEvent.setup()
    const scenario = degradedScenario()
    parkFleet(scenario)
    useDroneStore.getState().completeAuthorizationTraining('test')
    useDroneStore.getState().setShowPreflight(true)

    render(<PreflightChecklist />)
    await user.click(screen.getByText(/Check All/))

    expect(screen.queryByTestId('assurance-blocked-notice')).toBeNull()
    const acknowledgement = screen.getByRole('checkbox', { name: /geographic familiarization only/i })
    expect(screen.getByTestId('preflight-continue')).toBeDisabled()

    await user.click(acknowledgement)

    expect(screen.getByTestId('preflight-continue')).toBeEnabled()
  })
})

function baseScenario(): ScenarioConfig {
  return getScenarioById('demo_sar_coastal')!.config
}

/** agency_training_exercise with none of its six required evidence kinds supplied. */
function blockedScenario(): ScenarioConfig {
  return { ...baseScenario(), assuranceMode: 'agency_training_exercise', assuranceEvidence: [] }
}

function degradedScenario(): ScenarioConfig {
  return { ...baseScenario(), assuranceMode: 'geographic_familiarization', assuranceEvidence: [] }
}

function readyScenario(): ScenarioConfig {
  return { ...baseScenario(), assuranceMode: 'synthetic_training', assuranceEvidence: [] }
}

function parkFleet(scenario: ScenarioConfig) {
  useDroneStore.setState({
    scenario,
    scenarioVariant: DAY,
    authorizationCompletedSteps: [],
    lifecycle: 'preflight',
    launchCommandedSec: null,
    ui: { ...useDroneStore.getState().ui, isRunning: false },
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
