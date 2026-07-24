import { describe, expect, it } from 'vitest'
import {
  ALL_SCENARIOS,
  EXPECTED_CATALOG_COUNT,
  INCIDENT_MISSION_COUNT,
  INCIDENT_SCENARIOS,
  NIST_MISSION_COUNT,
} from '@/scenarios/catalog'
import {
  ALL_INCIDENT_IDS,
  HISTORICAL_SCENARIO_IDS,
  NIST_SCENARIO_IDS,
  TRAINING_SCENARIO_IDS,
} from '@/scenarios/scenarioManifest'

describe('scenario catalog manifest (Phase 5)', () => {
  it('publishes 25 incident missions and 6 NIST skills drills', () => {
    expect(INCIDENT_SCENARIOS).toHaveLength(INCIDENT_MISSION_COUNT)
    expect(INCIDENT_SCENARIOS).toHaveLength(25)
    expect(NIST_SCENARIO_IDS).toHaveLength(NIST_MISSION_COUNT)
    expect(NIST_SCENARIO_IDS).toHaveLength(6)
    expect(ALL_SCENARIOS).toHaveLength(EXPECTED_CATALOG_COUNT)
    expect(ALL_SCENARIOS).toHaveLength(31)
  })

  it('lists every incident id exactly once', () => {
    expect(INCIDENT_SCENARIOS.map((s) => s.id).sort()).toEqual([...ALL_INCIDENT_IDS].sort())
    expect(HISTORICAL_SCENARIO_IDS.every((id) => INCIDENT_SCENARIOS.some((s) => s.id === id))).toBe(true)
    expect(TRAINING_SCENARIO_IDS.every((id) => INCIDENT_SCENARIOS.some((s) => s.id === id))).toBe(true)
  })

  it('never falls back to generic UAS OPERATIONS for authored agency lists', () => {
    for (const scenario of INCIDENT_SCENARIOS) {
      const agencies = scenario.agencies ?? scenario.missionBrief?.agencies ?? []
      expect(agencies.length, scenario.id).toBeGreaterThan(0)
      expect(agencies, scenario.id).not.toEqual(['UAS OPERATIONS'])
    }
  })

  it('carries historicalCase on all ten historical scenarios', () => {
    for (const id of HISTORICAL_SCENARIO_IDS) {
      const scenario = INCIDENT_SCENARIOS.find((s) => s.id === id)
      expect(scenario?.historicalCase?.eventName, id).toBeTruthy()
      expect(scenario?.historicalCase?.sources.length, id).toBeGreaterThan(0)
      expect(scenario?.backtestAnchors?.length, id).toBeGreaterThan(0)
    }
  })
})
