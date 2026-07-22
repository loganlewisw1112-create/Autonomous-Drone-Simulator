import type { ObservedWeather } from '@/types'
import fortMyers from './fixtures/extreme_fema_fort_myers/weather.json'
import oceanBeach from './fixtures/demo_sar_coastal/weather.json'

// Real observed-weather baselines frozen by tools/fixtures/ (REALISM_ROADMAP WP-0/WP-2).
// Imported statically — committed data, never a runtime fetch (§3, enforced by ESLint). Keyed by
// scenario id; extend this map as `npm run fixtures` produces more `weather.json` fixtures.
// Intentionally NOT applied to the demo_basic onboarding tutorial — its real-day weather can
// exceed the launch-bay gust limit and must stay launchable (see tools/fixtures/scenarios.json).
const OBSERVED: Record<string, ObservedWeather> = {
  extreme_fema_fort_myers: fortMyers,
  demo_sar_coastal: oceanBeach,
}

/** The frozen observed-weather baseline for a scenario, or undefined when none is sourced. */
export function observedWeatherFor(scenarioId: string): ObservedWeather | undefined {
  return OBSERVED[scenarioId]
}
