/**
 * Guards the observed-weather fixture map (REALISM_ROADMAP WP-0/WP-2).
 */
import { describe, expect, it } from 'vitest'
import { INCIDENT_MISSION_COUNT, INCIDENT_SCENARIOS } from '@/scenarios/catalog'
import { observedWeatherFor } from '@/scenarios/observedWeather'

const TUTORIAL_IDS = ['demo_basic', 'demo_sar']
const WP2_MINIMUM = 12

const withObserved = INCIDENT_SCENARIOS.filter((s) => observedWeatherFor(s.id) !== undefined)

describe('observed weather fixtures (WP-2)', () => {
  it('clears the >=12 incident scenarios acceptance bar', () => {
    expect(INCIDENT_SCENARIOS.length).toBe(INCIDENT_MISSION_COUNT)
    expect(withObserved.length).toBeGreaterThanOrEqual(WP2_MINIMUM)
  })

  it('never binds a fixture to the onboarding tutorials, which must stay launchable', () => {
    for (const id of TUTORIAL_IDS) {
      expect(observedWeatherFor(id), id).toBeUndefined()
    }
  })

  it('carries peak-gust weather for the intentional no-launch Marshall Fire lesson', () => {
    const marshall = observedWeatherFor('hist_marshall_fire_2021')
    expect(marshall).toBeDefined()
    expect(marshall!.gustKts).toBeGreaterThan(30)
  })

  it('reports physically coherent values for every fixture', () => {
    for (const scenario of withObserved) {
      const w = observedWeatherFor(scenario.id)!
      expect(w.windKts, scenario.id).toBeGreaterThanOrEqual(0)
      expect(w.gustKts, scenario.id).toBeGreaterThanOrEqual(w.windKts)
      expect(w.tempF, scenario.id).toBeGreaterThan(-40)
      expect(w.tempF, scenario.id).toBeLessThan(140)
    }
  })

  it('grounds the genuine high-wind events by their own real weather', () => {
    // Every AO now carries its own dedicated ERA5 baseline (WP-2 Phase 6 + coverage pass).
    // Grounding must fall out of the real recorded weather, not a proxy artifact: the
    // gust-over-threshold set is whatever the recorded days actually were, not a curated
    // list. Two documented incidents (Hurricane Harvey, the Marshall Fire downslope
    // windstorm) and two representative training days (a Houston spring storm-season day,
    // a windy late-autumn Seattle night) exceed the gust threshold that closes flight ops.
    const BAY_CLOSING_GUST_KTS = 30
    const grounded = withObserved
      .filter((s) => observedWeatherFor(s.id)!.gustKts > BAY_CLOSING_GUST_KTS)
      .map((s) => s.id)
      .sort()
    expect(grounded).toEqual([
      'hist_harvey_houston_2017',
      'hist_marshall_fire_2021',
      'train_flood_corridor',
      'train_night_relay_sar',
    ])
  })
})
