/**
 * Guards the observed-weather fixture map (REALISM_ROADMAP WP-0/WP-2).
 *
 * `observedWeather.ts` is a hand-maintained map from scenario id to a frozen ERA5 baseline. The
 * failure modes it has are all silent: a mistyped key binds real weather to a scenario that does
 * not exist and the scenario it was meant for quietly keeps its invented numbers; and adding a
 * fixture for an onboarding tutorial can close its launch bays and break the one-click demo.
 * Neither shows up as a test failure anywhere else, so they are pinned here.
 */
import { describe, expect, it } from 'vitest'
import { INCIDENT_SCENARIOS } from '@/scenarios/catalog'
import { observedWeatherFor } from '@/scenarios/observedWeather'

// The onboarding tutorials must stay launchable in any weather (tools/fixtures/scenarios.json).
const TUTORIAL_IDS = ['demo_basic', 'demo_sar']

// WP-2's stated acceptance criterion.
const WP2_MINIMUM = 12

const withObserved = INCIDENT_SCENARIOS.filter((s) => observedWeatherFor(s.id) !== undefined)

describe('observed weather fixtures (WP-2)', () => {
  it('clears the ">=12 of 21 scenarios" acceptance bar', () => {
    expect(INCIDENT_SCENARIOS.length).toBe(21)
    expect(withObserved.length).toBeGreaterThanOrEqual(WP2_MINIMUM)
    // Exact, not just the floor: the map is hand-written, and a mistyped scenario id binds the
    // fixture to nothing while its intended scenario silently keeps its invented weather. That
    // would still clear the floor above, so the count is pinned to catch it.
    expect(withObserved.map((s) => s.id).sort()).toEqual([
      'demo_sar_coastal',
      'extreme_atf_oakland_stash',
      'extreme_cal_fire_dixie',
      'extreme_cbp_big_bend_desert_sar',
      'extreme_cbp_eagle_pass',
      'extreme_cbp_rio_grande_longrange',
      'extreme_dhs_port_la_chemical',
      'extreme_fbi_hrt_compound',
      'extreme_fema_fort_myers',
      'extreme_lapd_hollywood_bowl',
      'extreme_lapd_skid_row_welfare',
      'extreme_multiagency_sf_pursuit',
      'extreme_nypd_times_sq_mci',
      'extreme_uscg_cape_cod_sar',
      'extreme_usss_presidential_sf',
    ])
  })

  it('never binds a fixture to the onboarding tutorials, which must stay launchable', () => {
    for (const id of TUTORIAL_IDS) {
      expect(observedWeatherFor(id), id).toBeUndefined()
    }
  })

  it('carries Hurricane Ian’s documented ERA5 peak for Fort Myers', () => {
    const ian = observedWeatherFor('extreme_fema_fort_myers')
    expect(ian).toBeDefined()
    expect(ian!.windKts).toBeCloseTo(59.2, 1)
    expect(ian!.gustKts).toBeCloseTo(110.8, 1)
  })

  it('reports physically coherent values for every fixture', () => {
    for (const scenario of withObserved) {
      const w = observedWeatherFor(scenario.id)!
      expect(w.windKts, scenario.id).toBeGreaterThanOrEqual(0)
      // A gust is by definition at least the sustained wind.
      expect(w.gustKts, scenario.id).toBeGreaterThanOrEqual(w.windKts)
      // Real surface temperatures at US AOs — wide, but excludes unit-conversion mistakes
      // (a °C value leaking through as °F would land far below this floor).
      expect(w.tempF, scenario.id).toBeGreaterThan(-40)
      expect(w.tempF, scenario.id).toBeLessThan(140)
    }
  })

  it('keeps exactly one scenario grounded by its own real weather', () => {
    // Fort Myers/Ian is the deliberate teaching case: the sim refusing to launch into documented
    // hurricane conditions IS the realism. A second grounded scenario is almost always an
    // accidentally-picked date rather than an intentional lesson, and silently removes a
    // scenario from play — so it should force a look rather than pass unnoticed.
    const BAY_CLOSING_GUST_KTS = 30
    const grounded = withObserved
      .filter((s) => observedWeatherFor(s.id)!.gustKts > BAY_CLOSING_GUST_KTS)
      .map((s) => s.id)
    expect(grounded).toEqual(['extreme_fema_fort_myers'])
  })
})
