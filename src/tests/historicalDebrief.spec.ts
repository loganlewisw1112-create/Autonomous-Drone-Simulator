import { describe, expect, it } from 'vitest'
import { buildHistoricalDebrief } from '@/scenarios/historicalDebrief'
import { INCIDENT_SCENARIOS } from '@/scenarios/catalog'

describe('historical debrief hooks (Phase 5b)', () => {
  it('builds debrief payload for historical scenarios only', () => {
    const harvey = INCIDENT_SCENARIOS.find((s) => s.id === 'hist_harvey_houston_2017')!
    const debrief = buildHistoricalDebrief(harvey, { progressPercent: 42, total: 71 }, { elapsedSec: 600, thermalContactsFound: 2 })
    expect(debrief?.historicalCase.eventName).toMatch(/Harvey/)
    expect(debrief?.backtestAnchors.length).toBeGreaterThan(0)
    expect(debrief?.discussionPrompts.length).toBeGreaterThanOrEqual(0)
  })

  it('returns null for non-historical training scenarios', () => {
    const basic = INCIDENT_SCENARIOS.find((s) => s.id === 'demo_basic')!
    expect(buildHistoricalDebrief(basic, null, { elapsedSec: 0, thermalContactsFound: 0 })).toBeNull()
  })
})
