// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MissionStatusFeed } from '@/components/MissionStatusFeed'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { AGENCY_NAMES_NOTICE, historicalScenarioNote } from '@/scenarios/scenarioNotices'
import { useDroneStore } from '@/store/droneStore'

// Pitch review k5: the no-endorsement notice travels with the brief wherever agency names are
// on screen, and a scenario built on a real disaster says so, respectfully.

const historical = ALL_SCENARIOS.filter((s) => s.historicalCase && s.missionBrief)
const ordinary = ALL_SCENARIOS.find((s) => !s.historicalCase && s.missionBrief)!

describe('scenario notices', () => {
  beforeEach(() => {
    cleanup()
    useDroneStore.getState().resetMission()
  })
  afterEach(() => cleanup())

  it('the brief shows the no-endorsement notice next to the agency names', () => {
    useDroneStore.setState({ scenario: ordinary, events: [], elapsedSec: 0 })
    render(<MissionStatusFeed />)
    expect(screen.getByText(ordinary.missionBrief!.agencies.join(' / '))).toBeTruthy()
    expect(screen.getByTestId('agency-names-notice').textContent).toBe(AGENCY_NAMES_NOTICE)
    expect(AGENCY_NAMES_NOTICE).toMatch(/do not imply endorsement, certification, or operational approval/)
    // An ordinary training scenario is not described as a real event.
    expect(screen.queryByTestId('historical-scenario-note')).toBeNull()
  })

  it('every historical scenario carries a respectful real-event note', () => {
    expect(historical.length).toBeGreaterThan(0)
    for (const scenario of historical) {
      const note = historicalScenarioNote(scenario)!
      expect(note).toContain(scenario.historicalCase!.eventName)
      expect(note).toMatch(/simulated training exercise/)
    }
    useDroneStore.setState({ scenario: historical[0], events: [], elapsedSec: 0 })
    render(<MissionStatusFeed />)
    expect(screen.getByTestId('historical-scenario-note').textContent).toBe(historicalScenarioNote(historical[0]))
  })

  it('returns no note for a scenario without a historical case', () => {
    expect(historicalScenarioNote(ordinary)).toBeNull()
    expect(historicalScenarioNote(null)).toBeNull()
  })
})
