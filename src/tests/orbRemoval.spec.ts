/**
 * Regression guard for WS4 (decorative orb removal): the 'utm-medical-helo' external
 * traffic track was removed from utmEngine.ts. It must never reappear — at any elapsed
 * time, for any scenario (including the null demo-data fallback).
 */
import { describe, expect, it } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { buildUtmAirspaceState } from '@/sim/demo/utmEngine'

const scenario = ALL_SCENARIOS.find((item) => item.id === 'demo_sar_coastal') ?? ALL_SCENARIOS[0]

describe('utm-medical-helo orb removal', () => {
  it('never generates a utm-medical-helo traffic track, at any elapsed time', () => {
    for (const elapsedSec of [0, 45, 90, 179, 360]) {
      const state = buildUtmAirspaceState({ scenario, drones: [], elapsedSec })
      expect(state.externalTracks.some((track) => track.id === 'utm-medical-helo')).toBe(false)
      expect(state.externalTracks.some((track) => track.label.toLowerCase().includes('medical'))).toBe(false)
    }
  })

  it('still generates external traffic (news-rotor) so UTM overlays stay non-empty', () => {
    const state = buildUtmAirspaceState({ scenario, drones: [], elapsedSec: 0 })
    expect(state.externalTracks.length).toBeGreaterThan(0)
    expect(state.externalTracks.every((track) => track.id !== 'utm-medical-helo')).toBe(true)
  })

  it('holds across every scenario in the catalog, not just the default', () => {
    for (const s of ALL_SCENARIOS) {
      const state = buildUtmAirspaceState({ scenario: s, drones: [], elapsedSec: 30 })
      expect(state.externalTracks.some((track) => track.id === 'utm-medical-helo')).toBe(false)
    }
  })

  it('also holds for the no-scenario (null) demo-data path', () => {
    const state = buildUtmAirspaceState({ scenario: null, drones: [], elapsedSec: 0 })
    expect(state.externalTracks.some((track) => track.id === 'utm-medical-helo')).toBe(false)
    expect(state.externalTracks.length).toBeGreaterThan(0)
  })
})
